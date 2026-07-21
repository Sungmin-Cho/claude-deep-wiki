'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { remainingMs } = require('./deadline.js');
const { readMaybe, stateError, SHA_RE } = require('./fs-safe.js');
const { assertLockOwner } = require('./lock.js');

const SWEEP_RESERVE_MS = 10_000;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOMBSTONE_KEYS = ['contract_version', 'operation_id', 'reason', 'drift'];
const TOMBSTONE_REASONS = new Set(['catalog-drift']);
const SWEEP_CLASSES = new Set(['activation', 'plain', 'cancelled']);

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

// Returns the number and names of debris directories removed during this bounded pass.
function sweepTransactionDebris(root, token, options = {}) {
  const { deadline, limit = 8 } = options;
  const classes = options.classes === undefined
    ? new Set(SWEEP_CLASSES)
    : new Set(options.classes);
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('debris sweep limit must be a nonnegative integer');
  if ([...classes].some((name) => !SWEEP_CLASSES.has(name))) throw new TypeError('unknown transaction debris class');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  let entries;
  try { entries = fs.readdirSync(transactions, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { processed: 0, removed: [] };
    throw error;
  }
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  let processed = 0;
  const removed = [];
  for (const entry of entries) {
    if (processed >= limit || !entry.isDirectory() || entry.isSymbolicLink()) continue;
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
    processed += 1;

    if (debrisClass !== 'cancelled') {
      assertOwner();
      fs.rmSync(transaction, { recursive: true, force: true });
      assertOwner();
      removed.push(entry.name);
      continue;
    }

    for (const name of fs.readdirSync(transaction)) {
      if (name === 'cancelled.json') continue;
      assertOwner();
      fs.rmSync(path.join(transaction, name), { recursive: true, force: true });
    }
    assertOwner();
    fs.rmSync(path.join(transaction, 'cancelled.json'), { force: true });
    assertOwner();
    fs.rmdirSync(transaction);
    assertOwner();
    removed.push(entry.name);
  }
  return { processed, removed };
}

module.exports = {
  SWEEP_RESERVE_MS,
  validateTombstoneV1,
  sweepTransactionDebris,
};
