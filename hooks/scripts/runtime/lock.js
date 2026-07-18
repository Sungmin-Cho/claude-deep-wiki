'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { atomicWriteFile } = require('./fs-safe.js');

const TOKEN_RE = /^[a-f0-9]{32,}$/;
const OWNER_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_KEYS = ['token', 'operation', 'pid', 'hostname', 'acquired_at'];
const MAX_RESERVATION_ATTEMPTS = 16;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const RESTORE_STATE_FILE = 'restore.json';
const TRANSITION_INTENT_FILE = 'transition.json';
const RESTORE_STATE_KEYS = [
  'contract_version', 'kind', 'reservation_name', 'complete_name',
  'seized_identity', 'canonical_identity', 'entries',
];
const RESTORE_ENTRY_KEYS = ['name', 'identity'];
const SERIALIZED_IDENTITY_KEYS = ['dev', 'ino', 'type'];
const TRANSITION_INTENT_KEYS = [
  'contract_version', 'kind', 'purpose', 'reservation_name',
  'reservation_identity', 'seized_identity', 'pid', 'hostname',
];
const activeSeizures = new Map();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

class LockError extends Error {
  constructor(code, message, owner, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LockError';
    this.code = code;
    if (owner !== undefined) this.owner = owner;
  }
}

function paths(wikiRoot) {
  if (typeof wikiRoot !== 'string' || !path.isAbsolute(wikiRoot)) throw new LockError('LOCK_INVALID', 'wikiRoot must be absolute');
  const meta = path.join(wikiRoot, '.wiki-meta');
  const lockDir = path.join(meta, '.wiki-lock');
  return { meta, lockDir, ownerPath: path.join(lockDir, 'owner.json') };
}

function identityComponent(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function filesystemIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  if (dev === null || ino === null || mode === null || dev < 0n || ino <= 0n) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK };
}

function directoryIdentity(stat) {
  const identity = filesystemIdentity(stat);
  return identity?.type === DIRECTORY_TYPE ? identity : null;
}

function readDirectoryIdentity(fs, directory) {
  try {
    return directoryIdentity(fs.lstatSync(directory, { bigint: true }));
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(fs, directory, expected) {
  const current = readDirectoryIdentity(fs, directory);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino
    && current.type === expected.type;
}

function assertDirectoryIdentity(fs, directory, expected) {
  if (!sameDirectoryIdentity(fs, directory, expected)) {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'lock directory ownership identity changed');
  }
}

function readFilesystemIdentity(fs, pathname) {
  try {
    return filesystemIdentity(fs.lstatSync(pathname, { bigint: true }));
  } catch {
    return null;
  }
}

function sameFilesystemIdentity(fs, pathname, expected) {
  const current = readFilesystemIdentity(fs, pathname);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino
    && current.type === expected.type;
}

function assertFilesystemIdentity(fs, pathname, expected) {
  if (!sameFilesystemIdentity(fs, pathname, expected)) {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'lock quarantine entry ownership identity changed');
  }
}

function pathIsMissing(fs, pathname) {
  try {
    fs.lstatSync(pathname);
    return false;
  } catch (cause) {
    if (cause.code === 'ENOENT') return true;
    throw cause;
  }
}

function removeOwnedDirectory(fs, directory, expected) {
  assertDirectoryIdentity(fs, directory, expected);
  const entries = fs.readdirSync(directory).sort();
  for (const entry of entries) {
    assertDirectoryIdentity(fs, directory, expected);
    const pathname = path.join(directory, entry);
    const identity = readFilesystemIdentity(fs, pathname);
    if (!identity) throw new LockError('LOCK_FILESYSTEM', 'lock quarantine entry identity is unavailable');
    if (identity.type === DIRECTORY_TYPE) {
      removeOwnedDirectory(fs, pathname, identity);
    } else {
      assertDirectoryIdentity(fs, directory, expected);
      assertFilesystemIdentity(fs, pathname, identity);
      fs.unlinkSync(pathname);
    }
  }
  assertDirectoryIdentity(fs, directory, expected);
  fs.rmdirSync(directory);
}

function removeDirectoryIfOwned(fs, directory, expected) {
  if (!sameDirectoryIdentity(fs, directory, expected)) return false;
  removeOwnedDirectory(fs, directory, expected);
  return true;
}

function isCanonicalOwnerTimestamp(value) {
  if (typeof value !== 'string' || !OWNER_TIMESTAMP_RE.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

function isOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== OWNER_KEYS.length || OWNER_KEYS.some((key) => !Object.hasOwn(value, key))) return false;
  return TOKEN_RE.test(value.token)
    && typeof value.operation === 'string' && value.operation.length > 0
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.hostname === 'string' && value.hostname.length > 0
    && isCanonicalOwnerTimestamp(value.acquired_at);
}

function readOwner(ownerPath, fs = nodeFs) {
  return readOwnerRecord(ownerPath, fs)?.owner || null;
}

