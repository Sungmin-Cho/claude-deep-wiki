'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ISO_UTC_RE } = require('./config.js');
const { atomicWriteFile, sha256 } = require('./fs-safe.js');
const { assertBeforeDeadline, createDeadline, remainingMs } = require('./deadline.js');
const {
  acquireLock,
  assertLockOwner,
  releaseLock,
} = require('./lock.js');
const { sweepTransactionDebris } = require('./transaction-debris.js');

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const STAGES = ['pending-before', 'pending-after', 'last-before', 'last-after'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-f0-9]{32,}$/;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const DEFAULT_ADAPTER_CONTROL = Symbol('default-scan-window-adapter-control');
const INPUT_KEYS = [
  'wiki_root', 'kind', 'proposed', 'expected', 'repair_pending_after', 'repair_last_after',
];
const JOURNAL_KEYS = [
  'contract_version', 'kind', 'operation_id', 'input', 'input_sha256', 'owner_token',
  'result_status', 'states', 'stage_sha256', 'transitions',
];
const TRANSITIONS = [
  'scan-window-preflighted',
  'scan-window-staged',
  'last-scan-written',
  'pending-scan-written',
  'scan-window-committed',
  'cleaned',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOMATIC_PRUNE_LIMIT = 8;
const PRUNE_RESERVE_MS = 250;

class ScanWindowError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScanWindowError';
    this.code = code;
  }
}

