'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const { assertBeforeDeadline } = require('./deadline.js');

const SHA_RE = /^[a-f0-9]{64}$/;

class WikiStateError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WikiStateError';
    this.code = code;
  }
}

function stateError(code, message, cause) {
  return new WikiStateError(code, message, cause);
}

function readMaybe(file) {
  try {
    const stat = nodeFs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${file} must be a regular non-symlink file`);
    }
    return nodeFs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function codePointCompare(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

const FILE_TYPE_MASK = 0o170000n;
const REGULAR_FILE_TYPE = 0o100000n;

function identityComponent(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function fileIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n) return null;
  if ((mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs };
}

function linkedRegularFileIdentity(stat) {
  const identity = fileIdentity(stat);
  const mtimeNs = identityComponent(stat?.mtimeNs);
  const nlink = identityComponent(stat?.nlink);
  if (!identity || mtimeNs === null || nlink === null || mtimeNs < 0n || nlink < 1n) return null;
  return { ...identity, mtimeNs, nlink };
}

function regularFileIdentity(stat) {
  const identity = linkedRegularFileIdentity(stat);
  return identity !== null && identity.nlink === 1n ? identity : null;
}

function regularFileIdentitiesMatch(left, right) {
  return left !== null && right !== null
    && left.dev === right.dev && left.ino === right.ino && left.type === right.type
    && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs
    && left.nlink === right.nlink;
}

const DEVICE_LOW_32_MASK = 0xFFFFFFFFn;

// libuv >=1.49 on Windows can report st_dev for the very same file two different ways
// depending on which syscall produced it. The fd side (fstat) always comes from
// NtQueryVolumeInformationFile's 32-bit ULONG serial, so it is always <= 0xFFFFFFFF. The
// path side (lstat fast-path) may report the 64-bit GetFileInformationByName form, or
// zero when the serial is unavailable. The low-32 clause is therefore directional: it only
// applies when expectedDev (the fd/fstat value) is itself a truncated 32-bit value, and it
// compares that against the low 32 bits of currentDev (the path/lstat value). This
// predicate must not be widened back to a symmetric low-32 match (which would also accept
// two full-width 64-bit devices with different upper bits) nor tightened back to strict
// equality, and it must not reject a zero-valued device on either side.
function devicesCompatible(expectedDev, currentDev) {
  if (expectedDev === currentDev) return true;
  if (expectedDev === 0n || currentDev === 0n) return true;
  return expectedDev <= DEVICE_LOW_32_MASK && (currentDev & DEVICE_LOW_32_MASK) === expectedDev;
}

function identityError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'FILESYSTEM_IDENTITY_UNAVAILABLE';
  return error;
}

function descriptorFileIdentity(fs, descriptor) {
  let stat;
  try {
    stat = fs.fstatSync(descriptor, { bigint: true });
  } catch (cause) {
    throw identityError('temporary file identity is unavailable', cause);
  }
  const identity = fileIdentity(stat);
  if (!identity) throw identityError('temporary file identity is unavailable');
  return identity;
}

function pathHasFileIdentity(fs, pathname, expected) {
  try {
    const current = fileIdentity(fs.lstatSync(pathname, { bigint: true }));
    return current !== null && devicesCompatible(expected.dev, current.dev)
      && current.ino === expected.ino && current.birthtimeNs === expected.birthtimeNs;
  } catch {
    return false;
  }
}

function assertPathHasFileIdentity(fs, pathname, expected) {
  if (!pathHasFileIdentity(fs, pathname, expected)) {
    throw identityError('temporary file ownership identity changed');
  }
}

function atomicWriteFile(destination, bytes, options = {}) {
  const fs = options.fs || nodeFs;
  if (typeof destination !== 'string' || destination.length === 0) throw new TypeError('destination path is required');
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  const directory = path.dirname(destination);
  if (options.createParent !== false) fs.mkdirSync(directory, { recursive: true });
  const suffix = (options.randomUUID || crypto.randomUUID)().replaceAll('-', '');
  const temporary = path.join(directory, `.${path.basename(destination)}.tmp.${process.pid}.${suffix}`);
  let descriptor;
  let temporaryIdentity;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryIdentity = descriptorFileIdentity(fs, descriptor);
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
    if (typeof options.beforeRename === 'function') options.beforeRename({ destination, temporary });
    assertPathHasFileIdentity(fs, temporary, temporaryIdentity);
    if (typeof options.beforePublish === 'function') options.beforePublish({ destination, temporary });
    fs.renameSync(temporary, destination);
    temporaryIdentity = undefined;
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    if (temporaryIdentity && pathHasFileIdentity(fs, temporary, temporaryIdentity)) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* remove only our own temp when possible */ }
    }
    throw error;
  }
}

function normalizeRelativePath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError('a nonempty relative path is required');
  }
  if (/^[A-Za-z]:/.test(value)) throw new Error('drive-qualified path is not wiki-relative');
  const native = platform === 'win32' ? path.win32 : path.posix;
  if (native.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new Error('absolute path is not a wiki-relative path');
  }
  const slashValue = value.replaceAll('\\', '/');
  const segments = slashValue.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error('relative path traversal is not allowed');
  const normalized = path.posix.normalize(slashValue);
  if (/^[A-Za-z]:/.test(normalized)) throw new Error('drive-qualified path is not wiki-relative');
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('relative path traversal is not allowed');
  }
  return normalized.replace(/^\.\//, '');
}

function walkFiles(root, options = {}) {
  const fs = options.fs || nodeFs;
  const platform = options.platform || process.platform;
  const native = platform === 'win32' ? path.win32 : path.posix;
  const { deadline } = options;
  if (!deadline) throw new TypeError('walkFiles requires a deadline');
  const files = [];

  function visit(directory, relativeDirectory) {
    assertBeforeDeadline(deadline, `directory:${relativeDirectory || '.'}`);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertBeforeDeadline(deadline, `file:${relative}`);
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
      const absolute = native.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative.replaceAll('\\', '/'));
    }
  }

  visit(root, '');
  return files.sort(codePointCompare);
}

function sha256(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stripMatchingQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== trimmed.at(-1) || !['"', "'"].includes(trimmed[0])) return trimmed;
  if (trimmed[0] === "'") return trimmed.slice(1, -1).replaceAll("''", "'");
  try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\'); }
}

function splitInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1);
  const values = [];
  let quote = null;
  let escaped = false;
  let current = '';
  for (const character of body) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote === '"') { current += character; escaped = true; continue; }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === ',') { if (current.trim()) values.push(stripMatchingQuotes(current)); current = ''; continue; }
    current += character;
  }
  if (quote) throw new Error('unterminated quote in inline list');
  if (current.trim()) values.push(stripMatchingQuotes(current));
  return values;
}

function parsePageFrontmatter(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: text };
  const result = {};
  const lines = match[1].replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let listKey = null;
  for (const line of lines) {
    const scalar = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (scalar) {
      const [, key, raw] = scalar;
      const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      const inline = splitInlineList(raw);
      if (inline) { result[camel] = inline; listKey = null; }
      else if (raw.trim() === '') { result[camel] = []; listKey = camel; }
      else { result[camel] = stripMatchingQuotes(raw); listKey = null; }
      continue;
    }
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) result[listKey].push(stripMatchingQuotes(item[1]));
  }
  result.body = text.slice(match[0].length);
  return result;
}

module.exports = {
  atomicWriteFile,
  normalizeRelativePath,
  walkFiles,
  sha256,
  parsePageFrontmatter,
  readMaybe,
  stateError,
  regularFileIdentity,
  regularFileIdentitiesMatch,
  SHA_RE,
};
