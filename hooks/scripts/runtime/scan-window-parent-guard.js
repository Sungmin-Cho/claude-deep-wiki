'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { remainingMs } = require('./deadline.js');
const { isReclaimableJunkEntry } = require('./transaction-debris.js');

const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const PRUNE_RESERVE_MS = 250;
const FOREIGN_HOLD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ETXTBSY']);

class ScanWindowError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScanWindowError';
    this.code = code;
  }
}

function supportError(code, message, cause) {
  return new ScanWindowError(code, message, cause);
}

function nestedSafetyError(message, cause) {
  const error = supportError('SCAN_WINDOW_FILESYSTEM', message, cause);
  error.nestedJunkSafety = true;
  return error;
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

function plainRegularFileIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  const nlink = identityComponent(stat?.nlink);
  if (dev === null || ino === null || mode === null || birthtimeNs === null || nlink === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n || nlink !== 1n
      || (mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs };
}

function identitiesMatch(actual, expected) {
  return actual !== null && expected !== null
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.type === expected.type
    && actual.birthtimeNs === expected.birthtimeNs;
}

function inspectPhysicalDirectory(pathname, expectedPhysical, label, allowMissing = false) {
  let stat;
  try { stat = fs.lstatSync(pathname, { bigint: true }); }
  catch (cause) {
    if (allowMissing && cause.code === 'ENOENT') return null;
    throw supportError('SCAN_WINDOW_FILESYSTEM', `${label} directory identity is unavailable`, cause);
  }
  const identity = directoryIdentity(stat);
  if (!identity) throw supportError('SCAN_WINDOW_FILESYSTEM', `${label} must be a physical directory`);
  let physical;
  try { physical = fs.realpathSync.native(pathname); }
  catch (cause) {
    throw supportError('SCAN_WINDOW_FILESYSTEM', `${label} physical path is unavailable`, cause);
  }
  if (path.relative(expectedPhysical, physical) !== '') {
    throw supportError('SCAN_WINDOW_FILESYSTEM', `${label} escapes its physical wiki parent`);
  }
  return identity;
}

function invokeFault(faultInjector, stage, context) {
  if (typeof faultInjector === 'function') faultInjector(stage, context);
}

function identityKey(identity) {
  return [identity.dev, identity.ino, identity.type, identity.birthtimeNs]
    .map((value) => value.toString())
    .join(':');
}

function stableEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function semanticTransactionNames(options) {
  const {
    directory,
    expectedDirectoryIdentity = null,
    label,
    assertOwnerAndParents,
    assertBudget,
    nestedJunkAttempts,
    removed,
    limit,
    deadline,
    faultInjector,
  } = options;
  const inspectDirectory = () => {
    try { return inspectPhysicalDirectory(directory, directory, label); }
    catch (cause) {
      cause.nestedJunkSafety = true;
      throw cause;
    }
  };
  const readEntries = () => {
    try { return stableEntries(directory); }
    catch (cause) {
      throw nestedSafetyError(`${label} membership is unavailable`, cause);
    }
  };
  const assertParents = () => {
    try { assertOwnerAndParents(); }
    catch (cause) {
      if (cause.code !== 'DEADLINE_EXCEEDED') cause.nestedJunkSafety = true;
      throw cause;
    }
  };
  const assertDirectory = () => {
    assertBudget();
    assertParents();
    const identity = inspectDirectory();
    assertBudget();
    if (expectedDirectoryIdentity && !identitiesMatch(identity, expectedDirectoryIdentity)) {
      throw nestedSafetyError(`${label} identity changed`);
    }
    assertParents();
    return identity;
  };
  const admittedDirectoryIdentity = assertDirectory();
  const entries = readEntries();
  assertBudget();
  let deferred = false;
  let budgetExhausted = false;

  for (const entry of entries) {
    if (!isReclaimableJunkEntry(entry, directory)) continue;
    const pathname = path.join(directory, entry.name);
    let restart = true;
    while (restart) {
      restart = false;
      let admittedIdentity;
      try { admittedIdentity = plainRegularFileIdentity(fs.lstatSync(pathname, { bigint: true })); }
      catch (cause) {
        if (cause.code === 'ENOENT') break;
        throw nestedSafetyError(`${label} metadata identity is unavailable`, cause);
      }
      if (!admittedIdentity) break;
      const key = identityKey(admittedIdentity);
      if (nestedJunkAttempts.attemptedPhysicalFiles.has(key)) {
        deferred = true;
        break;
      }
      if (removed.length + nestedJunkAttempts.attempts >= limit
          || remainingMs(deadline) < PRUNE_RESERVE_MS) {
        deferred = true;
        budgetExhausted = true;
        nestedJunkAttempts.budgetExhausted = true;
        break;
      }
      nestedJunkAttempts.attemptedPhysicalFiles.add(key);
      nestedJunkAttempts.attempts += 1;
      invokeFault(faultInjector, 'after-nested-junk-admission', {
        pathname,
        attempt: nestedJunkAttempts.attempts,
      });
      invokeFault(faultInjector, `nested-junk-remove:${nestedJunkAttempts.attempts}`, { pathname });
      assertBudget();
      assertParents();
      const currentDirectoryIdentity = inspectDirectory();
      if (!identitiesMatch(currentDirectoryIdentity, admittedDirectoryIdentity)
          || (expectedDirectoryIdentity
            && !identitiesMatch(currentDirectoryIdentity, expectedDirectoryIdentity))) {
        throw nestedSafetyError(`${label} identity changed`);
      }
      assertParents();
      let currentIdentity;
      try { currentIdentity = plainRegularFileIdentity(fs.lstatSync(pathname, { bigint: true })); }
      catch (cause) {
        if (cause.code === 'ENOENT') break;
        throw nestedSafetyError(`${label} metadata identity is unavailable`, cause);
      }
      if (!currentIdentity) {
        break;
      }
      if (!identitiesMatch(currentIdentity, admittedIdentity)) {
        restart = true;
        continue;
      }
      try { fs.unlinkSync(pathname); }
      catch (cause) {
        if (cause.code === 'ENOENT') break;
        if (FOREIGN_HOLD_CODES.has(cause.code)) {
          deferred = true;
          break;
        }
        throw nestedSafetyError(`${label} metadata removal failed`, cause);
      }
      invokeFault(faultInjector, 'after-nested-junk-unlink', { pathname });
      assertDirectory();
    }
  }

  const semanticNames = [];
  for (const entry of readEntries()) {
    if (!isReclaimableJunkEntry(entry, directory)) {
      semanticNames.push(entry.name);
      continue;
    }
    let identity;
    try {
      identity = plainRegularFileIdentity(
        fs.lstatSync(path.join(directory, entry.name), { bigint: true }),
      );
    }
    catch (cause) {
      if (cause.code === 'ENOENT') continue;
      semanticNames.push(entry.name);
      continue;
    }
    if (identity) deferred = true;
    else semanticNames.push(entry.name);
  }
  invokeFault(faultInjector, 'nested-junk-semantic-names', {
    directory,
    names: [...semanticNames],
  });
  assertDirectory();
  if (removed.length + nestedJunkAttempts.attempts >= limit
      || remainingMs(deadline) < PRUNE_RESERVE_MS) {
    deferred = true;
    budgetExhausted = true;
    nestedJunkAttempts.budgetExhausted = true;
  }
  return { semanticNames, deferred, budgetExhausted };
}

function assertNestedJunkSettled(result) {
  if (!result.deferred && !result.budgetExhausted) return result.semanticNames;
  const error = supportError(
    'SCAN_WINDOW_NESTED_JUNK_DEFERRED',
    'nested transaction metadata cleanup is incomplete',
  );
  error.nestedJunkBudgetExhausted = result.budgetExhausted === true;
  throw error;
}

function defaultTransactionParentGuard(locations, nestedJunkContext = null) {
  const records = {
    meta: { pathname: locations.meta, physical: locations.meta, label: '.wiki-meta', identity: null },
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
  const observe = (name, allowMissing = false, assertBoundary) => {
    const record = records[name];
    if (typeof assertBoundary === 'function') assertBoundary();
    const current = inspectPhysicalDirectory(
      record.pathname,
      record.physical,
      record.label,
      allowMissing,
    );
    if (typeof assertBoundary === 'function') assertBoundary();
    if (current === null) {
      if (record.identity !== null) {
        throw supportError('SCAN_WINDOW_FILESYSTEM', `${record.label} identity changed`);
      }
      return null;
    }
    if (record.identity !== null && !identitiesMatch(current, record.identity)) {
      throw supportError('SCAN_WINDOW_FILESYSTEM', `${record.label} identity changed`);
    }
    if (record.identity === null) record.identity = current;
    return current;
  };
  const assertMeta = (assertBoundary) => observe('meta', false, assertBoundary);
  const assertTransactions = (assertBoundary) => {
    assertMeta(assertBoundary);
    observe('transactions', false, assertBoundary);
    assertMeta(assertBoundary);
  };
  const assertAll = (assertBoundary) => {
    assertTransactions(assertBoundary);
    observe('transaction', false, assertBoundary);
    assertTransactions(assertBoundary);
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
    const names = nestedJunkContext
      ? assertNestedJunkSettled(semanticTransactionNames({
        ...nestedJunkContext,
        directory: locations.transaction,
        label: 'scan-window operation directory',
        assertOwnerAndParents() {
          if (typeof assertOwner === 'function') assertOwner();
          assertAll(nestedJunkContext.assertBudget);
        },
      }))
      : fs.readdirSync(locations.transaction).sort();
    if (names.length !== 0) {
      throw supportError('TRANSACTION_RECOVERY_REQUIRED', 'terminal transaction directory is not empty');
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
      throw supportError('SCAN_WINDOW_FILESYSTEM', 'terminal transaction directory survived removal');
    }
    assertTransactions();
  };
  const createDirectory = (name, assertOwner) => {
    const record = records[name];
    if (typeof assertOwner === 'function') assertOwner();
    if (name === 'transactions') assertMeta();
    else assertTransactions();
    try { fs.mkdirSync(record.pathname); }
    catch (cause) {
      if (cause.code !== 'EEXIST') {
        throw supportError('SCAN_WINDOW_FILESYSTEM', `cannot create ${record.label}`, cause);
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
  return { assertAll, assertTransactions, inspectExistingOperation, prepareParent, removeEmptyOperation };
}

module.exports = {
  ScanWindowError,
  assertNestedJunkSettled,
  defaultTransactionParentGuard,
  semanticTransactionNames,
};
