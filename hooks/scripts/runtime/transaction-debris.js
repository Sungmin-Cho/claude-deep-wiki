'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { remainingMs } = require('./deadline.js');
const { readMaybe, stateError } = require('./fs-safe.js');
const { assertLockOwner } = require('./lock.js');

const SWEEP_RESERVE_MS = 10_000;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOMBSTONE_KEYS = ['contract_version', 'operation_id', 'reason', 'drift'];
const TOMBSTONE_REASONS = new Set(['catalog-drift']);
const SWEEP_CLASSES = new Set(['activation', 'plain', 'cancelled', 'junk']);

// File names a desktop shell or sync client writes into any directory it touches. Treating one as
// fatal wedges every route on a vault that Finder, Explorer or a sync client has walked.
//
// The safety argument is NOT "the engine only creates directories here" — it also publishes
// ULID-named regular files directly under `.transactions/` as terminal-prune source reservations
// (`scan-window.js`). The argument is that the engine's namespace (ULID, `.activate-*`, `.prune-*`,
// `.reservation-.prune-*`, and `fs-safe`'s `.<name>.tmp.<pid>.<uuid>`) is disjoint from the junk
// namespace (exact name ∪ the AppleDouble `._` prefix). Widening either set must preserve that
// disjointness — `no engine-generated transaction store name is classified as junk` pins it.
// Anything unrecognized still demands recovery rather than being silently discarded.
const OS_METADATA_NAMES = new Set([
  '.DS_Store', '.localized', '.apdisk', '.VolumeIcon.icns', 'Icon\r',
  'Thumbs.db', 'ehthumbs.db', 'desktop.ini',
  '.directory', '.dropbox', '.dropbox.attr',
]);
const APPLE_DOUBLE_PREFIX = '._';
// Junk is by definition written and held by a foreign process, so a refused unlink is ordinary for
// this class. It must never fail the mutation route that happened to run the sweep — the reader
// already tolerates the file, and a later pass retries.
const FOREIGN_HOLD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ETXTBSY']);

function isTransactionStoreJunkName(name) {
  return typeof name === 'string'
    && (OS_METADATA_NAMES.has(name) || name.startsWith(APPLE_DOUBLE_PREFIX));
}

// Junk is reclaimable only as a plain regular file. A symlink wearing a junk name is still an
// unrecognized entry: it is refused, never followed and never removed.
function isReclaimableJunkEntry(entry, directory = null) {
  if (!isTransactionStoreJunkName(entry.name)) return false;
  if (entry.isFile() && !entry.isSymbolicLink()) return true;
  // Some filesystems return no directory-entry type at all. Falling through would make the reader
  // fatal again on exactly the vaults this change exists for, so a recognized name with an
  // unresolved type is settled with one `lstat`; a lookup failure fails closed.
  const unknownType = !entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()
    && !entry.isBlockDevice() && !entry.isCharacterDevice()
    && !entry.isFIFO() && !entry.isSocket();
  if (!unknownType || directory === null) return false;
  let stat;
  try { stat = fs.lstatSync(path.join(directory, entry.name)); }
  catch { return false; }
  return stat.isFile() && !stat.isSymbolicLink();
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validWikiRelativePath(value) {
  return typeof value === 'string' && value.length > 0
    && !path.isAbsolute(value) && !value.split('/').includes('..');
}

function validateTombstoneV1(source, requestedOperationId) {
  const reject = (message) => ({
    valid: false,
    error: stateError('TRANSACTION_RECOVERY_REQUIRED', message),
  });
  let bytes;
  let operationId = requestedOperationId;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    bytes = Buffer.from(source);
  } else if (typeof source === 'string') {
    operationId ||= path.basename(source);
    bytes = readMaybe(path.join(source, 'cancelled.json'));
  } else {
    return reject('cancel tombstone source is invalid');
  }
  if (bytes === null) return reject('cancel tombstone is absent');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return reject('cancel tombstone is unreadable'); }
  if (!hasExactKeys(value, TOMBSTONE_KEYS) || value.contract_version !== 1
      || typeof operationId !== 'string' || !ULID_RE.test(value.operation_id)
      || value.operation_id !== operationId || !TOMBSTONE_REASONS.has(value.reason)
      || !Array.isArray(value.drift) || value.drift.length < 1 || value.drift.length > 8
      || value.drift.some((entry) => !validWikiRelativePath(entry))) {
    return reject('cancel tombstone schema is invalid');
  }
  return {
    valid: true,
    value: {
      operation_id: value.operation_id,
      reason: value.reason,
      drift: [...value.drift],
    },
  };
}