function readOwnerRecord(ownerPath, fs = nodeFs) {
  try {
    const bytes = Buffer.from(fs.readFileSync(ownerPath));
    const value = JSON.parse(utf8Decoder.decode(bytes));
    if (!isOwner(value)) return null;
    const canonicalBytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (!bytes.equals(canonicalBytes)) return null;
    return {
      owner: value,
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  }
}

function sameOwnerRecord(actual, expected) {
  return actual !== null
    && actual.sha256 === expected.sha256
    && actual.bytes.equals(expected.bytes)
    && OWNER_KEYS.every((key) => actual.owner[key] === expected.owner[key]);
}

function readPhysicalPath(fs, pathname) {
  try {
    return path.normalize(fs.realpathSync(pathname));
  } catch {
    return null;
  }
}

function samePhysicalPath(actual, expected) {
  if (actual === null || expected === null) return false;
  return process.platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

function lockTokenError(owner, cause) {
  return new LockError('LOCK_TOKEN_MISMATCH', 'lock token mismatch', owner, cause);
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function serializeIdentity(identity) {
  return {
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    type: identity.type.toString(10),
  };
}

function deserializeIdentity(value) {
  if (!hasExactKeys(value, SERIALIZED_IDENTITY_KEYS)) return null;
  if (![value.dev, value.ino, value.type].every((part) => typeof part === 'string' && /^(?:0|[1-9]\d*)$/.test(part))) {
    return null;
  }
  try {
    const identity = { dev: BigInt(value.dev), ino: BigInt(value.ino), type: BigInt(value.type) };
    if (identity.dev < 0n || identity.ino <= 0n) return null;
    return identity;
  } catch {
    return null;
  }
}

function restoreCompleteName(seizure) {
  const identity = seizure.reservationIdentity;
  const suffix = path.basename(seizure.reservation).slice('.wiki-lock.'.length);
  return `.wiki-lock.restore-complete.${identity.dev.toString(16)}.${identity.ino.toString(16)}.${suffix}`;
}

function parseRestoreCompleteIdentity(name) {
  const match = name.match(/^\.wiki-lock\.restore-complete\.([a-f0-9]+)\.([a-f0-9]+)\./);
  if (!match) return null;
  try {
    return { dev: BigInt(`0x${match[1]}`), ino: BigInt(`0x${match[2]}`), type: DIRECTORY_TYPE };
  } catch {
    return null;
  }
}

function validEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('\0') && path.basename(name) === name;
}

function validateRestoreState(value, reservationName) {
  if (!hasExactKeys(value, RESTORE_STATE_KEYS)
      || value.contract_version !== 1 || value.kind !== 'lock-mismatch-restore'
      || typeof value.reservation_name !== 'string'
      || typeof value.complete_name !== 'string'
      || path.basename(value.reservation_name) !== value.reservation_name
      || path.basename(value.complete_name) !== value.complete_name
      || !/^\.wiki-lock\.(?:release|recovery)\.\d+\.[a-f0-9]{32}$/.test(value.reservation_name)
      || !value.complete_name.startsWith('.wiki-lock.restore-complete.')
      || !Array.isArray(value.entries)) return null;
  if (reservationName !== value.reservation_name && reservationName !== value.complete_name) return null;
  const seizedIdentity = deserializeIdentity(value.seized_identity);
  const canonicalIdentity = value.canonical_identity === null
    ? null : deserializeIdentity(value.canonical_identity);
  if (!seizedIdentity || seizedIdentity.type !== DIRECTORY_TYPE
      || (canonicalIdentity && canonicalIdentity.type !== DIRECTORY_TYPE)) return null;
  const seen = new Set();
  const entries = [];
  for (const entry of value.entries) {
    if (!hasExactKeys(entry, RESTORE_ENTRY_KEYS) || !validEntryName(entry.name) || seen.has(entry.name)) return null;
    const identity = deserializeIdentity(entry.identity);
    if (!identity) return null;
    seen.add(entry.name);
    entries.push({ name: entry.name, identity });
  }
  if (entries.map(({ name }) => name).join('\0') !== [...seen].sort().join('\0')) return null;
  return { ...value, seizedIdentity, canonicalIdentity, entries };
}

function validateTransitionIntent(value, reservationName) {
  if (!hasExactKeys(value, TRANSITION_INTENT_KEYS)
      || value.contract_version !== 1 || value.kind !== 'lock-seizure-transition'
      || (value.purpose !== 'release' && value.purpose !== 'recovery')
      || typeof value.reservation_name !== 'string'
      || !Number.isInteger(value.pid) || value.pid <= 0
      || typeof value.hostname !== 'string' || value.hostname.length === 0) return null;
  const nameMatch = value.reservation_name.match(
    /^\.wiki-lock\.(release|recovery)\.(\d+)\.[a-f0-9]{32}$/,
  );
  if (!nameMatch || value.reservation_name !== reservationName
      || nameMatch[1] !== value.purpose || nameMatch[2] !== String(value.pid)) return null;
  const reservationIdentity = deserializeIdentity(value.reservation_identity);
  const seizedIdentity = deserializeIdentity(value.seized_identity);
  if (!reservationIdentity || reservationIdentity.type !== DIRECTORY_TYPE
      || !seizedIdentity || seizedIdentity.type !== DIRECTORY_TYPE) return null;
  return { ...value, reservationIdentity, seizedIdentity };
}

function readTransitionIntent(fs, reservation) {
  const intentPath = path.join(reservation, TRANSITION_INTENT_FILE);
  const intentIdentity = readFilesystemIdentity(fs, intentPath);
  if (!intentIdentity) {
    if (pathIsMissing(fs, intentPath)) return null;
    throw new LockError('LOCK_FILESYSTEM', 'lock transition intent identity is unavailable');
  }
  if (intentIdentity.type !== REGULAR_FILE_TYPE) {
    throw new LockError('LOCK_FILESYSTEM', 'lock transition intent is not a regular file');
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new LockError('LOCK_FILESYSTEM', 'lock transition intent is unreadable', undefined, cause);
  }
  if (!sameFilesystemIdentity(fs, intentPath, intentIdentity)) {
    if (pathIsMissing(fs, intentPath)) return null;
    throw new LockError('LOCK_FILESYSTEM', 'lock transition intent identity changed');
  }
  const intent = validateTransitionIntent(value, path.basename(reservation));
  if (!intent) throw new LockError('LOCK_FILESYSTEM', 'lock transition intent is malformed');
  if (!sameDirectoryIdentity(fs, reservation, intent.reservationIdentity)
      && !pathIsMissing(fs, reservation)) {
    throw new LockError('LOCK_FILESYSTEM', 'lock transition reservation identity is inconsistent');
  }
  return { ...intent, intentPath, intentIdentity };
}

function publishTransitionIntent({ fs, lockDir, seizure, purpose, seizedIdentity }) {
  const intentPath = path.join(seizure.reservation, TRANSITION_INTENT_FILE);
  const value = {
    contract_version: 1,
    kind: 'lock-seizure-transition',
    purpose,
    reservation_name: path.basename(seizure.reservation),
    reservation_identity: serializeIdentity(seizure.reservationIdentity),
    seized_identity: serializeIdentity(seizedIdentity),
    pid: process.pid,
    hostname: os.hostname(),
  };
  const assertIntentOwnership = () => {
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    assertDirectoryIdentity(fs, lockDir, seizedIdentity);
  };
  assertIntentOwnership();
  atomicWriteFile(intentPath, `${JSON.stringify(value)}\n`, {
    fs,
    createParent: false,
    beforeRename: assertIntentOwnership,
    beforePublish: assertIntentOwnership,
  });
  assertIntentOwnership();
  const intentIdentity = readFilesystemIdentity(fs, intentPath);
  if (!intentIdentity || intentIdentity.type !== REGULAR_FILE_TYPE) {
    throw new LockError('LOCK_FILESYSTEM', 'published lock transition intent identity is unavailable');
  }
  return { intentPath, intentIdentity };
}

function removeTransitionIntentIfOwned(fs, seizure, intentIdentity) {
  const intentPath = path.join(seizure.reservation, TRANSITION_INTENT_FILE);
  if (pathIsMissing(fs, intentPath)) return true;
  if (!intentIdentity
      || !sameDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity)
      || !sameFilesystemIdentity(fs, intentPath, intentIdentity)) return false;
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  assertFilesystemIdentity(fs, intentPath, intentIdentity);
  fs.unlinkSync(intentPath);
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  return true;
}

function retireActiveSeizure(fs, seizure) {
  activeSeizures.delete(seizure.reservation);
  removeTransitionIntentIfOwned(fs, seizure, seizure.transitionIntentIdentity);
}

function transitionIntentMatches(fs, reservation, seized, intent) {
  return sameDirectoryIdentity(fs, reservation, intent.reservationIdentity)
    && sameDirectoryIdentity(fs, seized, intent.seizedIdentity);
}

function transitionIntentIsLive(intent) {
  return intent.hostname === os.hostname() && defaultIsPidAlive(intent.pid);
}

function identitiesMatch(actual, expected) {
  return actual !== null && expected !== null
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.type === expected.type;
}

function observeLiveTransition(fs, reservation, seized, intent, reservationIdentity, seizedIdentity) {
  if (!identitiesMatch(reservationIdentity, intent.reservationIdentity)
      || !identitiesMatch(seizedIdentity, intent.seizedIdentity)) return 'inconsistent';
  if (!transitionIntentIsLive(intent)) return 'inactive';
  const currentReservationIdentity = readDirectoryIdentity(fs, reservation);
  if (!identitiesMatch(currentReservationIdentity, intent.reservationIdentity)) return 'inconsistent';
  const currentSeizedIdentity = readDirectoryIdentity(fs, seized);
  if (identitiesMatch(currentSeizedIdentity, intent.seizedIdentity)) return 'active';
  if (currentSeizedIdentity !== null) return 'inconsistent';
  try {
    return pathIsMissing(fs, seized) ? 'completing' : 'inconsistent';
  } catch {
    return 'inconsistent';
  }
}

function writeRestoreState({ fs, seizure, state, canonicalIdentity }) {
  const statePath = path.join(seizure.reservation, RESTORE_STATE_FILE);
  const assertStateOwnership = () => {
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    if (!pathIsMissing(fs, seizure.seized)) {
      assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
    }
    if (canonicalIdentity) assertDirectoryIdentity(fs, seizure.lockDir, canonicalIdentity);
  };
  assertStateOwnership();
  atomicWriteFile(statePath, `${JSON.stringify(state)}\n`, {
    fs,
    createParent: false,
    beforeRename: assertStateOwnership,
    beforePublish: assertStateOwnership,
  });
  assertStateOwnership();
}

function prepareRestoreState({ fs, lockDir, seizure }) {
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
  const entries = fs.readdirSync(seizure.seized).sort().map((name) => {
    if (!validEntryName(name)) throw new LockError('LOCK_FILESYSTEM', 'lock restore entry name is invalid');
    const identity = readFilesystemIdentity(fs, path.join(seizure.seized, name));
    if (!identity) throw new LockError('LOCK_FILESYSTEM', 'lock restore entry identity is unavailable');
    return { name, identity: serializeIdentity(identity) };
  });
  const state = {
    contract_version: 1,
    kind: 'lock-mismatch-restore',
    reservation_name: path.basename(seizure.reservation),
    complete_name: restoreCompleteName(seizure),
    seized_identity: serializeIdentity(seizure.seizedIdentity),
    canonical_identity: null,
    entries,
  };
  writeRestoreState({ fs, seizure: { ...seizure, lockDir }, state, canonicalIdentity: null });
  return validateRestoreState(state, state.reservation_name);
}

function readRestoreState(fs, reservation) {
  const statePath = path.join(reservation, RESTORE_STATE_FILE);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new LockError('LOCK_FILESYSTEM', 'lock restore state is unreadable', undefined, cause);
  }
  const state = validateRestoreState(value, path.basename(reservation));
  if (!state) throw new LockError('LOCK_FILESYSTEM', 'lock restore state is malformed');
  return state;
}