function scanError(code, message, cause) {
  return new ScanWindowError(code, message, cause);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    throw scanError('SCAN_WINDOW_INVALID', `${label} must be a canonical UTC-Z timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    throw scanError('SCAN_WINDOW_INVALID', `${label} must be a real canonical UTC-Z timestamp`);
  }
  return value;
}

function timestampFromBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    return null;
  }
  try { return canonicalTimestamp(text, 'scan window'); } catch { return null; }
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function bytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function sealBytes(bytes) {
  const value = Buffer.from(bytes);
  return { length: value.length, sha256: sha256(value) };
}

function sealedBytesEqual(bytes, expectedBytes, expectedSeal) {
  const value = Buffer.from(bytes);
  return value.length === expectedSeal.length
    && sha256(value) === expectedSeal.sha256
    && value.equals(expectedBytes);
}

function descriptor(bytes) {
  if (bytes === null) return { exists: false, bytes_base64: null, sha256: null };
  const value = Buffer.from(bytes);
  return { exists: true, bytes_base64: value.toString('base64'), sha256: sha256(value) };
}

function bytesFromDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !hasExactKeys(value, ['exists', 'bytes_base64', 'sha256'])) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor is malformed');
  }
  if (value.exists === false) {
    if (value.bytes_base64 !== null || value.sha256 !== null) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'absent scan-window descriptor carries bytes');
    }
    return null;
  }
  if (value.exists !== true || typeof value.bytes_base64 !== 'string'
      || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor is malformed');
  }
  const bytes = Buffer.from(value.bytes_base64, 'base64');
  if (bytes.toString('base64') !== value.bytes_base64) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor base64 is noncanonical');
  }
  if (sha256(bytes) !== value.sha256) throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor hash mismatch');
  return bytes;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stageBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function physicalWikiRoot(wikiRoot) {
  if (typeof wikiRoot !== 'string' || !path.isAbsolute(wikiRoot)) {
    throw scanError('SCAN_WINDOW_INVALID', 'wikiRoot must be absolute');
  }
  try { return fs.realpathSync.native(wikiRoot); } catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'cannot resolve physical wiki root', cause);
  }
}

function identityComponent(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function directoryIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n
      || (mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs };
}

function identitiesMatch(actual, expected) {
  return actual !== null && expected !== null
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.type === expected.type
    && actual.birthtimeNs === expected.birthtimeNs;
}

function regularFileIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  const mtimeNs = identityComponent(stat?.mtimeNs);
  const nlink = identityComponent(stat?.nlink);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || mtimeNs === null || nlink === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n || mtimeNs < 0n || nlink !== 1n
      || (mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs, mtimeNs, nlink };
}

function terminalJournalIsOldEnough(identity, nowMs, maxAgeDays) {
  const nowNs = BigInt(nowMs) * 1_000_000n;
  const ageNs = nowNs - identity.mtimeNs;
  return ageNs >= 0n
    && (maxAgeDays === 0
      || ageNs > BigInt(maxAgeDays) * BigInt(DAY_MS) * 1_000_000n);
}

function assertRegularFileIdentity(pathname, expected, ageGate = null) {
  let actual;
  try { actual = regularFileIdentity(fs.lstatSync(pathname, { bigint: true })); }
  catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal identity is unavailable', cause);
  }
  if (!identitiesMatch(actual, expected) || actual.mtimeNs !== expected.mtimeNs
      || actual.nlink !== expected.nlink) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal identity changed');
  }
  if (ageGate && !terminalJournalIsOldEnough(actual, ageGate.nowMs, ageGate.maxAgeDays)) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal is no longer old enough');
  }
}

function samePhysicalPath(actual, expected) {
  return path.relative(expected, actual) === '';
}

function inspectPhysicalDirectory(pathname, expectedPhysical, label, allowMissing = false) {
  let stat;
  try {
    stat = fs.lstatSync(pathname, { bigint: true });
  } catch (cause) {
    if (allowMissing && cause.code === 'ENOENT') return null;
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} directory identity is unavailable`, cause);
  }
  const identity = directoryIdentity(stat);
  if (!identity) throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} must be a physical directory`);
  let physical;
  try {
    physical = fs.realpathSync.native(pathname);
  } catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} physical path is unavailable`, cause);
  }
  if (!samePhysicalPath(physical, expectedPhysical)) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} escapes its physical wiki parent`);
  }
  return identity;
}

function pathsFor(wikiRoot, operationId) {
  const meta = path.join(wikiRoot, '.wiki-meta');
  const transactions = path.join(meta, '.transactions');
  const transaction = path.join(transactions, operationId);
  return {
    meta,
    transactions,
    transaction,
    journal: path.join(transaction, 'journal.json'),
    pending: path.join(meta, '.pending-scan'),
    last: path.join(meta, '.last-scan'),
    tombstone: path.join(transaction, 'pending.removed'),
  };
}

function defaultTransactionParentGuard(locations) {
  const records = {
    meta: {
      pathname: locations.meta,
      physical: locations.meta,
      label: '.wiki-meta',
      identity: null,
    },
    transactions: {
      pathname: locations.transactions,
      physical: locations.transactions,
      label: '.wiki-meta/.transactions',
      identity: null,
    },
    transaction: {
      pathname: locations.transaction,
      physical: locations.transaction,
      label: 'scan-window operation directory',
      identity: null,
    },
  };

  const observe = (name, allowMissing = false) => {
    const record = records[name];
    const current = inspectPhysicalDirectory(
      record.pathname, record.physical, record.label, allowMissing,
    );
    if (current === null) {
      if (record.identity !== null) {
        throw scanError('SCAN_WINDOW_FILESYSTEM', `${record.label} identity changed`);
      }
      return null;
    }
    if (record.identity !== null && !identitiesMatch(current, record.identity)) {
      throw scanError('SCAN_WINDOW_FILESYSTEM', `${record.label} identity changed`);
    }
    if (record.identity === null) record.identity = current;
    return current;
  };

  const assertMeta = () => observe('meta');
  const assertTransactions = () => {
    assertMeta();
    observe('transactions');
    assertMeta();
  };
  const assertAll = () => {
    assertTransactions();
    observe('transaction');
    assertTransactions();
  };
  const inspectExistingOperation = () => {
    assertMeta();
    if (observe('transactions', true) === null) return false;
    assertMeta();
    if (observe('transaction', true) === null) return false;
    assertAll();
    return true;
  };
  const removeEmptyOperation = (assertOwner) => {
    if (typeof assertOwner === 'function') assertOwner();
    assertAll();
    if (fs.readdirSync(locations.transaction).length !== 0) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'terminal transaction directory is not empty');
    }
    if (typeof assertOwner === 'function') assertOwner();
    assertAll();
    fs.rmdirSync(locations.transaction);
    if (typeof assertOwner === 'function') assertOwner();
    assertTransactions();
    if (inspectPhysicalDirectory(
      locations.transaction,
      locations.transaction,
      'scan-window operation directory',
      true,
    ) !== null) {
      throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal transaction directory survived removal');
    }
    assertTransactions();
  };
  const createDirectory = (name, assertOwner) => {
    const record = records[name];
    if (typeof assertOwner === 'function') assertOwner();
    if (name === 'transactions') assertMeta();
    else assertTransactions();
    try {
      fs.mkdirSync(record.pathname);
    } catch (cause) {
      if (cause.code !== 'EEXIST') {
        throw scanError('SCAN_WINDOW_FILESYSTEM', `cannot create ${record.label}`, cause);
      }
    }
    if (typeof assertOwner === 'function') assertOwner();
    if (name === 'transactions') {
      assertMeta();
      observe(name);
      assertMeta();
    } else {
      assertTransactions();
      observe(name);
      assertTransactions();
    }
  };
  const prepareParent = (assertOwner) => {
    assertMeta();
    if (observe('transactions', true) === null) createDirectory('transactions', assertOwner);
    else assertTransactions();
    if (typeof assertOwner === 'function') assertOwner();
    assertTransactions();
  };
  return {
    assertAll,
    assertTransactions,
    inspectExistingOperation,
    prepareParent,
    removeEmptyOperation,
  };
}

function validateOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(value)) {
    throw scanError('SCAN_WINDOW_INVALID', 'operationId is invalid');
  }
  return value;
}

function planScanWindowTransition(options = {}) {
  const kind = options.kind;
  const pendingBytes = options.pendingBytes === undefined && options.wikiRoot
    ? readMaybe(path.join(options.wikiRoot, '.wiki-meta', '.pending-scan'))
    : (options.pendingBytes ?? null);
  const lastBytes = options.lastBytes === undefined && options.wikiRoot
    ? readMaybe(path.join(options.wikiRoot, '.wiki-meta', '.last-scan'))
    : (options.lastBytes ?? null);
  const pendingTimestamp = timestampFromBytes(pendingBytes);
  const lastTimestamp = timestampFromBytes(lastBytes);

  if (kind === 'promote') {
    if (pendingBytes !== null && pendingTimestamp === null) {
      throw scanError('SCAN_WINDOW_INVALID', '.pending-scan is not a canonical timestamp');
    }
    if (lastBytes !== null && lastTimestamp === null) {
      throw scanError('SCAN_WINDOW_INVALID', '.last-scan is not a canonical timestamp');
    }
  }

  if (kind === 'ensure') {
    const proposed = canonicalTimestamp(options.proposed, 'proposed');
    if (pendingTimestamp !== null) {
      return {
        kind, resultStatus: 'preserved', proposed,
        pending: { before: pendingBytes, after: pendingBytes },
        last: { before: lastBytes, after: lastBytes },
      };
    }
    if (lastTimestamp !== null && proposed <= lastTimestamp) {
      return {
        kind, resultStatus: 'stale', proposed,
        pending: { before: pendingBytes, after: pendingBytes },
        last: { before: lastBytes, after: lastBytes },
      };
    }
    return {
      kind, resultStatus: 'created', proposed,
      pending: { before: pendingBytes, after: Buffer.from(`${proposed}\n`) },
      last: { before: lastBytes, after: lastBytes },
    };
  }

  if (kind === 'promote') {
    const expected = canonicalTimestamp(options.expected, 'expected');
    const nextLast = lastTimestamp !== null && lastTimestamp >= expected
      ? lastBytes
      : Buffer.from(`${expected}\n`);
    const nextPending = pendingTimestamp === expected ? null : pendingBytes;
    return {
      kind, resultStatus: 'promoted', expected,
      pending: { before: pendingBytes, after: nextPending },
      last: { before: lastBytes, after: nextLast },
    };
  }

  if (kind === 'repair') {
    return {
      kind, resultStatus: 'repaired',
      pending: {
        before: pendingBytes,
        after: Object.hasOwn(options, 'pendingAfter') ? options.pendingAfter : pendingBytes,
      },
      last: {
        before: lastBytes,
        after: Object.hasOwn(options, 'lastAfter') ? options.lastAfter : lastBytes,
      },
    };
  }
  throw scanError('SCAN_WINDOW_INVALID', 'unsupported scan-window transition kind');
}

function canonicalInput(wikiRoot, plan) {
  return {
    wiki_root: wikiRoot,
    kind: plan.kind,
    proposed: plan.proposed || null,
    expected: plan.expected || null,
    repair_pending_after: plan.kind === 'repair' ? descriptor(plan.pending.after) : null,
    repair_last_after: plan.kind === 'repair' ? descriptor(plan.last.after) : null,
  };
}

function inputHash(wikiRoot, plan) {
  return sha256(Buffer.from(JSON.stringify(canonicalInput(wikiRoot, plan))));
}

function defaultJournalAdapter(wikiRoot, operationId) {
  const locations = pathsFor(wikiRoot, operationId);
  const parents = defaultTransactionParentGuard(locations);
  const assertMutation = (assertOwner) => {
    if (typeof assertOwner === 'function') assertOwner();
    parents.assertAll();
  };
  const readGuarded = (file) => {
    parents.assertAll();
    const value = readMaybe(file);
    parents.assertAll();
    return value;
  };
  const writeGuarded = (file, bytes, assertOwner) => {
    const assertSafe = () => assertMutation(assertOwner);
    assertSafe();
    atomicWriteFile(file, bytes, {
      createParent: false,
      beforeRename: assertSafe,
      beforePublish: assertSafe,
    });
    assertSafe();
  };
  const removeGuarded = (file, assertOwner) => {
    assertMutation(assertOwner);
    fs.rmSync(file, { force: true });
    assertMutation(assertOwner);
  };
  return {
    locations,
    activateTransaction(value, assertOwner, options) {
      parents.prepareParent(assertOwner);
      const activation = path.join(
        locations.transactions,
        `.activate-${process.pid}-${crypto.randomUUID()}`,
      );
      assertOwner();
      parents.assertTransactions();
      fs.mkdirSync(activation);
      const identity = inspectPhysicalDirectory(
        activation, activation, 'scan-window activation directory',
      );
      const assertActivation = () => {
        assertOwner();
        parents.assertTransactions();
        const current = inspectPhysicalDirectory(
          activation, activation, 'scan-window activation directory',
        );
        if (!identitiesMatch(current, identity)) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'scan-window activation directory identity changed');
        }
        parents.assertTransactions();
      };
      atomicWriteFile(path.join(activation, 'journal.json'), `${JSON.stringify(value)}\n`, {
        createParent: false,
        beforeRename: assertActivation,
        beforePublish: assertActivation,
      });
      assertActivation();
      invokeFault(options.faultInjector, 'before-transaction-activate');
      assertActivation();
      fs.renameSync(activation, locations.transaction);
      invokeFault(options.faultInjector, 'after-transaction-activate');
    },
    readJournal() {
      if (!parents.inspectExistingOperation()) return null;
      try {
        const bytes = readGuarded(locations.journal);
        return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
      }
      catch (error) {
        if (error instanceof ScanWindowError) throw error;
        if (error.code === 'ENOENT') return null;
        throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'journal is unreadable', error);
      }
    },
    writeJournal(value, assertOwner) {
      writeGuarded(locations.journal, `${JSON.stringify(value)}\n`, assertOwner);
    },
    readStage(name) { return readGuarded(path.join(locations.transaction, `stage-${name}.json`)); },
    writeStage(name, bytes, assertOwner) {
      writeGuarded(path.join(locations.transaction, `stage-${name}.json`), bytes, assertOwner);
    },
    removeStage(name, assertOwner) {
      removeGuarded(path.join(locations.transaction, `stage-${name}.json`), assertOwner);
    },
    tombstonePath: locations.tombstone,
    [DEFAULT_ADAPTER_CONTROL]: {
      prepareDebrisSweep(assertOwner) {
        parents.prepareParent(assertOwner);
      },
      readDestination(file) {
        if (file !== locations.pending && file !== locations.last) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter destination is outside .wiki-meta');
        }
        return readGuarded(file);
      },
      writeDestination(file, bytes, assertOwner) {
        if (file !== locations.pending && file !== locations.last) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter destination is outside .wiki-meta');
        }
        writeGuarded(file, bytes, assertOwner);
      },
      prepareTombstoneParent(assertOwner) {
        assertMutation(assertOwner);
      },
      removeTombstone(file, assertOwner) {
        if (file !== locations.tombstone) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter tombstone is outside the operation directory');
        }
        removeGuarded(file, assertOwner);
      },
      movePendingToTombstone(file, tombstone, assertOwner) {
        if (file !== locations.pending || tombstone !== locations.tombstone) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter tombstone move escapes bound parents');
        }
        assertMutation(assertOwner);
        fs.renameSync(file, tombstone);
        assertMutation(assertOwner);
      },
      readJournalBytes() {
        return readGuarded(locations.journal);
      },
      removeCleanedTransaction(
        expectedJournal,
        expectedJournalBytes,
        expectedJournalSeal,
        expectedJournalIdentity,
        assertOwner,
        ageGate,
      ) {
        assertMutation(assertOwner);
        const names = fs.readdirSync(locations.transaction).sort();
        if (names.length !== 1 || names[0] !== 'journal.json') {
          throw scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'cleaned transaction contains unexpected entries',
          );
        }
        let current;
        let currentBytes;
        try {
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity);
          currentBytes = fs.readFileSync(locations.journal);
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity);
          current = JSON.parse(currentBytes.toString('utf8'));
        } catch (cause) {
          throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'cleaned journal is unreadable', cause);
        }
        validateJournal(current, operationId, wikiRoot);
        if (current.transitions.at(-1) !== 'cleaned'
            || !sealedBytesEqual(currentBytes, expectedJournalBytes, expectedJournalSeal)
            || !currentBytes.equals(stageBytes(current))
            || JSON.stringify(current) !== JSON.stringify(expectedJournal)) {
          throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'cleaned journal changed before pruning');
        }

        const quarantine = path.join(
          locations.transaction,
          `.prune-${process.pid}-${crypto.randomUUID()}`,
        );
        const quarantinedJournal = path.join(quarantine, 'journal.json');
        assertMutation(assertOwner);
        fs.mkdirSync(quarantine, { mode: 0o700 });
        const quarantineIdentity = inspectPhysicalDirectory(
          quarantine,
          quarantine,
          'terminal journal prune quarantine',
        );
        const quarantineName = path.basename(quarantine);
        const assertTransaction = (expectedNames) => {
          assertMutation(assertOwner);
          const actualNames = fs.readdirSync(locations.transaction).sort();
          const wantedNames = [...expectedNames].sort();
          if (actualNames.length !== wantedNames.length
              || actualNames.some((name, index) => name !== wantedNames[index])) {
            throw scanError(
              'TRANSACTION_RECOVERY_REQUIRED',
              'terminal transaction changed during journal pruning',
            );
          }
          assertMutation(assertOwner);
        };
        const assertQuarantine = (expectedNames) => {
          assertMutation(assertOwner);
          const actual = inspectPhysicalDirectory(
            quarantine,
            quarantine,
            'terminal journal prune quarantine',
          );
          if (!identitiesMatch(actual, quarantineIdentity)) {
            throw scanError(
              'SCAN_WINDOW_FILESYSTEM',
              'terminal journal prune quarantine identity changed',
            );
          }
          const actualNames = fs.readdirSync(quarantine).sort();
          if (actualNames.length !== expectedNames.length
              || actualNames.some((name, index) => name !== expectedNames[index])) {
            throw scanError(
              'TRANSACTION_RECOVERY_REQUIRED',
              'terminal journal prune quarantine contains unexpected entries',
            );
          }
          assertMutation(assertOwner);
        };

        try {
          assertTransaction([quarantineName, 'journal.json']);
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity, ageGate);
          fs.renameSync(locations.journal, quarantinedJournal);
        } catch (cause) {
          if (typeof cause.code === 'string' && cause.code.startsWith('LOCK_')) throw cause;
          try {
            assertQuarantine([]);
            fs.rmdirSync(quarantine);
            assertMutation(assertOwner);
          } catch (cleanupCause) {
            throw scanError(
              'TRANSACTION_RECOVERY_REQUIRED',
              'empty terminal journal prune quarantine requires recovery',
              cleanupCause,
            );
          }
          throw scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'cleaned journal changed before final prune eligibility',
            cause,
          );
        }

        try {
          assertTransaction([quarantineName]);
          assertQuarantine(['journal.json']);
          assertRegularFileIdentity(quarantinedJournal, expectedJournalIdentity, ageGate);
          const quarantinedBytes = fs.readFileSync(quarantinedJournal);
          assertRegularFileIdentity(quarantinedJournal, expectedJournalIdentity, ageGate);
          const quarantined = JSON.parse(quarantinedBytes.toString('utf8'));
          validateJournal(quarantined, operationId, wikiRoot);
          if (quarantined.transitions.at(-1) !== 'cleaned'
              || !sealedBytesEqual(
                quarantinedBytes,
                expectedJournalBytes,
                expectedJournalSeal,
              )
              || !quarantinedBytes.equals(stageBytes(quarantined))
              || JSON.stringify(quarantined) !== JSON.stringify(expectedJournal)) {
            throw scanError(
              'TRANSACTION_RECOVERY_REQUIRED',
              'quarantined journal changed before pruning',
            );
          }
          assertTransaction([quarantineName]);
          assertQuarantine(['journal.json']);
          assertRegularFileIdentity(quarantinedJournal, expectedJournalIdentity, ageGate);
        } catch (cause) {
          if (typeof cause.code === 'string' && cause.code.startsWith('LOCK_')) throw cause;
          throw scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'quarantined journal failed final prune validation',
            cause,
          );
        }

        fs.unlinkSync(quarantinedJournal);
        assertQuarantine([]);
        fs.rmdirSync(quarantine);
        if (typeof assertOwner === 'function') assertOwner();
        parents.assertAll();
        parents.removeEmptyOperation(assertOwner);
      },
    },
  };
}

function adapterFor(wikiRoot, operationId, provided) {
  if (!provided) return defaultJournalAdapter(wikiRoot, operationId);
  for (const method of ['readJournal', 'writeJournal', 'readStage', 'writeStage', 'removeStage']) {
    if (typeof provided[method] !== 'function') throw scanError('SCAN_WINDOW_INVALID', `journalAdapter.${method} is required`);
  }
  const locations = pathsFor(wikiRoot, operationId);
  return { ...provided, locations, tombstonePath: provided.tombstonePath || locations.tombstone };
}

function assertPersistenceDeadline(deadline, boundary) {
  if (deadline) assertBeforeDeadline(deadline, `scan-window-persistence:${boundary}`);
}

function mutateTransactionMetadata(options, boundary, mutation) {
  assertPersistenceDeadline(options.deadline, `${boundary}:before-fault`);
  invokeFault(options.faultInjector, boundary);
  assertPersistenceDeadline(options.deadline, `${boundary}:after-fault`);
  const assertOwner = () => assertLockOwner({ wikiRoot: options.wikiRoot, token: options.token });
  assertOwner();
  mutation(assertOwner);
  assertOwner();
}

function appendTransition(adapter, journal, transition, options) {
  if (!journal.transitions.includes(transition)) {
    assertPersistenceDeadline(options.deadline, `${transition}:journal-before`);
    const next = { ...journal, transitions: [...journal.transitions, transition] };
    mutateTransactionMetadata(options, `before-transition-${transition}-write`, (assertOwner) => {
      adapter.writeJournal(next, assertOwner);
    });
    journal.transitions = next.transitions;
    assertPersistenceDeadline(options.deadline, `${transition}:journal-after`);
  }
}

function invokeFault(faultInjector, stage) {
  if (typeof faultInjector === 'function') faultInjector(stage);
}

function makeJournal({ operationId, ownerToken, plan, wikiRoot }) {
  const input = canonicalInput(wikiRoot, plan);
  const states = {
    pending: { before: descriptor(plan.pending.before), after: descriptor(plan.pending.after) },
    last: { before: descriptor(plan.last.before), after: descriptor(plan.last.after) },
  };
  const stageHashes = {};
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    stageHashes[name] = sha256(stageBytes(states[target][side]));
  }
  return {
    contract_version: 1,
    kind: plan.kind,
    operation_id: operationId,
    input,
    input_sha256: sha256(Buffer.from(JSON.stringify(input))),
    owner_token: ownerToken,
    result_status: plan.resultStatus,
    states,
    stage_sha256: stageHashes,
    transitions: ['scan-window-preflighted'],
  };
}

function journalInvalid(message, cause) {
  throw scanError('TRANSACTION_RECOVERY_REQUIRED', message, cause);
}

function validateJournalInput(journal, wikiRoot) {
  const input = journal.input;
  if (!hasExactKeys(input, INPUT_KEYS) || input.wiki_root !== wikiRoot
      || !['ensure', 'promote', 'repair'].includes(input.kind) || journal.kind !== input.kind) {
    journalInvalid('scan-window journal canonical input is malformed');
  }
  if (!SHA256_RE.test(journal.input_sha256)
      || sha256(Buffer.from(JSON.stringify(input))) !== journal.input_sha256) {
    journalInvalid('scan-window journal canonical input hash mismatch');
  }
  try {
    if (input.kind === 'ensure') {
      canonicalTimestamp(input.proposed, 'journal proposed');
      if (input.expected !== null || input.repair_pending_after !== null || input.repair_last_after !== null) {
        journalInvalid('ensure journal contains foreign canonical input fields');
      }
    } else if (input.kind === 'promote') {
      canonicalTimestamp(input.expected, 'journal expected');
      if (input.proposed !== null || input.repair_pending_after !== null || input.repair_last_after !== null) {
        journalInvalid('promote journal contains foreign canonical input fields');
      }
    } else {
      if (input.proposed !== null || input.expected !== null) {
        journalInvalid('repair journal contains ensure or promote input');
      }
      bytesFromDescriptor(input.repair_pending_after);
      bytesFromDescriptor(input.repair_last_after);
    }
  } catch (cause) {
    if (cause.code === 'TRANSACTION_RECOVERY_REQUIRED') throw cause;
    journalInvalid('scan-window journal canonical input is invalid', cause);
  }
  return input;
}

function validateJournalStates(journal, input) {
  if (!hasExactKeys(journal.states, ['pending', 'last'])) {
    journalInvalid('scan-window journal states are malformed');
  }
  const bytes = {};
  for (const target of ['pending', 'last']) {
    const record = journal.states[target];
    if (!hasExactKeys(record, ['before', 'after'])) {
      journalInvalid(`scan-window ${target} state is malformed`);
    }
    bytes[target] = {
      before: bytesFromDescriptor(record.before),
      after: bytesFromDescriptor(record.after),
    };
  }

  let expected;
  if (input.kind === 'ensure') {
    expected = planScanWindowTransition({
      kind: 'ensure', proposed: input.proposed,
      pendingBytes: bytes.pending.before, lastBytes: bytes.last.before,
    });
  } else if (input.kind === 'promote') {
    expected = planScanWindowTransition({
      kind: 'promote', expected: input.expected,
      pendingBytes: bytes.pending.before, lastBytes: bytes.last.before,
    });
  } else {
    expected = {
      resultStatus: 'repaired',
      pending: { after: bytesFromDescriptor(input.repair_pending_after) },
      last: { after: bytesFromDescriptor(input.repair_last_after) },
    };
  }
  if (journal.result_status !== expected.resultStatus
      || !bytesEqual(bytes.pending.after, expected.pending.after)
      || !bytesEqual(bytes.last.after, expected.last.after)) {
    journalInvalid('scan-window journal result or state transition is inconsistent with canonical input');
  }
  return bytes;
}

function validateStageHashes(journal) {
  if (!hasExactKeys(journal.stage_sha256, STAGES)) {
    journalInvalid('scan-window stage hash map is malformed');
  }
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    const expected = sha256(stageBytes(journal.states[target][side]));
    if (!SHA256_RE.test(journal.stage_sha256[name]) || journal.stage_sha256[name] !== expected) {
      journalInvalid(`scan-window stage hash mismatch for ${name}`);
    }
  }
}

function validateTransitions(journal, stateBytes) {
  if (!Array.isArray(journal.transitions) || journal.transitions.length === 0
      || journal.transitions[0] !== 'scan-window-preflighted') {
    journalInvalid('scan-window transition history is malformed');
  }
  let previous = -1;
  const seen = new Set();
  for (const transition of journal.transitions) {
    const rank = TRANSITIONS.indexOf(transition);
    if (rank < 0 || rank <= previous || seen.has(transition)) {
      journalInvalid('scan-window transition history has unknown, duplicate, or out-of-order entries');
    }
    previous = rank;
    seen.add(transition);
  }
  const lastChanged = !bytesEqual(stateBytes.last.before, stateBytes.last.after);
  const pendingChanged = !bytesEqual(stateBytes.pending.before, stateBytes.pending.after);
  if ((seen.has('last-scan-written') || seen.has('pending-scan-written')
       || seen.has('scan-window-committed') || seen.has('cleaned'))
      && !seen.has('scan-window-staged')) {
    journalInvalid('scan-window destination transition precedes staging');
  }
  if (seen.has('last-scan-written') !== lastChanged
      && seen.has('last-scan-written')) {
    journalInvalid('scan-window journal records an unchanged last-scan write');
  }
  if (seen.has('pending-scan-written') !== pendingChanged
      && seen.has('pending-scan-written')) {
    journalInvalid('scan-window journal records an unchanged pending-scan write');
  }
  if (seen.has('pending-scan-written') && lastChanged && !seen.has('last-scan-written')) {
    journalInvalid('pending-scan transition precedes a required last-scan transition');
  }
  if (seen.has('scan-window-committed')
      && ((lastChanged && !seen.has('last-scan-written'))
          || (pendingChanged && !seen.has('pending-scan-written')))) {
    journalInvalid('scan-window committed before all changed destinations');
  }
  if (seen.has('cleaned') && !seen.has('scan-window-committed')) {
    journalInvalid('scan-window cleaned before commit');
  }
}

function validateJournal(journal, operationId, wikiRoot) {
  if (!hasExactKeys(journal, JOURNAL_KEYS) || journal.contract_version !== 1
      || journal.operation_id !== operationId || !TOKEN_RE.test(journal.owner_token)) {
    journalInvalid('scan-window journal is malformed');
  }
  const input = validateJournalInput(journal, wikiRoot);
  const stateBytes = validateJournalStates(journal, input);
  validateStageHashes(journal);
  validateTransitions(journal, stateBytes);
  return journal;
}

function stageTransaction(adapter, journal, options = {}) {
  const { faultInjector, deadline } = options;
  for (const name of STAGES) {
    assertPersistenceDeadline(deadline, `${name}:stage-read`);
    const [target, side] = name.split('-');
    const expected = stageBytes(journal.states[target][side]);
    const existing = adapter.readStage(name);
    if (existing === null) {
      assertPersistenceDeadline(deadline, `${name}:stage-before`);
      mutateTransactionMetadata(options, `before-stage-${name}-write`, (assertOwner) => {
        adapter.writeStage(name, expected, assertOwner);
      });
      invokeFault(faultInjector, `after-stage-${name}`);
      assertPersistenceDeadline(deadline, `${name}:stage-after`);
    } else if (sha256(existing) !== journal.stage_sha256[name] || !existing.equals(expected)) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `corrupt staged bytes for ${name}`);
    }
  }
  appendTransition(adapter, journal, 'scan-window-staged', options);
}

function verifyStages(adapter, journal) {
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    const expected = stageBytes(journal.states[target][side]);
    const actual = adapter.readStage(name);
    if (actual === null || sha256(actual) !== journal.stage_sha256[name] || !actual.equals(expected)) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `corrupt staged bytes for ${name}`);
    }
    try {
      bytesFromDescriptor(JSON.parse(actual.toString('utf8')));
    } catch (cause) {
      if (cause.code === 'TRANSACTION_RECOVERY_REQUIRED') throw cause;
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `staged descriptor is invalid for ${name}`, cause);
    }
  }
}

function destinationState(adapter, file, before, after) {
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  const current = control ? control.readDestination(file) : readMaybe(file);
  if (bytesEqual(current, after)) return 'after';
  if (bytesEqual(current, before)) return 'before';
  return 'conflict';
}

function verifyDestinationStates(adapter, journal, requireAfter = false) {
  for (const target of ['pending', 'last']) {
    const record = journal.states[target];
    const before = bytesFromDescriptor(record.before);
    const after = bytesFromDescriptor(record.after);
    const file = target === 'last' ? adapter.locations.last : adapter.locations.pending;
    const state = destinationState(adapter, file, before, after);
    const unchanged = bytesEqual(before, after);
    if ((requireAfter || unchanged) && state !== 'after') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination does not match staged after bytes`);
    }
    if (!requireAfter && !unchanged && state === 'conflict') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination diverged from staged bytes`);
    }
  }
}

function writeDestination({
  wikiRoot, token, adapter, file, bytes, beforeFault, afterFault, faultInjector, deadline,
}) {
  assertPersistenceDeadline(deadline, `${beforeFault}:before-fault`);
  invokeFault(faultInjector, beforeFault);
  assertPersistenceDeadline(deadline, `${beforeFault}:after-fault`);
  assertLockOwner({ wikiRoot, token });
  assertPersistenceDeadline(deadline, `${beforeFault}:before-write`);
  const assertOwner = () => assertLockOwner({ wikiRoot, token });
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  if (control) control.writeDestination(file, bytes, assertOwner);
  else {
    atomicWriteFile(file, bytes, {
      beforeRename: assertOwner,
      beforePublish: assertOwner,
    });
  }
  invokeFault(faultInjector, afterFault);
  assertPersistenceDeadline(deadline, `${afterFault}:after-write`);
}

function removePending({
  wikiRoot, token, adapter, file, tombstone, beforeFault, afterFault, faultInjector, deadline,
}) {
  assertPersistenceDeadline(deadline, `${beforeFault}:before-fault`);
  invokeFault(faultInjector, beforeFault);
  assertPersistenceDeadline(deadline, `${beforeFault}:after-fault`);
  assertLockOwner({ wikiRoot, token });
  const transactionOptions = { wikiRoot, token, faultInjector, deadline };
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  mutateTransactionMetadata(transactionOptions, 'before-tombstone-parent-create', (assertOwner) => {
    if (control) control.prepareTombstoneParent(assertOwner);
    else {
      assertOwner();
      fs.mkdirSync(path.dirname(tombstone), { recursive: true });
    }
  });
  mutateTransactionMetadata(transactionOptions, 'before-tombstone-prepare-remove', (assertOwner) => {
    if (control) control.removeTombstone(tombstone, assertOwner);
    else {
      assertOwner();
      fs.rmSync(tombstone, { force: true });
    }
  });
  invokeFault(faultInjector, 'before-matching-pending-destination-rename');
  assertPersistenceDeadline(deadline, 'before-matching-pending-destination-rename:after-fault');
  assertLockOwner({ wikiRoot, token });
  assertPersistenceDeadline(deadline, `${beforeFault}:before-remove`);
  if (control) {
    control.movePendingToTombstone(
      file, tombstone, () => assertLockOwner({ wikiRoot, token }),
    );
  } else fs.renameSync(file, tombstone);
  invokeFault(faultInjector, afterFault);
  assertPersistenceDeadline(deadline, `${afterFault}:after-remove`);
}

function applyDestination(adapter, journal, options, target) {
  const transition = target === 'last' ? 'last-scan-written' : 'pending-scan-written';
  const record = journal.states[target];
  const before = bytesFromDescriptor(record.before);
  const after = bytesFromDescriptor(record.after);
  const file = target === 'last' ? adapter.locations.last : adapter.locations.pending;
  if (bytesEqual(before, after)) {
    if (destinationState(adapter, file, before, after) !== 'after') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} unchanged destination diverged from staged bytes`);
    }
    return;
  }
  const state = destinationState(adapter, file, before, after);
  if (state === 'conflict') throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination diverged from staged bytes`);
  if (!journal.transitions.includes(transition) && state === 'before') {
    if (target === 'last') {
      writeDestination({
        ...options, adapter, file, bytes: after,
        beforeFault: 'before-last-scan-rename', afterFault: 'after-last-scan-rename',
      });
    } else if (after === null) {
      removePending({
        ...options, adapter, file, tombstone: adapter.tombstonePath,
        beforeFault: 'before-matching-pending-remove', afterFault: 'after-matching-pending-remove',
      });
    } else {
      writeDestination({
        ...options, adapter, file, bytes: after,
        beforeFault: 'before-pending-rename', afterFault: 'after-pending-rename',
      });
    }
  }
  const afterState = destinationState(adapter, file, before, after);
  if (afterState !== 'after') throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination did not reach staged after bytes`);
  appendTransition(adapter, journal, transition, options);
}

