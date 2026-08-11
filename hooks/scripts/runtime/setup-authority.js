'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  normalizeConfigSemantics,
  normalizeWikiRoot,
  parseConfig,
  resolveConfig,
  resolveConfigWriteTarget,
  resolveHome,
} = require('./config.js');
const { atomicWriteFile, sha256 } = require('./fs-safe.js');
const {
  acquirePathLock,
  assertPathLockOwner,
  releasePathLock,
} = require('./lock.js');

const AUTHORITY_FILE = '.deep-wiki-setup-authority.json';
const RESERVATION_DIRECTORY = '.deep-wiki-setup.reserve';
const AUTHORITY_CONTRACT_VERSION = 1;
const MAX_AUTHORITY_BYTES = 64 * 1024;
const MAX_CANDIDATES = 16;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const SHA_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const OPERATION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER_KEYS = ['token', 'operation', 'pid', 'hostname', 'acquired_at'];
const IDENTITY_KEYS = ['dev', 'ino', 'type', 'birthtime_ns'];
const ABSENT_SEAL_KEYS = ['path', 'state', 'ancestor_path', 'ancestor_identity', 'relative_suffix'];
const PRESENT_CANDIDATE_KEYS = ['path', 'state', 'identity', 'sha256', 'wiki_root'];
const PRESENT_WIKI_KEYS = ['claim_state', 'path', 'root_identity', 'route_created_permit'];
const ABSENT_WIKI_KEYS = [
  'claim_state', 'path', 'ancestor_path', 'ancestor_identity', 'relative_suffix',
  'route_created_permit',
];
const PERMIT_KEYS = ['owner_token', 'operation_id', 'resulting_root_identity'];
const CANDIDATE_PERMIT_KEYS = ['path', 'owner_token', 'operation_id', 'resulting_identity', 'sha256', 'wiki_root'];
const COMMITTED_KEYS = [
  'contract_version', 'generation', 'state', 'wiki_root', 'candidates',
  'candidate_permits', 'requested_wiki_claim', 'evidence_sha256',
];
const PENDING_KEYS = [
  'contract_version', 'generation', 'state', 'wiki_root', 'owner', 'operation_id',
  'selected_target', 'candidates', 'candidate_permits', 'requested_wiki_claim',
  'evidence_sha256',
];
const REBIND_KEYS = [
  'contract_version', 'generation', 'state', 'previous_root', 'wiki_root', 'owner',
  'operation_id', 'selected_target', 'candidates', 'candidate_permits',
  'requested_wiki_claim', 'allowed_route_created', 'evidence_sha256',
];
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

class SetupAuthorityError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SetupAuthorityError';
    this.code = code;
  }
}

function authorityError(code, message, cause) {
  return new SetupAuthorityError(code, message, cause);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function samePath(left, right, platform = process.platform) {
  const api = pathApi(platform);
  const a = api.normalize(left);
  const b = api.normalize(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isNormalizedAbsolute(value, platform = process.platform) {
  const api = pathApi(platform);
  return typeof value === 'string' && !value.includes('\0')
    && api.isAbsolute(value) && api.normalize(value) === value;
}

function realpathNative(fs, pathname) {
  const realpath = fs.realpathSync?.native || fs.realpathSync;
  return path.normalize(realpath.call(fs.realpathSync, pathname));
}

function identityComponent(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function filesystemIdentity(stat, expectedType) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  const nlink = identityComponent(stat?.nlink);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n) return null;
  const type = mode & FILE_TYPE_MASK;
  if (type !== expectedType) return null;
  if (expectedType === REGULAR_FILE_TYPE && (nlink === null || nlink !== 1n)) return null;
  return { dev, ino, type, birthtimeNs };
}

function serializeIdentity(identity) {
  if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'filesystem identity is unavailable');
  return {
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    type: identity.type.toString(10),
    birthtime_ns: identity.birthtimeNs.toString(10),
  };
}

function parseIdentity(value, expectedType) {
  if (!hasExactKeys(value, IDENTITY_KEYS)
      || !IDENTITY_KEYS.every((key) => typeof value[key] === 'string' && /^(?:0|[1-9]\d*)$/.test(value[key]))) {
    return null;
  }
  try {
    const identity = {
      dev: BigInt(value.dev),
      ino: BigInt(value.ino),
      type: BigInt(value.type),
      birthtimeNs: BigInt(value.birthtime_ns),
    };
    if (identity.dev < 0n || identity.ino <= 0n || identity.birthtimeNs < 0n
        || identity.type !== expectedType) return null;
    return identity;
  } catch {
    return null;
  }
}

function identitiesEqual(left, right) {
  return left !== null && right !== null
    && left.dev === right.dev && left.ino === right.ino && left.type === right.type
    && left.birthtimeNs === right.birthtimeNs;
}

function currentIdentity(fs, pathname, expectedType) {
  let stat;
  try { stat = fs.lstatSync(pathname, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'filesystem identity cannot be inspected', cause);
  }
  if (stat.isSymbolicLink()) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'a sealed path became a symlink');
  }
  const identity = filesystemIdentity(stat, expectedType);
  if (!identity) throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'filesystem identity is unavailable');
  return identity;
}