function canonicalDirectoryForRestore({ fs, lockDir, seizure, state }) {
  let identity = state.canonicalIdentity;
  if (identity) {
    assertDirectoryIdentity(fs, lockDir, identity);
    return { state, identity };
  }
  try {
    fs.mkdirSync(lockDir);
    identity = readDirectoryIdentity(fs, lockDir);
    if (!identity) throw new LockError('LOCK_TOKEN_MISMATCH', 'restored lock directory identity is unavailable');
  } catch (cause) {
    throw lockTokenError(
      cause.code === 'EEXIST' ? readOwner(path.join(lockDir, 'owner.json'), fs) : null,
      cause,
    );
  }
  const next = {
    contract_version: state.contract_version,
    kind: state.kind,
    reservation_name: state.reservation_name,
    complete_name: state.complete_name,
    seized_identity: state.seized_identity,
    canonical_identity: serializeIdentity(identity),
    entries: state.entries.map(({ name, identity: entryIdentity }) => ({
      name,
      identity: entryIdentity.dev === undefined ? entryIdentity : serializeIdentity(entryIdentity),
    })),
  };
  writeRestoreState({ fs, seizure: { ...seizure, lockDir }, state: next, canonicalIdentity: identity });
  return { state: validateRestoreState(next, next.reservation_name), identity };
}