function entryExists(pathname) {
  try { fs.lstatSync(pathname); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// `readdirSync` follows a directory symlink, so without this the sweep would enumerate and delete
// through a `.wiki-meta` or `.transactions` link and escape the wiki entirely. Lock ownership
// proves who may write, never where. A missing directory is benign only for the caller that says
// so — both `.wiki-meta` and `.transactions` may be absent on a wiki that has not created them —
// but `.wiki-meta` is always anchored FIRST, so a missing child under a *symlinked* parent can
// never read as benign; the commit path would otherwise create the store outside the wiki.
//
// Every non-ENOENT failure becomes WIKI_STATE_FILESYSTEM. That is load-bearing: an `EACCES` from
// this security check must never be mistakable for the foreign-hold codes that junk reclamation
// tolerates, or the anchor would fail open exactly when the filesystem is behaving oddly.
function physicalDirectoryIdentity(pathname, label, allowMissing) {
  let stat;
  try { stat = fs.lstatSync(pathname, { bigint: true }); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity is unavailable`, error);
  }
  if ((stat.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE
      || stat.ino <= 0n || stat.dev < 0n) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} must be a physical directory`);
  }
  let physical;
  try { physical = fs.realpathSync.native(pathname); }
  catch (cause) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} physical path is unavailable`, cause);
  }
  if (path.relative(pathname, physical) !== '') {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} escapes its physical wiki parent`);
  }
  // birthtime is carried so a recycled inode cannot impersonate the anchored directory.
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function transactionStoreAnchor(root, transactions) {
  physicalDirectoryIdentity(path.join(root, '.wiki-meta'), '.wiki-meta', true);
  return physicalDirectoryIdentity(transactions, '.wiki-meta/.transactions', true);
}

function identityUnchanged(current, expected) {
  return current !== null && current.dev === expected.dev && current.ino === expected.ino
    && current.birthtimeNs === expected.birthtimeNs;
}

function assertAnchorUnchanged(root, transactions, anchor) {
  if (!identityUnchanged(transactionStoreAnchor(root, transactions), anchor)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.transactions identity changed mid-sweep');
  }
}