function resolvePhysicalHome(env = process.env, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  let lexical;
  try { lexical = resolveHome(env, platform); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'physical user home cannot be resolved', cause);
  }
  let physical;
  try { physical = realpathNative(fs, lexical); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'physical user home does not exist', cause);
  }
  let stat;
  try { stat = fs.lstatSync(physical, { bigint: true }); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'physical user home cannot be inspected', cause);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'physical user home must be a non-symlink directory');
  }
  const identity = filesystemIdentity(stat, DIRECTORY_TYPE);
  if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'physical user home identity is unavailable');
  return {
    path: physical,
    identity: serializeIdentity(identity),
    reservationPath: path.join(physical, RESERVATION_DIRECTORY),
    authorityPath: path.join(physical, AUTHORITY_FILE),
  };
}

function normalizeAbsolutePath(pathname, platform = process.platform) {
  const api = pathApi(platform);
  if (typeof pathname !== 'string' || !api.isAbsolute(pathname) || pathname.includes('\0')) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'authority path must be absolute');
  }
  return api.normalize(pathname);
}

function sealAbsentPath(pathname, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const api = pathApi(platform);
  const target = normalizeAbsolutePath(pathname, platform);
  let cursor = target;
  while (true) {
    try {
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw authorityError('SETUP_AUTHORITY_INVALID', 'absence container must be a non-symlink directory');
      }
      const identity = filesystemIdentity(stat, DIRECTORY_TYPE);
      if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'absence container identity is unavailable');
      const suffix = api.relative(cursor, target);
      if (!suffix || api.isAbsolute(suffix) || suffix.split(api.sep).includes('..')) {
        throw authorityError('SETUP_AUTHORITY_INVALID', 'absence suffix is invalid');
      }
      return {
        path: target,
        state: 'absent',
        ancestor_path: cursor,
        ancestor_identity: serializeIdentity(identity),
        relative_suffix: api.normalize(suffix),
      };
    } catch (cause) {
      if (cause instanceof SetupAuthorityError) throw cause;
      if (cause.code !== 'ENOENT') {
        throw authorityError('SETUP_AUTHORITY_INVALID', 'absence container cannot be inspected', cause);
      }
      const parent = api.dirname(cursor);
      if (parent === cursor) throw authorityError('SETUP_AUTHORITY_INVALID', 'no existing absence container exists');
      cursor = parent;
    }
  }
}

function assertAbsenceContainer(seal, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const api = pathApi(platform);
  const expected = parseIdentity(seal.ancestor_identity, DIRECTORY_TYPE);
  const current = currentIdentity(fs, seal.ancestor_path, DIRECTORY_TYPE);
  if (!expected || !identitiesEqual(current, expected)) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence container identity changed');
  }
  if (!samePath(api.join(seal.ancestor_path, seal.relative_suffix), seal.path, platform)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'absence seal suffix does not reconstruct its path');
  }
  const segments = seal.relative_suffix.split(api.sep).filter(Boolean);
  let cursor = seal.ancestor_path;
  for (const segment of segments.slice(0, -1)) {
    cursor = api.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); } catch (cause) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence container traversal cannot be proven', cause);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence container traversal changed type');
    }
  }
}

function revalidatePathSeal(seal, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const api = pathApi(platform);
  if (!hasExactKeys(seal, ABSENT_SEAL_KEYS) || seal.state !== 'absent'
      || normalizeAbsolutePath(seal.path, platform) !== seal.path
      || normalizeAbsolutePath(seal.ancestor_path, platform) !== seal.ancestor_path
      || typeof seal.relative_suffix !== 'string' || seal.relative_suffix.length === 0
      || api.isAbsolute(seal.relative_suffix) || seal.relative_suffix.split(api.sep).includes('..')) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'absence seal is malformed');
  }
  if (!parseIdentity(seal.ancestor_identity, DIRECTORY_TYPE)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'absence ancestor identity is malformed');
  }
  const current = currentIdentity(fs, seal.ancestor_path, DIRECTORY_TYPE);
  if (!identitiesEqual(current, parseIdentity(seal.ancestor_identity, DIRECTORY_TYPE))) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence container identity changed');
  }
  if (!samePath(api.join(seal.ancestor_path, seal.relative_suffix), seal.path, platform)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'absence seal suffix does not reconstruct its path');
  }
  const segments = seal.relative_suffix.split(api.sep).filter(Boolean);
  let cursor = seal.ancestor_path;
  for (const segment of segments) {
    cursor = api.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence path acquired a symlink');
      }
    } catch (cause) {
      if (cause instanceof SetupAuthorityError) throw cause;
      if (cause.code === 'ENOENT') return seal;
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'absence path cannot be inspected', cause);
    }
  }
  throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'sealed absent path became present');
}

function candidatePaths(env, home, selectedTarget, platform) {
  const api = pathApi(platform);
  const values = [];
  if (typeof env.DEEP_WIKI_CONFIG === 'string' && env.DEEP_WIKI_CONFIG.trim()) {
    values.push(env.DEEP_WIKI_CONFIG.trim());
  }
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) {
    let codexHome = env.CODEX_HOME.trim();
    if (codexHome === '~' || codexHome.startsWith('~/') || codexHome.startsWith('~\\')) {
      codexHome = codexHome === '~' ? home : api.join(home, codexHome.slice(2));
    }
    if (!api.isAbsolute(codexHome)) throw authorityError('SETUP_AUTHORITY_INVALID', 'CODEX_HOME must be absolute');
    values.push(api.join(codexHome, 'deep-wiki-config.yaml'));
  }
  values.push(api.join(home, '.codex', 'deep-wiki-config.yaml'));
  values.push(api.join(home, '.claude', 'deep-wiki-config.yaml'));
  if (selectedTarget) values.push(selectedTarget);
  const result = [];
  for (const value of values) {
    const normalized = normalizeAbsolutePath(value, platform);
    if (!result.some((entry) => samePath(entry, normalized, platform))) result.push(normalized);
  }
  if (result.length > MAX_CANDIDATES) throw authorityError('SETUP_AUTHORITY_INVALID', 'candidate vector is too large');
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