function finishRestoreReservation({ fs, meta, seizure, state, restoredIdentity }) {
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  assertDirectoryIdentity(fs, seizure.lockDir, restoredIdentity);
  const complete = path.join(meta, state.complete_name);
  if (!pathIsMissing(fs, complete)) throw lockTokenError(readOwner(path.join(seizure.lockDir, 'owner.json'), fs));
  fs.renameSync(seizure.reservation, complete);
  assertDirectoryIdentity(fs, complete, seizure.reservationIdentity);
  assertDirectoryIdentity(fs, seizure.lockDir, restoredIdentity);
  const names = fs.readdirSync(complete).sort();
  if (names.length !== 1 || names[0] !== RESTORE_STATE_FILE) {
    throw new LockError('LOCK_FILESYSTEM', 'completed lock restore reservation contains foreign entries');
  }
  const statePath = path.join(complete, RESTORE_STATE_FILE);
  const stateIdentity = readFilesystemIdentity(fs, statePath);
  if (!stateIdentity) throw new LockError('LOCK_FILESYSTEM', 'completed lock restore state identity is unavailable');
  assertDirectoryIdentity(fs, complete, seizure.reservationIdentity);
  assertFilesystemIdentity(fs, statePath, stateIdentity);
  fs.unlinkSync(statePath);
  assertDirectoryIdentity(fs, complete, seizure.reservationIdentity);
  fs.rmdirSync(complete);
}

function continueRestoreState({ fs, meta, lockDir, seizure, state }) {
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  const canonical = canonicalDirectoryForRestore({
    fs, lockDir, seizure, state,
  });
  state = canonical.state;
  const restoredIdentity = canonical.identity;
  for (const entry of state.entries) {
    const source = path.join(seizure.seized, entry.name);
    const destination = path.join(lockDir, entry.name);
    const sourceMatches = sameFilesystemIdentity(fs, source, entry.identity);
    const destinationMatches = sameFilesystemIdentity(fs, destination, entry.identity);
    if (sourceMatches && pathIsMissing(fs, destination)) {
      assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
      assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
      assertDirectoryIdentity(fs, lockDir, restoredIdentity);
      assertFilesystemIdentity(fs, source, entry.identity);
      fs.renameSync(source, destination);
      assertDirectoryIdentity(fs, lockDir, restoredIdentity);
      assertFilesystemIdentity(fs, destination, entry.identity);
      continue;
    }
    if (!sourceMatches && destinationMatches) continue;
    throw lockTokenError(readOwner(path.join(lockDir, 'owner.json'), fs));
  }
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  assertDirectoryIdentity(fs, lockDir, restoredIdentity);
  if (!pathIsMissing(fs, seizure.seized)) {
    assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
    if (fs.readdirSync(seizure.seized).length !== 0) throw lockTokenError(readOwner(path.join(lockDir, 'owner.json'), fs));
    assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
    fs.rmdirSync(seizure.seized);
  }
  for (const entry of state.entries) {
    assertFilesystemIdentity(fs, path.join(lockDir, entry.name), entry.identity);
  }
  finishRestoreReservation({
    fs, meta, seizure: { ...seizure, lockDir }, state, restoredIdentity,
  });
}