// `removeEntryBounded` recurses through descendant pathnames, so re-proving only the store leaves
// the directory actually being traversed unsealed: swapping it for a symlink would make every
// child removal resolve through the link. Sealing that directory too closes the chain the sweep
// walks. Returns an `assertOwner` that proves the store, then the traversed directory.
function sealedAssertOwner(assertOwner, directory, label) {
  const expected = physicalDirectoryIdentity(directory, label, false);
  return () => {
    assertOwner();
    if (!identityUnchanged(physicalDirectoryIdentity(directory, label, true), expected)) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity changed mid-sweep`);
    }
  };
}

function invokeFault(faultInjector, boundary) {
  if (typeof faultInjector === 'function') faultInjector(boundary);
}

// Removes `pathname` (file or directory tree) leaf-first, checking the sweep reserve before
// each removal. Returns true if `pathname` is fully gone when this returns; false if the sweep
// reserve ran out partway through (some descendants may remain — safe to resume on a later call,
// since the remaining filesystem state alone is what a future sweep re-discovers and classifies).
function removeEntryBounded(pathname, deadline, assertOwner, faultInjector, counter) {
  let stat;
  try { stat = fs.lstatSync(pathname); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
    assertOwner();
    fs.rmSync(pathname, { force: true });
    return true;
  }
  let children;
  try { children = fs.readdirSync(pathname); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  for (const name of children) {
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
    if (!removeEntryBounded(path.join(pathname, name), deadline, assertOwner, faultInjector, counter)) return false;
  }
  invokeFault(faultInjector, `sweep-remove:${counter.value}`);
  counter.value += 1;
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
  assertOwner();
  fs.rmdirSync(pathname);
  return true;
}

// Reclaims one junk entry. The `Dirent` from `readdirSync` only describes the entry at enumeration
// time, so the type is re-proved here and the removal is a plain `unlink` — never a recursive
// delete and never a followed link. Returns 'removed', 'skipped' (vanished, retyped, or held by a
// foreign process), or 'yielded' (the deadline reserve ran out).
function reclaimJunkEntry(pathname, boundary, deadline, assertOwner, faultInjector) {
  invokeFault(faultInjector, boundary);
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return 'yielded';
  let stat;
  try { stat = fs.lstatSync(pathname); }
  catch (error) {
    if (error.code === 'ENOENT') return 'skipped';
    throw stateError('WIKI_STATE_FILESYSTEM', 'transaction store entry identity is unavailable', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'skipped';
  // Owner and anchor are re-proved here and are NEVER covered by the tolerance below: a validation
  // failure must fail closed even when its errno happens to be EACCES.
  assertOwner();
  invokeFault(faultInjector, boundary.replace('junk-remove:', 'junk-validated:'));
  // Validation itself costs syscalls on a slow mounted volume, so the reserve is re-checked here:
  // never start a mutation for inert debris with the budget already spent.
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return 'yielded';
  try { fs.unlinkSync(pathname); }
  catch (error) {
    if (error.code === 'ENOENT' || FOREIGN_HOLD_CODES.has(error.code)) return 'skipped';
    throw error;
  }
  invokeFault(faultInjector, boundary.replace('junk-remove:', 'junk-removed:'));
  // Detection, not prevention: Node exposes no `unlinkat`, so the anchor cannot be bound to the
  // unlink atomically. Re-proving afterwards turns a raced ancestor swap into a hard failure
  // instead of a silent success. See `docs/`-free note in the sweep comment for the residual.
  assertOwner();
  return 'removed';
}

// Returns the debris directories removed during this bounded pass in `removed`, and any reclaimed
// OS metadata files separately in `removed_junk`. The two vocabularies stay apart because callers
// surface `removed` as a list of transaction operation ids.
function sweepTransactionDebris(root, token, options = {}) {
  const { deadline, limit = 8, faultInjector } = options;
  const classes = options.classes === undefined
    ? new Set(SWEEP_CLASSES)
    : new Set(options.classes);
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('debris sweep limit must be a nonnegative integer');
  if ([...classes].some((name) => !SWEEP_CLASSES.has(name))) throw new TypeError('unknown transaction debris class');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const anchor = transactionStoreAnchor(root, transactions);
  if (anchor === null) return { processed: 0, removed: [], removed_junk: [] };
  let entries;
  try { entries = fs.readdirSync(transactions, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { processed: 0, removed: [], removed_junk: [] };
    throw error;
  }
  // Every mutation in this module goes through `assertOwner`, so re-proving the store's identity
  // here also covers a parent swapped between enumeration and removal, including inside recursion.
  const assertOwner = () => {
    assertLockOwner({ wikiRoot: root, token });
    assertAnchorUnchanged(root, transactions, anchor);
  };
  let processed = 0;
  let junkAttempts = 0;
  const removed = [];
  const removedJunk = [];
  const result = () => ({ processed, removed, removed_junk: removedJunk });
  // Transaction-class debris runs to completion first. Junk is inert; `cancelled` is the only class
  // that is fatal to a lock-free reader, so junk must never reach it first and spend the entry
  // budget or the deadline reserve on the way. Ordering — not a second budget — is what guarantees
  // that, so the documented per-pass cap stays a single `limit`.
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (processed >= limit) continue;
    if (entry.name.startsWith('.prune-')
        || entry.name.startsWith('.reservation-.prune-')) continue;
    const transaction = path.join(transactions, entry.name);
    const journal = path.join(transaction, 'journal.json');

    let debrisClass = null;
    if (entry.name.startsWith('.activate-')) {
      if (classes.has('activation')) debrisClass = 'activation';
    } else {
      if (entryExists(journal)) continue;
      const tombstone = path.join(transaction, 'cancelled.json');
      if (!entryExists(tombstone)) {
        if (classes.has('plain')) debrisClass = 'plain';
      } else if (classes.has('cancelled')) {
        let verdict;
        try { verdict = validateTombstoneV1(transaction, entry.name); }
        catch { continue; }
        if (verdict.valid) debrisClass = 'cancelled';
      }
    }
    if (debrisClass === null) continue;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) break;

    const sealedOwner = sealedAssertOwner(assertOwner, transaction, `.wiki-meta/.transactions/${entry.name}`);
    if (debrisClass !== 'cancelled') {
      const counter = { value: 0 };
      if (!removeEntryBounded(transaction, deadline, sealedOwner, faultInjector, counter)) {
        return result();
      }
      // Detection parity with the cancelled and junk branches: a removal is only reported once the
      // owner token and the store anchor still hold after it.
      assertOwner();
      processed += 1;
      removed.push(entry.name);
      continue;
    }

    const counter = { value: 0 };
    for (const name of fs.readdirSync(transaction)) {
      if (name === 'cancelled.json') continue;
      if (!removeEntryBounded(path.join(transaction, name), deadline, sealedOwner, faultInjector, counter)) {
        return result();
      }
    }
    // The tombstone and its directory are two more destructive syscalls, so they observe the same
    // reserve discipline and publish the same boundary shape as every other removal.
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return result();
    sealedOwner();
    fs.rmSync(path.join(transaction, 'cancelled.json'), { force: true });
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return result();
    sealedOwner();
    fs.rmdirSync(transaction);
    assertOwner();
    processed += 1;
    removed.push(entry.name);
  }

  if (!classes.has('junk')) return result();
  // Junk shares the one documented per-pass entry budget with transaction debris — it simply never
  // gets first claim on it. Every ATTEMPT counts, so a file the OS refuses to release cannot be
  // retried without bound inside a pass, and its distinct `junk-remove:<n>` boundary keeps the
  // interruption points addressable independently of `removeEntryBounded`'s per-tree counter.
  for (const entry of entries) {
    if (processed + junkAttempts >= limit) break;
    if (!isReclaimableJunkEntry(entry, transactions)) continue;
    const outcome = reclaimJunkEntry(
      path.join(transactions, entry.name), `junk-remove:${junkAttempts}`,
      deadline, assertOwner, faultInjector,
    );
    if (outcome === 'yielded') return result();
    junkAttempts += 1;
    if (outcome === 'removed') removedJunk.push(entry.name);
  }
  return result();
}

// Public form of the store anchor for callers that mutate `.transactions` outside a sweep. Throws
// WIKI_STATE_FILESYSTEM unless `.wiki-meta` and `.wiki-meta/.transactions` are both physical
// directories at their expected physical paths.
function assertTransactionStoreAnchored(root) {
  transactionStoreAnchor(root, path.join(root, '.wiki-meta', '.transactions'));
}

module.exports = {
  SWEEP_RESERVE_MS,
  assertTransactionStoreAnchored,
  validateTombstoneV1,
  sweepTransactionDebris,
  isTransactionStoreJunkName,
  isReclaimableJunkEntry,
};