function sealCandidate(candidate, { env, home, fs, platform }) {
  let stat;
  try { stat = fs.lstatSync(candidate, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return sealAbsentPath(candidate, { fs, platform });
    throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate cannot be inspected', cause);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate must be a regular non-symlink file');
  }
  const identity = filesystemIdentity(stat, REGULAR_FILE_TYPE);
  if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate identity is unavailable or linked');
  let bytes;
  try { bytes = Buffer.from(fs.readFileSync(candidate)); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate cannot be read', cause);
  }
  const after = currentIdentity(fs, candidate, REGULAR_FILE_TYPE);
  if (!identitiesEqual(identity, after)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate identity changed while reading');
  }
  let config;
  try {
    config = normalizeConfigSemantics(parseConfig(utf8Decoder.decode(bytes)), {
      fs, platform, home, env,
    });
  } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'global candidate is invalid', cause);
  }
  return {
    path: candidate,
    state: 'present',
    identity: serializeIdentity(identity),
    sha256: sha256(bytes),
    wiki_root: config.wikiRoot,
  };
}

function sealCandidateVector(env, home, selectedTarget, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  return candidatePaths(env, home, selectedTarget, platform)
    .map((candidate) => sealCandidate(candidate, { env, home, fs, platform }));
}

function sealWikiClaim(wikiRoot, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const normalized = normalizeAbsolutePath(wikiRoot, platform);
  let stat;
  try { stat = fs.lstatSync(normalized, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') {
      const absent = sealAbsentPath(normalized, { fs, platform });
      return {
        claim_state: 'absent',
        path: absent.path,
        ancestor_path: absent.ancestor_path,
        ancestor_identity: absent.ancestor_identity,
        relative_suffix: absent.relative_suffix,
        route_created_permit: null,
      };
    }
    throw authorityError('SETUP_AUTHORITY_INVALID', 'requested wiki cannot be inspected', cause);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'requested wiki must be a non-symlink directory');
  }
  const identity = filesystemIdentity(stat, DIRECTORY_TYPE);
  if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'requested wiki identity is unavailable');
  return {
    claim_state: 'present',
    path: realpathNative(fs, normalized),
    root_identity: serializeIdentity(identity),
    route_created_permit: null,
  };
}

function validateOwner(owner) {
  if (!(hasExactKeys(owner, OWNER_KEYS) && TOKEN_RE.test(owner.token)
    && typeof owner.operation === 'string' && owner.operation.length > 0
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.hostname === 'string' && owner.hostname.length > 0
    && typeof owner.acquired_at === 'string')) return false;
  try { return new Date(owner.acquired_at).toISOString() === owner.acquired_at; }
  catch { return false; }
}

function validatePermit(permit) {
  return permit === null || (hasExactKeys(permit, PERMIT_KEYS)
    && TOKEN_RE.test(permit.owner_token) && OPERATION_ID_RE.test(permit.operation_id)
    && parseIdentity(permit.resulting_root_identity, DIRECTORY_TYPE) !== null);
}

function validateCandidatePermit(permit) {
  return hasExactKeys(permit, CANDIDATE_PERMIT_KEYS)
    && isNormalizedAbsolute(permit.path)
    && TOKEN_RE.test(permit.owner_token) && OPERATION_ID_RE.test(permit.operation_id)
    && parseIdentity(permit.resulting_identity, REGULAR_FILE_TYPE) !== null
    && SHA_RE.test(permit.sha256) && isNormalizedAbsolute(permit.wiki_root);
}

function validateClaim(claim) {
  if (hasExactKeys(claim, PRESENT_WIKI_KEYS) && claim.claim_state === 'present'
      && isNormalizedAbsolute(claim.path)
      && parseIdentity(claim.root_identity, DIRECTORY_TYPE) !== null
      && claim.route_created_permit === null) return true;
  if (!hasExactKeys(claim, ABSENT_WIKI_KEYS) || claim.claim_state !== 'absent'
      || !isNormalizedAbsolute(claim.path)
      || !isNormalizedAbsolute(claim.ancestor_path)
      || typeof claim.relative_suffix !== 'string' || claim.relative_suffix.length === 0
      || parseIdentity(claim.ancestor_identity, DIRECTORY_TYPE) === null
      || !validatePermit(claim.route_created_permit)) return false;
  return true;
}