function cleanCompletedRestore(fs, meta, name) {
  const expected = parseRestoreCompleteIdentity(name);
  if (!expected) return;
  const complete = path.join(meta, name);
  if (!sameDirectoryIdentity(fs, complete, expected)) return;
  const entries = fs.readdirSync(complete).sort();
  if (entries.length === 0) {
    assertDirectoryIdentity(fs, complete, expected);
    fs.rmdirSync(complete);
    return;
  }
  if (entries.length !== 1 || entries[0] !== RESTORE_STATE_FILE) return;
  const state = readRestoreState(fs, complete);
  if (!state || state.complete_name !== name) return;
  if (restoreCompleteName({
    reservation: path.join(meta, state.reservation_name), reservationIdentity: expected,
  }) !== name) return;
  const canonicalIdentity = state.canonicalIdentity;
  if (!canonicalIdentity) return;
  const lockDir = path.join(meta, '.wiki-lock');
  if (!sameDirectoryIdentity(fs, lockDir, canonicalIdentity)) return;
  for (const entry of state.entries) {
    if (!sameFilesystemIdentity(fs, path.join(lockDir, entry.name), entry.identity)) return;
  }
  const statePath = path.join(complete, RESTORE_STATE_FILE);
  const stateIdentity = readFilesystemIdentity(fs, statePath);
  if (!stateIdentity) return;
  assertDirectoryIdentity(fs, complete, expected);
  assertFilesystemIdentity(fs, statePath, stateIdentity);
  fs.unlinkSync(statePath);
  assertDirectoryIdentity(fs, complete, expected);
  fs.rmdirSync(complete);
}

function resumePendingRestores({ fs, meta, lockDir }) {
  let names;
  try {
    names = fs.readdirSync(meta).sort();
  } catch (cause) {
    if (cause.code === 'ENOENT') return;
    throw new LockError('LOCK_FILESYSTEM', 'cannot inspect lock restore reservations', undefined, cause);
  }
  for (const name of names) {
    if (name.startsWith('.wiki-lock.restore-complete.')) {
      cleanCompletedRestore(fs, meta, name);
      continue;
    }
    if (!/^\.wiki-lock\.(?:release|recovery)\./.test(name)) continue;
    const reservation = path.join(meta, name);
    const state = readRestoreState(fs, reservation);
    const intent = readTransitionIntent(fs, reservation);
    const seized = path.join(reservation, 'seized');
    if (!state) {
      if (!pathIsMissing(fs, seized)) {
        const active = activeSeizures.get(reservation);
        if (active
            && sameDirectoryIdentity(fs, reservation, active.reservationIdentity)
            && (active.seizedIdentity === null
              || sameDirectoryIdentity(fs, seized, active.seizedIdentity))) continue;
        const reservationIdentity = readDirectoryIdentity(fs, reservation);
        const seizedIdentity = readDirectoryIdentity(fs, seized);
        if (!reservationIdentity || !seizedIdentity) {
          const transitionIsCompleting = intent && transitionIntentIsLive(intent)
            && (pathIsMissing(fs, reservation) || pathIsMissing(fs, seized));
          if (transitionIsCompleting
              && identitiesMatch(reservationIdentity, intent.reservationIdentity)
              && sameDirectoryIdentity(fs, reservation, intent.reservationIdentity)) {
            throw new LockError(
              'LOCK_CONTENDED',
              'wiki lock transition is completing',
              readOwner(path.join(seized, 'owner.json'), fs),
            );
          }
          throw new LockError('LOCK_FILESYSTEM', 'unresolved lock seizure reservation identity is unavailable');
        }
        if (intent) {
          const transition = observeLiveTransition(
            fs, reservation, seized, intent, reservationIdentity, seizedIdentity,
          );
          if (transition === 'inconsistent') {
            throw new LockError('LOCK_FILESYSTEM', 'lock transition intent identity is inconsistent');
          }
          if (transition === 'active' || transition === 'completing') {
            throw new LockError(
              'LOCK_CONTENDED',
              transition === 'active'
                ? 'wiki lock transition is active'
                : 'wiki lock transition is completing',
              readOwner(path.join(seized, 'owner.json'), fs),
            );
          }
        }
        throw new LockError('LOCK_FILESYSTEM', 'unresolved lock seizure reservation requires recovery');
      }
      if (intent && !sameDirectoryIdentity(fs, reservation, intent.reservationIdentity)) {
        if (transitionIntentIsLive(intent) && pathIsMissing(fs, reservation)) {
          throw new LockError(
            'LOCK_CONTENDED',
            'wiki lock transition is completing',
            readOwner(path.join(seized, 'owner.json'), fs),
          );
        }
        throw new LockError('LOCK_FILESYSTEM', 'lock transition reservation identity is inconsistent');
      }
      continue;
    }
    const reservationIdentity = readDirectoryIdentity(fs, reservation);
    const seizedIdentity = deserializeIdentity(state.seized_identity);
    if (!reservationIdentity || !seizedIdentity) {
      throw new LockError('LOCK_FILESYSTEM', 'lock restore reservation identity is unavailable');
    }
    if (state.complete_name !== restoreCompleteName({ reservation, reservationIdentity })) {
      throw new LockError('LOCK_FILESYSTEM', 'lock restore completion identity is inconsistent');
    }
    if (intent) {
      if (!transitionIntentMatches(fs, reservation, seized, intent)
          || !removeTransitionIntentIfOwned(fs, {
            reservation, reservationIdentity,
          }, intent.intentIdentity)) {
        throw new LockError('LOCK_FILESYSTEM', 'lock restore transition intent identity is inconsistent');
      }
    }
    try {
      continueRestoreState({
        fs,
        meta,
        lockDir,
        seizure: { reservation, reservationIdentity, seized, seizedIdentity },
        state,
      });
    } catch (cause) {
      if (cause instanceof LockError && cause.code === 'LOCK_TOKEN_MISMATCH') continue;
      throw cause;
    }
  }
}