function cleanTransaction(adapter, journal, options = {}) {
  const { faultInjector, deadline } = options;
  if (journal.transitions.includes('cleaned')) return;
  assertPersistenceDeadline(deadline, 'cleanup:before-fault');
  invokeFault(faultInjector, 'before-cleanup');
  assertPersistenceDeadline(deadline, 'cleanup:after-fault');
  for (const name of STAGES) {
    assertPersistenceDeadline(deadline, `${name}:cleanup-before`);
    mutateTransactionMetadata(options, `before-stage-${name}-remove`, (assertOwner) => {
      adapter.removeStage(name, assertOwner);
    });
    assertPersistenceDeadline(deadline, `${name}:cleanup-after`);
  }
  assertPersistenceDeadline(deadline, 'tombstone:cleanup-before');
  mutateTransactionMetadata(options, 'before-tombstone-cleanup-remove', (assertOwner) => {
    const control = adapter[DEFAULT_ADAPTER_CONTROL];
    if (control) control.removeTombstone(adapter.tombstonePath, assertOwner);
    else {
      assertOwner();
      fs.rmSync(adapter.tombstonePath, { force: true });
    }
  });
  assertPersistenceDeadline(deadline, 'tombstone:cleanup-after');
  appendTransition(adapter, journal, 'cleaned', options);
}