function validateCandidate(candidate) {
  if (hasExactKeys(candidate, ABSENT_SEAL_KEYS) && candidate.state === 'absent') {
    return isNormalizedAbsolute(candidate.path)
      && isNormalizedAbsolute(candidate.ancestor_path)
      && typeof candidate.relative_suffix === 'string' && candidate.relative_suffix.length > 0
      && parseIdentity(candidate.ancestor_identity, DIRECTORY_TYPE) !== null;
  }
  return hasExactKeys(candidate, PRESENT_CANDIDATE_KEYS) && candidate.state === 'present'
    && isNormalizedAbsolute(candidate.path)
    && parseIdentity(candidate.identity, REGULAR_FILE_TYPE) !== null
    && SHA_RE.test(candidate.sha256)
    && isNormalizedAbsolute(candidate.wiki_root);
}

function authorityEvidence(record) {
  const payload = {
    candidates: record.candidates,
    candidate_permits: record.candidate_permits,
    requested_wiki_claim: record.requested_wiki_claim,
  };
  if (record.state === 'rebind_pending') payload.allowed_route_created = record.allowed_route_created;
  return sha256(Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'));
}

function validateAuthority(value) {
  const expected = value?.state === 'committed' ? COMMITTED_KEYS
    : value?.state === 'pending' ? PENDING_KEYS
      : value?.state === 'rebind_pending' ? REBIND_KEYS : null;
  if (!expected || !hasExactKeys(value, expected)
      || value.contract_version !== AUTHORITY_CONTRACT_VERSION
      || !Number.isSafeInteger(value.generation) || value.generation <= 0
      || !isNormalizedAbsolute(value.wiki_root)
      || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES
      || !value.candidates.every(validateCandidate)
      || value.candidates.some((entry, index) => value.candidates.slice(index + 1)
        .some((other) => samePath(entry.path, other.path)))
      || !Array.isArray(value.candidate_permits) || !value.candidate_permits.every(validateCandidatePermit)
      || !validateClaim(value.requested_wiki_claim)
      || !SHA_RE.test(value.evidence_sha256)
      || authorityEvidence(value) !== value.evidence_sha256) return null;
  if (value.state !== 'committed' && (!validateOwner(value.owner)
      || !OPERATION_ID_RE.test(value.operation_id)
      || !isNormalizedAbsolute(value.selected_target))) return null;
  if (value.state === 'rebind_pending' && (
    !isNormalizedAbsolute(value.previous_root)
      || !Array.isArray(value.allowed_route_created)
      || value.allowed_route_created.some((entry) => !isNormalizedAbsolute(entry)))) return null;
  return value;
}

function scanDuplicateJsonKeys(source) {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1; };
  const string = () => {
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const char = source[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return JSON.parse(source.slice(start, index));
    }
    throw new Error('unterminated JSON string');
  };
  const value = (depth) => {
    if (depth > 128) throw new Error('JSON nesting is too deep');
    whitespace();
    if (source[index] === '{') { object(depth + 1); return; }
    if (source[index] === '[') {
      index += 1; whitespace();
      if (source[index] === ']') { index += 1; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (source[index] === ']') { index += 1; return; }
        if (source[index++] !== ',') throw new Error('malformed JSON array');
      }
    }
    if (source[index] === '"') { string(); return; }
    const match = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error('malformed JSON value');
    index += match[0].length;
  };
  const object = (depth) => {
    index += 1; whitespace();
    const keys = new Set();
    if (source[index] === '}') { index += 1; return; }
    while (true) {
      whitespace();
      if (source[index] !== '"') throw new Error('malformed JSON object');
      const key = string();
      if (keys.has(key)) throw new Error('duplicate JSON key');
      keys.add(key); whitespace();
      if (source[index++] !== ':') throw new Error('malformed JSON object');
      value(depth); whitespace();
      if (source[index] === '}') { index += 1; return; }
      if (source[index++] !== ',') throw new Error('malformed JSON object');
    }
  };
  whitespace(); object(0); whitespace();
  if (index !== source.length) throw new Error('trailing JSON data');
}

function loadSetupAuthority(home, options = {}) {
  const fs = options.fs || nodeFs;
  const file = path.join(home, AUTHORITY_FILE);
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority cannot be inspected', cause);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_AUTHORITY_BYTES)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority must be a bounded regular non-symlink file');
  }
  const identity = filesystemIdentity(before, REGULAR_FILE_TYPE);
  if (!identity) throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority identity is unavailable or linked');
  let bytes;
  try { bytes = Buffer.from(fs.readFileSync(file)); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority cannot be read', cause);
  }
  let after;
  try { after = filesystemIdentity(fs.lstatSync(file, { bigint: true }), REGULAR_FILE_TYPE); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority identity was lost', cause);
  }
  if (!identitiesEqual(identity, after)) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority identity changed while reading');
  }
  let source;
  let value;
  try {
    source = utf8Decoder.decode(bytes);
    scanDuplicateJsonKeys(source);
    value = JSON.parse(source);
  } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority JSON is invalid or ambiguous', cause);
  }
  if (!validateAuthority(value)) throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority record is invalid');
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority record is not canonical JSON');
  }
  return value;
}

function canonicalRecord(record) {
  const value = { ...record };
  value.evidence_sha256 = authorityEvidence(value);
  if (!validateAuthority(value)) throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority publication is invalid');
  return value;
}

function authorityBytes(home, fs) {
  const record = loadSetupAuthority(home, { fs });
  return record === null ? { record: null, bytes: null } : {
    record, bytes: Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'),
  };
}