function reserveQuarantine({ fs, meta, purpose, randomBytes }) {
  const generate = randomBytes || crypto.randomBytes;
  let collision;
  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    const suffix = generate(16).toString('hex');
    const reservation = path.join(meta, `.wiki-lock.${purpose}.${process.pid}.${suffix}`);
    try {
      fs.mkdirSync(reservation);
      const reservationIdentity = readDirectoryIdentity(fs, reservation);
      if (!reservationIdentity) {
        throw new LockError('LOCK_FILESYSTEM', `wiki lock quarantine identity is unavailable for ${purpose}`);
      }
      const reservationPhysical = readPhysicalPath(fs, reservation);
      if (!reservationPhysical) {
        throw new LockError('LOCK_FILESYSTEM', `wiki lock quarantine physical path is unavailable for ${purpose}`);
      }
      return {
        reservation,
        reservationIdentity,
        seized: path.join(reservation, 'seized'),
        seizedPhysical: path.join(reservationPhysical, 'seized'),
      };
    } catch (cause) {
      if (cause.code === 'EEXIST') {
        collision = cause;
        continue;
      }
      throw new LockError('LOCK_FILESYSTEM', `cannot reserve wiki lock quarantine for ${purpose}`, undefined, cause);
    }
  }
  throw new LockError(
    'LOCK_FILESYSTEM',
    `cannot reserve unique wiki lock quarantine for ${purpose}`,
    undefined,
    collision,
  );
}

function removeEmptyReservation({ fs, reservation, reservationIdentity, purpose, cause }) {
  try {
    assertDirectoryIdentity(fs, reservation, reservationIdentity);
    fs.rmdirSync(reservation);
  } catch (cleanupCause) {
    throw new LockError(
      'LOCK_FILESYSTEM',
      `cannot clean empty wiki lock quarantine for ${purpose}`,
      undefined,
      cleanupCause,
    );
  }
  if (cause.code === 'ENOENT') return null;
  throw new LockError('LOCK_FILESYSTEM', `cannot seize wiki lock for ${purpose}`, undefined, cause);
}

function seizeLockDirectory({ fs, meta, lockDir, purpose, randomBytes, expectedIdentity }) {
  const seizure = reserveQuarantine({ fs, meta, purpose, randomBytes });
  let transition;
  try {
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    if (!pathIsMissing(fs, seizure.seized)) {
      throw new LockError('LOCK_FILESYSTEM', `wiki lock quarantine destination exists for ${purpose}`);
    }
    const candidateIdentity = readDirectoryIdentity(fs, lockDir);
    if (!candidateIdentity) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'canonical wiki lock identity is unavailable');
    }
    if (expectedIdentity && !identitiesMatch(candidateIdentity, expectedIdentity)) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'canonical wiki lock identity changed before seizure');
    }
    transition = publishTransitionIntent({
      fs,
      lockDir,
      seizure,
      purpose,
      seizedIdentity: candidateIdentity,
    });
    activeSeizures.set(seizure.reservation, {
      reservationIdentity: seizure.reservationIdentity,
      seizedIdentity: null,
    });
    fs.renameSync(lockDir, seizure.seized);
    const seizedIdentity = readDirectoryIdentity(fs, seizure.seized);
    if (!seizedIdentity) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'seized wiki lock identity is unavailable');
    }
    if (expectedIdentity && !identitiesMatch(seizedIdentity, candidateIdentity)) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'seized wiki lock identity changed');
    }
    if (expectedIdentity
        && !samePhysicalPath(readPhysicalPath(fs, seizure.seized), seizure.seizedPhysical)) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'seized wiki lock physical path changed');
    }
    activeSeizures.set(seizure.reservation, {
      reservationIdentity: seizure.reservationIdentity,
      seizedIdentity,
    });
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    return {
      ...seizure,
      seizedIdentity,
      transitionIntentIdentity: transition.intentIdentity,
    };
  } catch (cause) {
    activeSeizures.delete(seizure.reservation);
    if (!pathIsMissing(fs, seizure.seized)) throw cause;
    if (transition) {
      try {
        removeTransitionIntentIfOwned(fs, seizure, transition.intentIdentity);
      } catch (cleanupCause) {
        throw new LockError(
          'LOCK_FILESYSTEM',
          `cannot abandon wiki lock transition for ${purpose}`,
          undefined,
          cleanupCause,
        );
      }
    }
    return removeEmptyReservation({
      fs,
      reservation: seizure.reservation,
      reservationIdentity: seizure.reservationIdentity,
      purpose,
      cause,
    });
  }
}