function applyScanWindowTransition(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  const token = options.token;
  assertLockOwner({ wikiRoot: physicalRoot, token });
  assertPersistenceDeadline(options.deadline, 'transaction-entry');
  const adapter = adapterFor(physicalRoot, operationId, options.journalAdapter);
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  if (control) {
    const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
    control.prepareDebrisSweep(assertOwner);
    sweepTransactionDebris(physicalRoot, token, {
      deadline: options.deadline || createDeadline({ budgetMs: 12_000 }),
      classes: ['activation', 'plain'],
    });
  }
  const transactionOptions = { ...options, wikiRoot: physicalRoot, token };
  let journal = adapter.readJournal();
  const planHash = options.plan ? inputHash(physicalRoot, options.plan) : null;
  if (options.inputHash && planHash && options.inputHash !== planHash) {
    throw scanError('SCAN_WINDOW_INVALID', 'provided input hash does not match the requested scan-window plan');
  }
  const requestedHash = options.inputHash || planHash;
  if (journal) {
    journal = validateJournal(journal, operationId, physicalRoot);
    if (requestedHash && journal.input_sha256 !== requestedHash) {
      throw scanError('OPERATION_ID_COLLISION', 'operation id already belongs to different scan-window input');
    }
  } else {
    if (!options.plan || !requestedHash) throw scanError('TRANSACTION_NOT_FOUND', 'scan-window transaction does not exist');
    journal = makeJournal({ operationId, ownerToken: token, plan: options.plan, wikiRoot: physicalRoot });
    if (journal.input_sha256 !== requestedHash) {
      throw scanError('SCAN_WINDOW_INVALID', 'requested scan-window plan did not produce the canonical input hash');
    }
    assertPersistenceDeadline(options.deadline, 'journal-before-create');
    if (typeof adapter.activateTransaction === 'function') {
      mutateTransactionMetadata(transactionOptions, 'before-transaction-directory-create', () => {});
      const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
      adapter.activateTransaction(journal, assertOwner, transactionOptions);
    } else {
      mutateTransactionMetadata(transactionOptions, 'before-journal-create-write', (assertOwner) => {
        adapter.writeJournal(journal, assertOwner);
      });
      invokeFault(options.faultInjector, 'after-journal-created');
    }
    assertPersistenceDeadline(options.deadline, 'journal-after-create');
  }
  const cleaned = journal.transitions.includes('cleaned');
  verifyDestinationStates(adapter, journal, cleaned);
  if (cleaned) return { status: journal.result_status, operationId, journal };
  stageTransaction(adapter, journal, transactionOptions);
  verifyStages(adapter, journal);
  applyDestination(adapter, journal, transactionOptions, 'last');
  applyDestination(adapter, journal, transactionOptions, 'pending');
  verifyDestinationStates(adapter, journal, true);
  appendTransition(adapter, journal, 'scan-window-committed', transactionOptions);
  invokeFault(options.faultInjector, 'after-scan-window-committed');
  assertPersistenceDeadline(options.deadline, 'scan-window-committed:after-fault');
  cleanTransaction(adapter, journal, transactionOptions);
  return { status: journal.result_status, operationId, journal };
}