function publishAuthority({ home, homeIdentity, record, expected, reservationToken, fs = nodeFs }) {
  const file = path.join(home, AUTHORITY_FILE);
  const value = canonicalRecord(record);
  const expectedRecord = expected || null;
  if (expectedRecord && value.generation < expectedRecord.generation) {
    throw authorityError('SETUP_AUTHORITY_INVALID', 'setup authority generation cannot decrease');
  }
  const assertBoundary = () => {
    assertPathLockOwner({ lockPath: path.join(home, RESERVATION_DIRECTORY), token: reservationToken, fs });
    const currentHome = currentIdentity(fs, home, DIRECTORY_TYPE);
    const sealedHome = parseIdentity(homeIdentity, DIRECTORY_TYPE);
    if (!identitiesEqual(currentHome, sealedHome)) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'physical user home identity changed');
    }
    const current = authorityBytes(home, fs);
    if ((expectedRecord === null) !== (current.record === null)
        || (expectedRecord !== null && !current.bytes.equals(Buffer.from(`${JSON.stringify(expectedRecord)}\n`)))) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'setup authority changed outside the reservation');
    }
  };
  assertBoundary();
  atomicWriteFile(file, `${JSON.stringify(value)}\n`, {
    fs,
    createParent: false,
    beforeRename: assertBoundary,
    beforePublish: assertBoundary,
  });
  const loaded = loadSetupAuthority(home, { fs });
  if (JSON.stringify(loaded) !== JSON.stringify(value)) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'published setup authority cannot be revalidated');
  }
  return loaded;
}

function permitForCandidate(record, candidatePath) {
  return record.candidate_permits.find((permit) => samePath(permit.path, candidatePath)) || null;
}

function revalidatePresentCandidate(candidate, fs) {
  const identity = currentIdentity(fs, candidate.path, REGULAR_FILE_TYPE);
  if (!identity || !identitiesEqual(identity, parseIdentity(candidate.identity, REGULAR_FILE_TYPE))) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'sealed global candidate identity changed');
  }
  let bytes;
  try { bytes = Buffer.from(fs.readFileSync(candidate.path)); } catch (cause) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'sealed global candidate cannot be read', cause);
  }
  if (sha256(bytes) !== candidate.sha256) {
    throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'sealed global candidate bytes changed');
  }
}

function revalidateCandidateEvidence(record, options = {}) {
  const fs = options.fs || nodeFs;
  for (const candidate of record.candidates) {
    if (candidate.state === 'present') {
      revalidatePresentCandidate(candidate, fs);
      continue;
    }
    try {
      revalidatePathSeal(candidate, options);
    } catch (error) {
      if (error.code !== 'SETUP_AUTHORITY_RECOVERY_REQUIRED') throw error;
      const permit = permitForCandidate(record, candidate.path);
      if (!permit) throw error;
      assertAbsenceContainer(candidate, options);
      const identity = currentIdentity(fs, candidate.path, REGULAR_FILE_TYPE);
      if (!identity || !identitiesEqual(identity, parseIdentity(permit.resulting_identity, REGULAR_FILE_TYPE))) throw error;
      const bytes = Buffer.from(fs.readFileSync(candidate.path));
      if (sha256(bytes) !== permit.sha256) throw error;
    }
  }
}

function revalidateCandidateUnion(record, env, home, selectedTarget, options = {}) {
  revalidateCandidateEvidence(record, options);
  const current = sealCandidateVector(env, home, selectedTarget, options);
  const additions = [];
  for (const candidate of current) {
    if (record.candidates.some((entry) => samePath(entry.path, candidate.path, options.platform))) continue;
    if (candidate.state === 'present') {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'an unrecorded global candidate became present');
    }
    additions.push(candidate);
  }
  return [...record.candidates, ...additions]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function revalidateRequestedWikiClaim(claim, options = {}) {
  const fs = options.fs || nodeFs;
  if (!validateClaim(claim)) throw authorityError('SETUP_AUTHORITY_INVALID', 'requested-wiki claim is invalid');
  if (claim.claim_state === 'present') {
    const current = currentIdentity(fs, claim.path, DIRECTORY_TYPE);
    if (!current || !identitiesEqual(current, parseIdentity(claim.root_identity, DIRECTORY_TYPE))) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'present-at-claim wiki identity changed or disappeared');
    }
    return { state: 'present', path: claim.path };
  }
  const absentSeal = {
    path: claim.path,
    state: 'absent',
    ancestor_path: claim.ancestor_path,
    ancestor_identity: claim.ancestor_identity,
    relative_suffix: claim.relative_suffix,
  };
  try {
    revalidatePathSeal(absentSeal, options);
    if (claim.route_created_permit !== null) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'route-created wiki disappeared after permit publication');
    }
    return { state: 'absent', path: claim.path };
  } catch (error) {
    if (error.code !== 'SETUP_AUTHORITY_RECOVERY_REQUIRED' || claim.route_created_permit === null) throw error;
    const current = currentIdentity(fs, claim.path, DIRECTORY_TYPE);
    const expected = parseIdentity(claim.route_created_permit.resulting_root_identity, DIRECTORY_TYPE);
    if (!current || !identitiesEqual(current, expected)) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'route-created wiki identity does not match its permit');
    }
    assertAbsenceContainer(absentSeal, options);
    return { state: 'permitted-present', path: claim.path };
  }
}