function restoreSeizedLock({ fs, lockDir, seizure, owner }) {
  try {
    const meta = path.dirname(lockDir);
    const state = prepareRestoreState({ fs, lockDir, seizure });
    if (!removeTransitionIntentIfOwned(fs, seizure, seizure.transitionIntentIdentity)) {
      throw new LockError('LOCK_FILESYSTEM', 'lock restore transition intent identity changed');
    }
    continueRestoreState({
      fs,
      meta,
      lockDir,
      seizure,
      state,
    });
  } catch (cause) {
    if (cause instanceof LockError && cause.code === 'LOCK_TOKEN_MISMATCH') throw cause;
    throw lockTokenError(owner, cause);
  }
}

function removeSeizedLock({ fs, seizure, owner, purpose }) {
  try {
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    assertDirectoryIdentity(fs, seizure.seized, seizure.seizedIdentity);
    removeOwnedDirectory(fs, seizure.seized, seizure.seizedIdentity);
    if (!removeTransitionIntentIfOwned(fs, seizure, seizure.transitionIntentIdentity)) {
      throw new LockError('LOCK_FILESYSTEM', 'lock transition intent identity changed');
    }
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    fs.rmdirSync(seizure.reservation);
  } catch (cause) {
    throw new LockError('LOCK_FILESYSTEM', `cannot ${purpose} wiki lock`, owner, cause);
  }
}

function captureRecoveryCandidate({ fs, lockDir, ownerPath }) {
  const directoryIdentity = readDirectoryIdentity(fs, lockDir);
  if (!directoryIdentity) return null;
  const ownerRecord = readOwnerRecord(ownerPath, fs);
  if (!ownerRecord || !sameDirectoryIdentity(fs, lockDir, directoryIdentity)) return null;
  return { directoryIdentity, ownerRecord };
}

function assertRecoveryDirectorySeal({ fs, lockDir, seizure, candidate }) {
  assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
  assertDirectoryIdentity(fs, seizure.seized, candidate.directoryIdentity);
  if (!identitiesMatch(seizure.seizedIdentity, candidate.directoryIdentity)) {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery quarantine identity differs from the candidate');
  }
  if (!samePhysicalPath(readPhysicalPath(fs, seizure.seized), seizure.seizedPhysical)) {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery quarantine physical path changed');
  }
  if (!pathIsMissing(fs, lockDir)) {
    throw lockTokenError(readOwner(path.join(lockDir, 'owner.json'), fs));
  }
}

function assertRecoverySeal({ fs, lockDir, seizure, candidate }) {
  assertRecoveryDirectorySeal({ fs, lockDir, seizure, candidate });
  const names = fs.readdirSync(seizure.seized).sort();
  if (names.length !== 1 || names[0] !== 'owner.json') {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery quarantine contents are ambiguous');
  }
  const current = readOwnerRecord(path.join(seizure.seized, 'owner.json'), fs);
  if (!sameOwnerRecord(current, candidate.ownerRecord)) {
    throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery owner bytes changed');
  }
  assertRecoveryDirectorySeal({ fs, lockDir, seizure, candidate });
  return current;
}

function removeRecoveredLock({ fs, lockDir, seizure, candidate }) {
  try {
    const current = assertRecoverySeal({ fs, lockDir, seizure, candidate });
    const ownerPath = path.join(seizure.seized, 'owner.json');
    const ownerIdentity = readFilesystemIdentity(fs, ownerPath);
    if (!ownerIdentity || ownerIdentity.type !== REGULAR_FILE_TYPE) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery owner identity is unavailable');
    }
    assertRecoverySeal({ fs, lockDir, seizure, candidate });
    assertFilesystemIdentity(fs, ownerPath, ownerIdentity);
    fs.unlinkSync(ownerPath);
    assertRecoveryDirectorySeal({ fs, lockDir, seizure, candidate });
    if (fs.readdirSync(seizure.seized).length !== 0) {
      throw new LockError('LOCK_TOKEN_MISMATCH', 'recovery quarantine changed before removal');
    }
    assertRecoveryDirectorySeal({ fs, lockDir, seizure, candidate });
    fs.rmdirSync(seizure.seized);
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    if (!pathIsMissing(fs, lockDir)) throw lockTokenError(readOwner(path.join(lockDir, 'owner.json'), fs));
    if (!removeTransitionIntentIfOwned(fs, seizure, seizure.transitionIntentIdentity)) {
      throw new LockError('LOCK_FILESYSTEM', 'lock recovery transition intent identity changed');
    }
    assertDirectoryIdentity(fs, seizure.reservation, seizure.reservationIdentity);
    if (!pathIsMissing(fs, lockDir)) throw lockTokenError(readOwner(path.join(lockDir, 'owner.json'), fs));
    fs.rmdirSync(seizure.reservation);
    return current.owner;
  } catch (cause) {
    if (cause instanceof LockError) throw cause;
    throw new LockError(
      'LOCK_FILESYSTEM',
      'cannot remove authenticated recovery quarantine',
      candidate.ownerRecord.owner,
      cause,
    );
  }
}