function recoverScanWindowTransaction(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  assertLockOwner({ wikiRoot: physicalRoot, token: options.token });
  const adapter = adapterFor(physicalRoot, operationId, options.journalAdapter);
  const journal = validateJournal(adapter.readJournal(), operationId, physicalRoot);
  return applyScanWindowTransition({
    ...options,
    wikiRoot: physicalRoot,
    operationId,
    inputHash: journal.input_sha256,
    journalAdapter: adapter,
  });
}

function pruneScanWindowTransactions(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const token = options.token;
  const maxAgeDays = options.maxAgeDays;
  const limit = options.limit === undefined ? AUTOMATIC_PRUNE_LIMIT : options.limit;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const deadline = options.deadline || createDeadline({ budgetMs: 12_000 });
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) {
    throw scanError('SCAN_WINDOW_INVALID', 'maxAgeDays must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw scanError('SCAN_WINDOW_INVALID', 'prune limit must be a nonnegative integer');
  }
  if (!Number.isFinite(now.getTime())) throw scanError('SCAN_WINDOW_INVALID', 'prune time is invalid');
  const kinds = options.kinds === undefined ? null : new Set(options.kinds);
  if (kinds && [...kinds].some((kind) => !['ensure', 'promote', 'repair'].includes(kind))) {
    throw scanError('SCAN_WINDOW_INVALID', 'prune kind is invalid');
  }
  const excludeOperationId = options.excludeOperationId === undefined
    ? null
    : validateOperationId(options.excludeOperationId);

  const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
  assertOwner();
  const transactions = path.join(physicalRoot, '.wiki-meta', '.transactions');
  let entries;
  try {
    if (inspectPhysicalDirectory(
      transactions,
      transactions,
      '.wiki-meta/.transactions',
      true,
    ) === null) return { processed: 0, removed: [], complete: true };
    entries = fs.readdirSync(transactions, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if (error.code === 'ENOENT') return { processed: 0, removed: [], complete: true };
    throw error;
  }

  const removed = [];
  let complete = true;
  for (const entry of entries) {
    if (removed.length >= limit || remainingMs(deadline) < PRUNE_RESERVE_MS) {
      complete = false;
      break;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()
        || entry.name === excludeOperationId) continue;
    let operationId;
    try { operationId = validateOperationId(entry.name); } catch { continue; }
    const adapter = defaultJournalAdapter(physicalRoot, operationId);
    const control = adapter[DEFAULT_ADAPTER_CONTROL];
    let journal;
    let journalBytes;
    let journalIdentity;
    try {
      const journalStat = fs.lstatSync(adapter.locations.journal, { bigint: true });
      journalIdentity = regularFileIdentity(journalStat);
      if (!journalIdentity) continue;
      journalBytes = control.readJournalBytes();
      if (journalBytes === null) continue;
      assertRegularFileIdentity(adapter.locations.journal, journalIdentity);
      journal = JSON.parse(journalBytes.toString('utf8'));
      validateJournal(journal, operationId, physicalRoot);
      if (!journalBytes.equals(stageBytes(journal))) continue;
    } catch {
      continue;
    }
    if (journal.transitions.at(-1) !== 'cleaned'
        || (kinds && !kinds.has(journal.kind))) continue;

    if (!terminalJournalIsOldEnough(journalIdentity, now.getTime(), maxAgeDays)) continue;
    let names;
    try { names = fs.readdirSync(adapter.locations.transaction).sort(); } catch { continue; }
    if (names.length !== 1 || names[0] !== 'journal.json') continue;

    assertOwner();
    try {
      control.removeCleanedTransaction(
        journal,
        journalBytes,
        sealBytes(journalBytes),
        journalIdentity,
        assertOwner,
        {
          nowMs: now.getTime(),
          maxAgeDays,
        },
      );
    } catch (error) {
      if (error.code === 'TRANSACTION_RECOVERY_REQUIRED') continue;
      throw error;
    }
    removed.push(operationId);
  }
  return { processed: removed.length, removed, complete };
}

function deterministicEnsureId(wikiRoot, proposed) {
  return `scan-window-ensure-${sha256(Buffer.from(`${wikiRoot}\0${proposed}`)).slice(0, 40)}`;
}

function ensurePendingScan(options = {}) {
  let physicalRoot;
  let owner;
  let result;
  let lockContended = false;
  let recoveryAttempted = false;
  try {
    physicalRoot = physicalWikiRoot(options.wikiRoot);
    canonicalTimestamp(options.proposed, 'proposed');
    if (!options.deadline) throw scanError('SCAN_WINDOW_INVALID', 'ensurePendingScan requires a deadline');
    while (!owner) {
      try {
        assertBeforeDeadline(options.deadline, 'scan-window-lock');
      } catch (error) {
        if (lockContended && error.code === 'DEADLINE_EXCEEDED') {
          throw scanError('LOCK_CONTENDED', 'scan-window lock remained contended until the deadline', error);
        }
        throw error;
      }
      try {
        owner = acquireLock({
          wikiRoot: physicalRoot,
          operation: 'scan-window-ensure',
          now: options.now,
          recoverDeadOwner: !recoveryAttempted,
        });
        recoveryAttempted = true;
      } catch (error) {
        recoveryAttempted = true;
        if (error.code !== 'LOCK_CONTENDED') throw error;
        lockContended = true;
        Atomics.wait(sleepArray, 0, 0, 2);
      }
    }
    assertBeforeDeadline(options.deadline, 'scan-window-preflight');
    const operationId = deterministicEnsureId(physicalRoot, options.proposed);
    const plan = planScanWindowTransition({
      wikiRoot: physicalRoot,
      kind: 'ensure',
      proposed: options.proposed,
    });
    const applied = applyScanWindowTransition({
      wikiRoot: physicalRoot,
      token: owner.token,
      plan,
      operationId,
      faultInjector: options.faultInjector,
      deadline: options.deadline,
    });
    result = { status: applied.status, operationId };
    try {
      pruneScanWindowTransactions({
        wikiRoot: physicalRoot,
        token: owner.token,
        maxAgeDays: 0,
        limit: AUTOMATIC_PRUNE_LIMIT,
        now: options.now,
        deadline: options.deadline,
        kinds: ['ensure'],
        excludeOperationId: operationId,
      });
    } catch { /* terminal maintenance never suppresses the persisted scan window */ }
  } catch (error) {
    result = { status: 'deferred', reason: error.code || 'SCAN_WINDOW_FILESYSTEM' };
  } finally {
    if (owner) {
      try { releaseLock({ wikiRoot: physicalRoot, token: owner.token }); }
      catch (error) {
        if (!result || result.status !== 'deferred') {
          result = { status: 'deferred', reason: error.code || 'LOCK_FILESYSTEM' };
        }
      }
    }
  }
  return result;
}

function promotePendingScan(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  assertLockOwner({ wikiRoot: physicalRoot, token: options.token });
  const plan = planScanWindowTransition({
    wikiRoot: physicalRoot,
    kind: 'promote',
    expected: options.expected,
  });
  const applied = applyScanWindowTransition({
    wikiRoot: physicalRoot,
    token: options.token,
    plan,
    operationId,
    journalAdapter: options.journalAdapter,
    faultInjector: options.faultInjector,
    deadline: options.deadline,
  });
  const lastBytes = bytesFromDescriptor(applied.journal.states.last.after);
  const pendingBytes = bytesFromDescriptor(applied.journal.states.pending.after);
  return {
    status: applied.status,
    operationId,
    lastScan: timestampFromBytes(lastBytes),
    pendingPreserved: pendingBytes !== null,
  };
}

module.exports = {
  ensurePendingScan,
  promotePendingScan,
  pruneScanWindowTransactions,
  recoverScanWindowTransaction,
  planScanWindowTransition,
  applyScanWindowTransition,
};