function resolvedGlobal(env, fs) {
  try { return resolveConfig(env, { fs }); } catch (cause) {
    if (cause.code === 'CONFIG_NOT_FOUND') return null;
    throw cause;
  }
}

function requestedRootDecision(wikiRoot, fs, platform) {
  const claim = sealWikiClaim(wikiRoot, { fs, platform });
  return { claim, root: claim.path };
}

function selectedTargetPreflight({ env, home, configHost, requestedRoot, fs, platform }) {
  if (!configHost) return { target: null, state: null };
  let target;
  try { target = resolveConfigWriteTarget(env, configHost, { fs, platform }); } catch (cause) { throw cause; }
  let stat;
  try { stat = fs.lstatSync(target, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return { target, state: 'absent' };
    throw authorityError('CONFIG_TARGET_CONFLICT', 'selected config target cannot be inspected', cause);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !filesystemIdentity(stat, REGULAR_FILE_TYPE)) {
    throw authorityError('CONFIG_TARGET_CONFLICT', 'selected config target must be a regular non-symlink file');
  }
  let parsed;
  try {
    parsed = normalizeConfigSemantics(parseConfig(fs.readFileSync(target, 'utf8')), {
      fs, platform, home, env,
    });
  } catch (cause) {
    throw authorityError('CONFIG_TARGET_CONFLICT', 'selected config target is invalid', cause);
  }
  if (!samePath(parsed.wikiRoot, requestedRoot, platform)) {
    throw authorityError('CONFIG_TARGET_CONFLICT', 'selected config target names another wiki root');
  }
  return { target, state: 'present' };
}

function setupPreflight(options, physicalHome) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const requested = requestedRootDecision(options.wikiRoot, fs, platform);
  const global = resolvedGlobal(options.env, fs);
  if (global && !samePath(global.config.wikiRoot, requested.root, platform)) {
    throw authorityError('SETUP_AUTHORITY_CONFLICT', 'global configuration names another wiki root');
  }
  const selected = selectedTargetPreflight({
    env: options.env,
    home: physicalHome.path,
    configHost: options.configHost,
    requestedRoot: requested.root,
    fs,
    platform,
  });
  return { requested, global, selected };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function setupConfigText(root, resolved) {
  const lines = [`wiki_root: ${yamlString(root)}`];
  const config = resolved?.config;
  if (config?.autoIngestDefined) {
    lines.push('auto_ingest:');
    lines.push(`  ignore_globs: ${JSON.stringify(config.autoIngest.ignoreGlobs)}`);
    if (config.autoIngest.requireTag !== null) lines.push(`  require_tag: ${yamlString(config.autoIngest.requireTag)}`);
  }
  if (config?.obsidianCli) {
    const obsidian = config.obsidianCli;
    if (obsidian.enabled || obsidian.vaultPath || obsidian.vaultName || obsidian.wikiPrefix) {
      lines.push('obsidian_cli:');
      lines.push(`  available: ${obsidian.enabled ? 'true' : 'false'}`);
      if (obsidian.vaultPath) lines.push(`  vault_path: ${yamlString(obsidian.vaultPath)}`);
      if (obsidian.vaultName) lines.push(`  vault_name: ${yamlString(obsidian.vaultName)}`);
      if (obsidian.wikiPrefix) lines.push(`  wiki_prefix: ${yamlString(obsidian.wikiPrefix)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function newPending({ generation, state = 'pending', previousRoot, root, owner, operationId, selectedTarget, candidates, claim, allowedRouteCreated }) {
  const record = {
    contract_version: AUTHORITY_CONTRACT_VERSION,
    generation,
    state,
    ...(state === 'rebind_pending' ? { previous_root: previousRoot } : {}),
    wiki_root: root,
    owner,
    operation_id: operationId,
    selected_target: selectedTarget || candidates[0].path,
    candidates,
    candidate_permits: [],
    requested_wiki_claim: claim,
    ...(state === 'rebind_pending' ? { allowed_route_created: allowedRouteCreated } : {}),
    evidence_sha256: '0'.repeat(64),
  };
  return canonicalRecord(record);
}

function committedFrom(record, root, candidates) {
  return canonicalRecord({
    contract_version: AUTHORITY_CONTRACT_VERSION,
    generation: record.generation,
    state: 'committed',
    wiki_root: root,
    candidates,
    candidate_permits: record.candidate_permits,
    requested_wiki_claim: record.requested_wiki_claim,
    evidence_sha256: '0'.repeat(64),
  });
}

function normalizeOldRoot(value, options) {
  if (value === undefined || value === null) return null;
  return normalizeWikiRoot(value, options.platform, options.home);
}

function ownerCanResume(record, options) {
  const current = options.owner;
  if (record.owner.hostname !== current.hostname) return false;
  if (record.owner.pid === current.pid) return true;
  let alive = true;
  try { alive = (options.isPidAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }))(record.owner.pid); }
  catch { alive = true; }
  return alive === false;
}

function candidatePermit(record, candidatePath, operationId, owner, fs) {
  const stat = currentIdentity(fs, candidatePath, REGULAR_FILE_TYPE);
  if (!stat) throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'route-created config identity is unavailable');
  const bytes = Buffer.from(fs.readFileSync(candidatePath));
  const parsed = normalizeConfigSemantics(parseConfig(utf8Decoder.decode(bytes)), { fs });
  return {
    path: candidatePath,
    owner_token: owner.token,
    operation_id: operationId,
    resulting_identity: serializeIdentity(stat),
    sha256: sha256(bytes),
    wiki_root: parsed.wikiRoot,
  };
}

function coordinateSetup(options = {}, actions = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = resolvePhysicalHome(env, { fs, platform });
  const authorityEnv = {
    ...env,
    HOME: home.path,
    ...(platform === 'win32' ? { USERPROFILE: home.path } : {}),
  };
  const normalizedOptions = { ...options, fs, platform, env: authorityEnv };
  setupPreflight(normalizedOptions, home);
  if (typeof options.faultInjector === 'function') options.faultInjector('before-setup-reservation');
  const owner = acquirePathLock({
    lockPath: home.reservationPath,
    operation: 'setup-authority',
    fs,
    now: options.now,
    hostname: options.hostname,
    pid: options.pid,
    isPidAlive: options.isPidAlive,
  });
  let primaryError;
  let output;
  try {
    let preflight = setupPreflight(normalizedOptions, home);
    let authority = loadSetupAuthority(home.path, { fs });
    const oldRoot = normalizeOldRoot(options.rebindAuthorityFrom, {
      platform, home: home.path,
    });
    const requestedRoot = preflight.requested.root;
    if (authority === null) {
      if (oldRoot !== null) throw authorityError('SETUP_AUTHORITY_CONFLICT', 'rebind requires committed authority');
      const candidates = sealCandidateVector(authorityEnv, home.path, preflight.selected.target, { fs, platform });
      authority = publishAuthority({
        home: home.path,
        homeIdentity: home.identity,
        expected: null,
        reservationToken: owner.token,
        fs,
        record: newPending({
          generation: 1,
          root: requestedRoot,
          owner,
          operationId: options.operationId,
          selectedTarget: preflight.selected.target,
          candidates,
          claim: preflight.requested.claim,
        }),
      });
      if (typeof options.faultInjector === 'function') options.faultInjector('after-authority-pending');
    } else if (authority.state === 'committed') {
      if (samePath(authority.wiki_root, requestedRoot, platform)) {
        if (oldRoot !== null) throw authorityError('SETUP_AUTHORITY_CONFLICT', 'same-root setup is not a rebind');
        revalidateRequestedWikiClaim(authority.requested_wiki_claim, { fs, platform });
        const union = revalidateCandidateUnion(
          authority, authorityEnv, home.path, preflight.selected.target, { fs, platform },
        );
        if (union.length !== authority.candidates.length) {
          authority = publishAuthority({
            home: home.path,
            homeIdentity: home.identity,
            expected: authority,
            reservationToken: owner.token,
            fs,
            record: canonicalRecord({
              ...authority,
              generation: authority.generation + 1,
              candidates: union,
              evidence_sha256: '0'.repeat(64),
            }),
          });
        }
      } else {
        if (oldRoot === null || !samePath(oldRoot, authority.wiki_root, platform)) {
          throw authorityError('SETUP_AUTHORITY_CONFLICT', 'requested root disagrees with committed setup authority');
        }
        try {
          fs.lstatSync(authority.wiki_root);
          throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'old wiki must be absent before rebind');
        } catch (cause) {
          if (cause instanceof SetupAuthorityError) throw cause;
          if (cause.code !== 'ENOENT') throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'old wiki cannot be inspected', cause);
        }
        const candidates = sealCandidateVector(authorityEnv, home.path, preflight.selected.target, { fs, platform });
        if (candidates.some((candidate) => candidate.state === 'present'
            && !samePath(candidate.wiki_root, requestedRoot, platform))) {
          throw authorityError('SETUP_AUTHORITY_CONFLICT', 'a rebind candidate does not name the new root');
        }
        const allowedRouteCreated = [preflight.requested.claim, ...candidates]
          .filter((entry) => entry.state === 'absent' || entry.claim_state === 'absent')
          .map((entry) => entry.path);
        authority = publishAuthority({
          home: home.path,
          homeIdentity: home.identity,
          expected: authority,
          reservationToken: owner.token,
          fs,
          record: newPending({
            generation: authority.generation + 1,
            state: 'rebind_pending',
            previousRoot: authority.wiki_root,
            root: requestedRoot,
            owner,
            operationId: options.operationId,
            selectedTarget: preflight.selected.target,
            candidates,
            claim: preflight.requested.claim,
            allowedRouteCreated,
          }),
        });
        if (typeof options.faultInjector === 'function') options.faultInjector('after-rebind-pending');
      }
    } else {
      if (!samePath(authority.wiki_root, requestedRoot, platform)) {
        throw authorityError('SETUP_AUTHORITY_CONFLICT', 'pending setup authority names another root');
      }
      if (authority.state === 'rebind_pending') {
        if (oldRoot === null || !samePath(oldRoot, authority.previous_root, platform)) {
          throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'rebind_pending requires the exact explicit transition');
        }
      } else if (oldRoot !== null) {
        throw authorityError('SETUP_AUTHORITY_CONFLICT', 'first-install pending authority is not a rebind');
      }
      if (!ownerCanResume(authority, { owner, isPidAlive: options.isPidAlive })) {
        throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'pending setup owner is live, foreign, or ambiguous');
      }
      const union = revalidateCandidateUnion(
        authority, authorityEnv, home.path, preflight.selected.target, { fs, platform },
      );
      revalidateRequestedWikiClaim(authority.requested_wiki_claim, { fs, platform });
      if (authority.state === 'rebind_pending'
          && !samePath(preflight.selected.target, authority.selected_target, platform)) {
        throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'rebind_pending selected target changed');
      }
      if (authority.state === 'pending' && union.length !== authority.candidates.length) {
        authority = publishAuthority({
          home: home.path,
          homeIdentity: home.identity,
          expected: authority,
          reservationToken: owner.token,
          fs,
          record: canonicalRecord({
            ...authority,
            candidates: union,
            evidence_sha256: '0'.repeat(64),
          }),
        });
      }
      if (authority.owner.token !== owner.token) {
        authority = publishAuthority({
          home: home.path,
          homeIdentity: home.identity,
          expected: authority,
          reservationToken: owner.token,
          fs,
          record: canonicalRecord({ ...authority, owner, evidence_sha256: '0'.repeat(64) }),
        });
      }
    }

    revalidateRequestedWikiClaim(authority.requested_wiki_claim, { fs, platform });
    const onWikiEstablished = ({ physicalRoot }) => {
      if (authority.requested_wiki_claim.claim_state !== 'absent'
          || authority.requested_wiki_claim.route_created_permit !== null) return;
      const identity = currentIdentity(fs, physicalRoot, DIRECTORY_TYPE);
      if (!identity || !samePath(physicalRoot, authority.wiki_root, platform)) {
        throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'established wiki does not match the requested claim');
      }
      authority = publishAuthority({
        home: home.path,
        homeIdentity: home.identity,
        expected: authority,
        reservationToken: owner.token,
        fs,
        record: canonicalRecord({
          ...authority,
          requested_wiki_claim: {
            ...authority.requested_wiki_claim,
            route_created_permit: {
              owner_token: owner.token,
              operation_id: authority.operation_id,
              resulting_root_identity: serializeIdentity(identity),
            },
          },
          evidence_sha256: '0'.repeat(64),
        }),
      });
      if (typeof options.faultInjector === 'function') options.faultInjector('after-route-created-permit');
    };
    const result = actions.establishWiki({
      ...options,
      wikiRoot: requestedRoot,
      operationId: authority.operation_id || options.operationId,
      onWikiEstablished,
    });
    revalidateRequestedWikiClaim(authority.requested_wiki_claim, { fs, platform });

    preflight = setupPreflight(normalizedOptions, home);
    let config = null;
    if (preflight.selected.target) {
      if (preflight.selected.state === 'present') {
        config = { path: preflight.selected.target, status: 'alias' };
      } else {
        config = resolveConfigWriteTarget(authorityEnv, options.configHost, {
          fs,
          platform,
          desiredConfigText: setupConfigText(requestedRoot, preflight.global),
          replaceConfig: options.replaceConfig === true,
        });
        const permit = candidatePermit(authority, config.path, authority.operation_id, owner, fs);
        authority = publishAuthority({
          home: home.path,
          homeIdentity: home.identity,
          expected: authority,
          reservationToken: owner.token,
          fs,
          record: canonicalRecord({
            ...authority,
            candidate_permits: [
              ...authority.candidate_permits.filter((entry) => !samePath(entry.path, permit.path, platform)),
              permit,
            ],
            evidence_sha256: '0'.repeat(64),
          }),
        });
        if (typeof options.faultInjector === 'function') options.faultInjector('after-candidate-permit');
      }
    }
    const postGlobal = resolvedGlobal(authorityEnv, fs);
    if (options.configHost && (!postGlobal || !samePath(postGlobal.config.wikiRoot, requestedRoot, platform))) {
      throw authorityError('SETUP_AUTHORITY_RECOVERY_REQUIRED', 'post-publication global resolution did not converge');
    }
    revalidateRequestedWikiClaim(authority.requested_wiki_claim, { fs, platform });
    revalidateCandidateEvidence(authority, { fs, platform });
    const committedCandidates = sealCandidateVector(authorityEnv, home.path, preflight.selected.target, { fs, platform });
    authority = publishAuthority({
      home: home.path,
      homeIdentity: home.identity,
      expected: authority,
      reservationToken: owner.token,
      fs,
      record: committedFrom(authority, realpathNative(fs, requestedRoot), committedCandidates),
    });
    output = { result, config, authority };
  } catch (error) {
    primaryError = error;
  }
  try {
    assertPathLockOwner({ lockPath: home.reservationPath, token: owner.token, fs });
    releasePathLock({ lockPath: home.reservationPath, token: owner.token, fs });
  } catch (releaseError) {
    if (primaryError) primaryError.release_error = releaseError;
    else primaryError = releaseError;
  }
  if (primaryError) throw primaryError;
  return output;
}

module.exports = {
  AUTHORITY_CONTRACT_VERSION,
  AUTHORITY_FILE,
  MAX_AUTHORITY_BYTES,
  RESERVATION_DIRECTORY,
  SetupAuthorityError,
  coordinateSetup,
  loadSetupAuthority,
  publishAuthority,
  resolvePhysicalHome,
  revalidatePathSeal,
  revalidateRequestedWikiClaim,
  sealAbsentPath,
  sealCandidateVector,
};