function acquireLock(options = {}) {
  const { wikiRoot, operation } = options;
  const fs = options.fs || nodeFs;
  if (typeof operation !== 'string' || operation.trim() === '') throw new LockError('LOCK_INVALID', 'lock operation is required');
  const { meta, lockDir, ownerPath } = paths(wikiRoot);
  fs.mkdirSync(meta, { recursive: true });
  resumePendingRestores({ fs, meta, lockDir });
  try {
    fs.mkdirSync(lockDir);
  } catch (cause) {
    if (cause.code === 'EEXIST') throw new LockError('LOCK_CONTENDED', 'wiki lock is contended', readOwner(ownerPath, fs), cause);
    throw new LockError('LOCK_FILESYSTEM', 'cannot create wiki lock', undefined, cause);
  }
  const acquiredDirectoryIdentity = readDirectoryIdentity(fs, lockDir);
  if (!acquiredDirectoryIdentity) {
    throw new LockError('LOCK_FILESYSTEM', 'created wiki lock directory identity is unavailable');
  }
  const assertAcquiredDirectory = () => assertDirectoryIdentity(
    fs, lockDir, acquiredDirectoryIdentity,
  );
  try {
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (!Number.isFinite(now.getTime())) throw new LockError('LOCK_INVALID', 'lock time is invalid');
    const owner = {
      token: (options.randomBytes || crypto.randomBytes)(32).toString('hex'),
      operation: operation.trim(),
      pid: options.pid || process.pid,
      hostname: options.hostname || os.hostname(),
      acquired_at: now.toISOString(),
    };
    if (!isOwner(owner)) throw new LockError('LOCK_INVALID', 'generated lock owner is invalid');
    assertAcquiredDirectory();
    const writeOwner = options.writeOwner || ((file, bytes) => atomicWriteFile(file, bytes, {
      fs,
      createParent: false,
      beforeRename: assertAcquiredDirectory,
      beforePublish: assertAcquiredDirectory,
    }));
    writeOwner(ownerPath, `${JSON.stringify(owner)}\n`, owner, assertAcquiredDirectory);
    assertAcquiredDirectory();
    return owner;
  } catch (cause) {
    removeDirectoryIfOwned(fs, lockDir, acquiredDirectoryIdentity);
    throw cause;
  }
}

function assertLockOwner(options = {}) {
  const { wikiRoot, token } = options;
  const fs = options.fs || nodeFs;
  const { ownerPath } = paths(wikiRoot);
  const owner = readOwner(ownerPath, fs);
  if (!owner || typeof token !== 'string' || owner.token !== token) throw lockTokenError(owner);
  return owner;
}

function releaseLock(options = {}) {
  const { wikiRoot, token } = options;
  const fs = options.fs || nodeFs;
  const { meta, lockDir } = paths(wikiRoot);
  resumePendingRestores({ fs, meta, lockDir });
  const expectedOwner = assertLockOwner({ wikiRoot, token, fs });
  const seizure = seizeLockDirectory({
    fs, meta, lockDir, purpose: 'release', randomBytes: options.randomBytes,
  });
  if (!seizure) throw lockTokenError(null);
  try {
    const owner = readOwner(path.join(seizure.seized, 'owner.json'), fs);
    if (!owner || owner.token !== expectedOwner.token) {
      restoreSeizedLock({ fs, lockDir, seizure, owner });
      throw lockTokenError(owner);
    }
    removeSeizedLock({ fs, seizure, owner, purpose: 'release' });
    return true;
  } finally {
    retireActiveSeizure(fs, seizure);
  }
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return true;
  }
}

function recoverLock(options = {}) {
  const { wikiRoot } = options;
  const fs = options.fs || nodeFs;
  const { meta, lockDir, ownerPath } = paths(wikiRoot);
  resumePendingRestores({ fs, meta, lockDir });
  const staleMs = options.staleMs;
  if (!Number.isFinite(staleMs) || staleMs < 0) throw new LockError('LOCK_INVALID', 'staleMs must be nonnegative');
  const candidate = captureRecoveryCandidate({ fs, lockDir, ownerPath });
  if (!candidate) return false;
  const owner = candidate.ownerRecord.owner;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const age = now.getTime() - Date.parse(owner.acquired_at);
  if (!Number.isFinite(age) || (options.force !== true && age <= staleMs)) return false;
  if (owner.hostname !== (options.hostname || os.hostname())) return false;
  let alive;
  try {
    alive = (options.isPidAlive || defaultIsPidAlive)(owner.pid);
  } catch {
    alive = true;
  }
  if (alive !== false) return false;
  const seizure = seizeLockDirectory({
    fs,
    meta,
    lockDir,
    purpose: 'recovery',
    randomBytes: options.randomBytes,
    expectedIdentity: candidate.directoryIdentity,
  });
  if (!seizure) return false;
  let completed = false;
  try {
    removeRecoveredLock({ fs, lockDir, seizure, candidate });
    completed = true;
    return true;
  } finally {
    if (completed) retireActiveSeizure(fs, seizure);
    else activeSeizures.delete(seizure.reservation);
  }
}

module.exports = {
  acquireLock,
  assertLockOwner,
  releaseLock,
  recoverLock,
};
