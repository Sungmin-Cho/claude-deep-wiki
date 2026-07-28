'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const repoRoot = path.resolve(__dirname, '..');
const scanWindowPath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'scan-window.js');
const lockPath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'lock.js');
const deadlinePath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'deadline.js');
const cliPath = path.join(repoRoot, 'scripts', 'wiki-runtime.js');
const racer = path.join(__dirname, 'fixtures', 'scan-window-racer.js');
const roots = new Set();

const T0 = '2026-07-11T00:00:00Z';
const T1 = '2026-07-11T01:00:00Z';
const T2 = '2026-07-11T02:00:00Z';
const T3 = '2026-07-11T03:00:00Z';

function modules() {
  return {
    ...require(scanWindowPath),
    ...require(lockPath),
    ...require(deadlinePath),
  };
}

function temporaryWiki(prefix = 'deep wiki scan window path with spaces ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(root);
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions'), { recursive: true });
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function metaPath(root, name) {
  return path.join(root, '.wiki-meta', name);
}

function replaceLiveLockExternallyAtInjectedGuard(root) {
  fs.rmSync(metaPath(root, '.wiki-lock'), { recursive: true });
}

function setState(root, { pending, last } = {}) {
  if (pending === undefined || pending === null) fs.rmSync(metaPath(root, '.pending-scan'), { force: true });
  else fs.writeFileSync(metaPath(root, '.pending-scan'), pending);
  if (last === undefined || last === null) fs.rmSync(metaPath(root, '.last-scan'), { force: true });
  else fs.writeFileSync(metaPath(root, '.last-scan'), last);
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function state(root) {
  return {
    pending: readMaybe(metaPath(root, '.pending-scan')),
    last: readMaybe(metaPath(root, '.last-scan')),
  };
}

function assertState(root, { pending, last }) {
  const actual = state(root);
  assert.equal(actual.pending?.toString('utf8') ?? null, pending);
  assert.equal(actual.last?.toString('utf8') ?? null, last);
  for (const name of fs.readdirSync(metaPath(root, '.transactions'), { recursive: true })) {
    assert.doesNotMatch(String(name), /\.tmp\./);
  }
}

function withOwner(root, operation, callback) {
  const { acquireLock, releaseLock } = modules();
  const owner = acquireLock({ wikiRoot: root, operation, now: new Date(T3) });
  try { return callback(owner); } finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function promote(root, expected, operationId, extra = {}) {
  return withOwner(root, 'scan-window-promote', (owner) => modules().promotePendingScan({
    wikiRoot: root,
    token: owner.token,
    expected,
    operationId,
    now: new Date(T3),
    ...extra,
  }));
}

function journalFiles(root) {
  const transactions = metaPath(root, '.transactions');
  return fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.activate-'))
    .map((entry) => path.join(transactions, entry.name, 'journal.json'))
    .filter((file) => fs.existsSync(file));
}

test('standalone scan-window activation converges a genuine v1.8.2 pre-journal crash residue', (t) => {
  const listing = spawnSync('git', [
    'ls-tree', '-r', '--name-only', '3ebe6bd', 'hooks/scripts/runtime',
  ], { cwd: repoRoot, encoding: 'utf8', shell: false });
  if (listing.status !== 0) { t.skip(`git show unavailable: ${listing.stderr.trim()}`); return; }
  const extraction = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki legacy scan-window ')));
  roots.add(extraction);
  for (const relative of listing.stdout.trim().split('\n').filter(Boolean)) {
    const shown = spawnSync('git', ['show', `3ebe6bd:${relative}`], { cwd: repoRoot, encoding: null, shell: false });
    if (shown.status !== 0) { t.skip(`git show unavailable for ${relative}`); return; }
    const destination = path.join(extraction, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, shown.stdout);
  }
  const legacy = require(path.join(extraction, 'hooks', 'scripts', 'runtime', 'scan-window.js'));

  const root = temporaryWiki('deep wiki legacy scan-window crash ');
  const operationId = 'legacy-scan-window-upgrade-probe';
  setState(root, { pending: T1, last: T0 });
  withOwner(root, 'legacy-scan-window-promote', (owner) => assert.throws(() => legacy.promotePendingScan({
    wikiRoot: root, token: owner.token, expected: T1, operationId, now: new Date(T3),
    faultInjector(boundary) { if (boundary === 'before-journal-create-write') throw new Error('legacy crash'); },
  }), /legacy crash/));
  const transaction = path.join(metaPath(root, '.transactions'), operationId);
  assert.equal(fs.existsSync(transaction), true);
  assert.equal(fs.existsSync(path.join(transaction, 'journal.json')), false);

  const promoted = promote(root, T1, operationId);
  assert.equal(promoted.status, 'promoted');
  assertState(root, { pending: null, last: `${T1}\n` });
});

function snapshotFlatDirectory(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [
    name,
    fs.readFileSync(path.join(directory, name)).toString('base64'),
  ]));
}

function snapshotTree(directory) {
  const snapshot = {};
  const visit = (pathname, relative) => {
    const stat = fs.lstatSync(pathname);
    const key = relative || '.';
    if (stat.isSymbolicLink()) {
      snapshot[key] = { type: 'symlink', target: fs.readlinkSync(pathname) };
      return;
    }
    if (stat.isDirectory()) {
      snapshot[key] = { type: 'directory' };
      for (const name of fs.readdirSync(pathname).sort()) {
        visit(path.join(pathname, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    snapshot[key] = { type: 'file', bytes: fs.readFileSync(pathname).toString('base64') };
  };
  visit(directory, '');
  return snapshot;
}

function makeClock(initial = 0) {
  let value = initial;
  return {
    nowMs: () => value,
    advance(amount) { value += amount; },
  };
}

test('planScanWindowTransition validates canonical UTC-Z input and preserves the oldest pending window', () => {
  const { planScanWindowTransition } = modules();
  const plan = planScanWindowTransition({
    kind: 'ensure', proposed: T2,
    pendingBytes: Buffer.from(`${T1}\n`), lastBytes: Buffer.from(`${T0}\n`),
  });
  assert.equal(plan.pending.before.toString(), `${T1}\n`);
  assert.equal(plan.pending.after.toString(), `${T1}\n`);
  assert.equal(plan.last.before.toString(), `${T0}\n`);
  assert.equal(plan.last.after.toString(), `${T0}\n`);
  assert.throws(() => planScanWindowTransition({ kind: 'ensure', proposed: '2026-07-11T02:00:00.000Z' }),
    (error) => error.code === 'SCAN_WINDOW_INVALID');
});

test('ensurePendingScan creates one canonical line and a committed transaction', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki();
  const result = ensurePendingScan({
    wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.equal(result.status, 'created');
  assert.match(result.operationId, /^[a-z0-9-]{20,}$/);
  assertState(root, { pending: `${T1}\n`, last: null });
  const journals = journalFiles(root);
  assert.equal(journals.length, 1);
  const journal = JSON.parse(fs.readFileSync(journals[0]));
  assert.equal(journal.kind, 'ensure');
  assert.equal(journal.operation_id, result.operationId);
  assert.deepEqual(journal.input, {
    wiki_root: root,
    kind: 'ensure',
    proposed: T1,
    expected: null,
    repair_pending_after: null,
    repair_last_after: null,
  });
  assert.equal(
    journal.input_sha256,
    crypto.createHash('sha256').update(JSON.stringify(journal.input)).digest('hex'),
  );
  assert.deepEqual(journal.transitions, [
    'scan-window-preflighted', 'scan-window-staged', 'pending-scan-written',
    'scan-window-committed', 'cleaned',
  ]);
  assert.equal(new Set(journal.transitions).size, journal.transitions.length);
});

test('ensurePendingScan preserves a valid oldest pending value byte-identically', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki preserve pending ');
  setState(root, { pending: `${T1}\r\n`, last: `${T0}\n` });
  const before = readMaybe(metaPath(root, '.pending-scan'));
  const result = ensurePendingScan({
    wikiRoot: root, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.equal(result.status, 'preserved');
  assert.deepEqual(readMaybe(metaPath(root, '.pending-scan')), before);
  assertState(root, { pending: `${T1}\r\n`, last: `${T0}\n` });
});

test('automatic scan-window maintenance keeps terminal transaction growth bounded', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki bounded ensure transactions ');
  let finalProposal;

  for (let index = 0; index < 16; index += 1) {
    finalProposal = new Date(Date.parse(T1) + index * 1000)
      .toISOString().replace('.000Z', 'Z');
    const result = ensurePendingScan({
      wikiRoot: root,
      proposed: finalProposal,
      deadline: createDeadline({ budgetMs: 3_000 }),
    });
    assert.notEqual(result.status, 'deferred');
  }

  const transactions = metaPath(root, '.transactions');
  const directories = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  assert.ok(directories.length <= 2, `terminal transaction directories: ${directories.length}`);

  const beforeRetry = snapshotTree(transactions);
  const retry = ensurePendingScan({
    wikiRoot: root,
    proposed: finalProposal,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(retry.status, 'deferred');
  assert.deepEqual(snapshotTree(transactions), beforeRetry);
});

test('automatic maintenance failure never suppresses the persisted scan window', () => {
  const { createDeadline, ensurePendingScan } = modules();
  const root = temporaryWiki('deep wiki nonfatal automatic prune ');
  const first = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(first.status, 'deferred');
  fs.rmSync(metaPath(root, '.pending-scan'));
  const transactions = metaPath(root, '.transactions');
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (pathname) => {
    if (path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      const error = new Error('injected terminal cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname);
  };
  let second;
  try {
    second = ensurePendingScan({
      wikiRoot: root,
      proposed: T2,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(second.status, 'created');
  assert.equal(readMaybe(metaPath(root, '.pending-scan')).toString('utf8'), `${T2}\n`);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        const value = JSON.parse(fs.readFileSync(pathname, 'utf8'));
        return value.operation_id === first.operationId
          && value.transitions.at(-1) === 'cleaned';
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning is token-fenced, conservative, age-gated, and exactly bounded', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune ');
  const transactions = metaPath(root, '.transactions');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');

  const interrupted = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(boundary) {
      if (boundary === 'after-transaction-activate') throw new Error('interrupt');
    },
  });
  assert.equal(interrupted.status, 'deferred');
  const inFlightJournalPath = journalFiles(root).find((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return journal.transitions.at(-1) !== 'cleaned';
  });
  assert.ok(inFlightJournalPath);
  const inFlightJournal = JSON.parse(fs.readFileSync(inFlightJournalPath, 'utf8'));
  const inFlightDirectory = path.dirname(inFlightJournalPath);
  fs.utimesSync(inFlightJournalPath, oldTime, oldTime);
  fs.utimesSync(inFlightDirectory, oldTime, oldTime);

  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T2,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const cleanedJournalPath = journalFiles(root).find((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return journal.transitions.at(-1) === 'cleaned';
  });
  assert.ok(cleanedJournalPath);
  const cleanedDirectory = path.dirname(cleanedJournalPath);
  fs.utimesSync(cleanedJournalPath, youngTime, youngTime);
  fs.utimesSync(cleanedDirectory, youngTime, youngTime);

  function copyCleanedTransaction(operationId, timestamp, destinationParent = transactions) {
    const destination = path.join(destinationParent, operationId);
    fs.cpSync(cleanedDirectory, destination, { recursive: true });
    const journalPath = path.join(destination, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    fs.writeFileSync(journalPath, `${JSON.stringify({ ...journal, operation_id: operationId })}\n`);
    fs.utimesSync(journalPath, timestamp, timestamp);
    fs.utimesSync(destination, timestamp, timestamp);
    return destination;
  }

  const removableIds = [
    'prunable-terminal-a',
    'prunable-terminal-b',
    'prunable-terminal-c',
  ];
  const removableDirectories = removableIds.map((operationId) =>
    copyCleanedTransaction(operationId, oldTime));

  const malformedDirectory = path.join(transactions, 'malformed-terminal');
  fs.mkdirSync(malformedDirectory);
  fs.writeFileSync(path.join(malformedDirectory, 'journal.json'), '{malformed\n');
  fs.utimesSync(path.join(malformedDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(malformedDirectory, oldTime, oldTime);

  const nonScanDirectory = path.join(transactions, 'foreign-operation');
  fs.mkdirSync(nonScanDirectory);
  fs.writeFileSync(path.join(nonScanDirectory, 'journal.json'), `${JSON.stringify({
    contract_version: 1,
    kind: 'ingest',
    operation_id: 'foreign-operation',
    transitions: ['cleaned'],
  })}\n`);
  fs.utimesSync(path.join(nonScanDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(nonScanDirectory, oldTime, oldTime);

  const linkedTarget = path.join(root, 'external-linked-terminal');
  copyCleanedTransaction('linked-terminal', oldTime, root);
  fs.renameSync(path.join(root, 'linked-terminal'), linkedTarget);
  const linkedEntry = path.join(transactions, 'linked-terminal');
  fs.symlinkSync(linkedTarget, linkedEntry, process.platform === 'win32' ? 'junction' : 'dir');

  const preserved = [
    inFlightDirectory,
    cleanedDirectory,
    malformedDirectory,
    nonScanDirectory,
  ];
  const preservedSnapshots = new Map(preserved.map((directory) => [
    directory,
    snapshotTree(directory),
  ]));
  const linkedTargetBefore = snapshotTree(linkedTarget);
  const beforeWrongToken = snapshotTree(transactions);
  const directoryCountBefore = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
  assert.equal(directoryCountBefore, 7);

  const owner = acquireLock({ wikiRoot: root, operation: 'transaction-prune' });
  try {
    assert.throws(() => pruneScanWindowTransactions({
      wikiRoot: root,
      token: '0'.repeat(64),
      maxAgeDays: 7,
      limit: 2,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.deepEqual(snapshotTree(transactions), beforeWrongToken);

    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 2,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result.removed, removableIds.slice(0, 2));
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(fs.existsSync(removableDirectories[0]), false);
  assert.equal(fs.existsSync(removableDirectories[1]), false);
  assert.equal(fs.existsSync(removableDirectories[2]), true);
  for (const [directory, before] of preservedSnapshots) {
    assert.deepEqual(snapshotTree(directory), before, directory);
  }
  assert.equal(inFlightJournal.operation_id, path.basename(inFlightDirectory));
  assert.equal(fs.lstatSync(linkedEntry).isSymbolicLink(), true);
  assert.deepEqual(snapshotTree(linkedTarget), linkedTargetBefore);
  const directoryCountAfter = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
  assert.equal(directoryCountAfter, 5);
});

test('transaction pruning preserves a hard-linked terminal journal byte-identically', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki hard linked terminal ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const journal = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
    'journal.json',
  );
  const linked = path.join(root, 'linked-terminal-journal.json');
  fs.linkSync(journal, linked);
  const before = fs.readFileSync(journal);
  const owner = acquireLock({ wikiRoot: root, operation: 'hard-link-prune' });
  try {
    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result.removed, []);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.deepEqual(fs.readFileSync(linked), before);
  assert.equal(fs.statSync(journal).nlink, 2);
  assert.equal(fs.statSync(linked).nlink, 2);
});

test('transaction pruning preserves noncanonical terminal journal bytes', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki noncanonical terminal journal ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const source = path.join(transactions, completed.operationId);
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  const candidates = new Map();

  for (const [operationId, mutate] of [
    ['noncanonical-trailing-whitespace', (bytes) => bytes.replace(/\n$/, ' \n')],
    ['noncanonical-duplicate-key', (bytes, journal) =>
      bytes.replace(/^\{/, `{"kind":${JSON.stringify(journal.kind)},`)],
  ]) {
    const transaction = path.join(transactions, operationId);
    fs.cpSync(source, transaction, { recursive: true });
    const journalPath = path.join(transaction, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const canonical = `${JSON.stringify({ ...journal, operation_id: operationId })}\n`;
    const noncanonical = Buffer.from(mutate(canonical, journal));
    fs.writeFileSync(journalPath, noncanonical);
    fs.utimesSync(journalPath, oldTime, oldTime);
    fs.utimesSync(transaction, oldTime, oldTime);
    candidates.set(journalPath, noncanonical);
  }
  fs.rmSync(source, { recursive: true });

  const owner = acquireLock({ wikiRoot: root, operation: 'noncanonical-prune' });
  try {
    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result, { processed: 0, removed: [], complete: true });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  for (const [journalPath, before] of candidates) {
    assert.deepEqual(fs.readFileSync(journalPath), before);
  }
});

test('transaction pruning preserves a terminal journal whose mtime becomes young after eligibility', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune mtime race ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const before = fs.readFileSync(journal);

  const originalReaddir = fs.readdirSync;
  let timestampChanged = false;
  fs.readdirSync = (pathname, ...args) => {
    if (!timestampChanged && pathname === transaction) {
      fs.utimesSync(journal, youngTime, youngTime);
      timestampChanged = true;
    }
    return originalReaddir(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'mtime-race-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.readdirSync = originalReaddir;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(timestampChanged, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(fs.statSync(journal).mtimeMs, youngTime.getTime());
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction pruning preserves the whole quarantine when identity changes at rename', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune empty quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const before = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  let timestampChanged = false;
  fs.renameSync = (source, destination, ...args) => {
    if (!timestampChanged
        && source === transaction
        && path.dirname(destination) === transactions
        && path.basename(destination).startsWith('.prune-')) {
      fs.utimesSync(journal, youngTime, youngTime);
      timestampChanged = true;
    }
    return originalRename(source, destination, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'identity-rename-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.renameSync = originalRename;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(timestampChanged, true);
  assert.deepEqual(result.removed, []);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try { return fs.statSync(pathname).isFile() && fs.readFileSync(pathname).equals(before); }
      catch { return false; }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning preserves the journal when a late transaction entry appears', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune late entry ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  let lateEntryCreated = false;
  fs.renameSync = (source, destination, ...args) => {
    if (!lateEntryCreated
        && source === transaction
        && path.dirname(destination) === transactions
        && path.basename(destination).startsWith('.prune-')) {
      fs.writeFileSync(path.join(transaction, 'late-entry'), 'ambiguous\n');
      lateEntryCreated = true;
    }
    return originalRename(source, destination, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'late-entry-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.renameSync = originalRename;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(lateEntryCreated, true);
  assert.deepEqual(result.removed, []);
  fs.rmSync(metaPath(root, '.pending-scan'), { force: true });
  const retry = ensurePendingScan({
    wikiRoot: root,
    proposed: T2,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(retry.status, 'deferred');
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning resumes an interrupted whole-directory quarantine', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable terminal quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalUnlink = fs.unlinkSync;
  let unlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!unlinkRefused
        && path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      unlinkRefused = true;
      const error = new Error('injected terminal quarantine interruption');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-quarantine-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(unlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  const quarantinedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return path.basename(path.dirname(pathname)).startsWith('.prune-')
          && fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(quarantinedJournal);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.dirname(quarantinedJournal)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning preserves the journal when its source reservation is replaced', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki replaced terminal prune reservation ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const authenticReservation = path.join(root, 'authentic-prune-reservation');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let reservationReplaced = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationReplaced
        && path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      originalRename(transaction, authenticReservation);
      fs.writeFileSync(transaction, 'replacement reservation\n');
      reservationReplaced = true;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'replaced-reservation-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(reservationReplaced, true);
  assert.deepEqual(result.removed, []);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
  assert.equal(fs.statSync(authenticReservation).isFile(), true);
});

test('transaction pruning preserves exact evidence when its reservation is replaced during backup unlink', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki replaced reservation at backup unlink ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const authenticReservation = path.join(transactions, '.authentic-prune-reservation');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let reservationReplaced = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationReplaced
        && path.basename(pathname) === 'journal.backup'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      originalRename(transaction, authenticReservation);
      fs.writeFileSync(transaction, 'replacement reservation\n');
      reservationReplaced = true;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'backup-unlink-replacement-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(reservationReplaced, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(authenticReservation), journalBytes);
});

test('transaction pruning resumes every interrupted reservation and backup publication phase', async (t) => {
  const scenarios = [
    ['source.reservation.pending', 'after-open'],
    ['source.reservation.pending', 'partial-write'],
    ['source.reservation.pending', 'before-fsync'],
    ['journal.backup.pending', 'after-open'],
    ['journal.backup.pending', 'partial-write'],
    ['journal.backup.pending', 'before-fsync'],
  ];
  for (const [targetName, phase] of scenarios) {
    await t.test(`${targetName}:${phase}`, () => {
      const {
        acquireLock,
        createDeadline,
        ensurePendingScan,
        pruneScanWindowTransactions,
        releaseLock,
      } = modules();
      const root = temporaryWiki(`deep wiki interrupted ${targetName} ${phase} `);
      const completed = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      assert.notEqual(completed.status, 'deferred');
      const transactions = metaPath(root, '.transactions');
      const journal = path.join(transactions, completed.operationId, 'journal.json');
      const oldTime = new Date('2026-07-01T00:00:00.000Z');
      const pruneNow = new Date('2026-07-28T00:00:00.000Z');
      fs.utimesSync(journal, oldTime, oldTime);

      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      const tracked = new Set();
      let interrupted = false;
      fs.openSync = (pathname, ...args) => {
        const descriptor = originalOpen(pathname, ...args);
        if (!interrupted && path.basename(pathname) === targetName) {
          tracked.add(descriptor);
          if (phase === 'after-open') {
            fs.closeSync(descriptor);
            interrupted = true;
            const error = new Error('injected interruption after publication open');
            error.code = 'EIO';
            throw error;
          }
        }
        return descriptor;
      };
      fs.writeFileSync = (target, bytes, ...args) => {
        if (!interrupted && tracked.has(target) && phase === 'partial-write') {
          originalWrite(target, Buffer.from(bytes).subarray(0, Math.max(1, bytes.length >> 1)));
          interrupted = true;
          const error = new Error('injected partial publication write');
          error.code = 'EIO';
          throw error;
        }
        return originalWrite(target, bytes, ...args);
      };
      fs.fsyncSync = (descriptor, ...args) => {
        if (!interrupted && tracked.has(descriptor) && phase === 'before-fsync') {
          interrupted = true;
          const error = new Error('injected interruption before publication fsync');
          error.code = 'EIO';
          throw error;
        }
        return originalFsync(descriptor, ...args);
      };

      const owner = acquireLock({ wikiRoot: root, operation: 'publication-interruption-prune' });
      try {
        const first = pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 7,
          limit: 1,
          now: pruneNow,
          deadline: createDeadline({ budgetMs: 12_000 }),
        });
        assert.equal(interrupted, true);
        assert.deepEqual(first.removed, []);
      } finally {
        fs.openSync = originalOpen;
        fs.writeFileSync = originalWrite;
        fs.fsyncSync = originalFsync;
      }

      try {
        const second = pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 7,
          limit: 1,
          now: pruneNow,
          deadline: createDeadline({ budgetMs: 12_000 }),
        });
        assert.deepEqual(second.removed, [completed.operationId]);
        assert.equal(fs.readdirSync(transactions).length, 0);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });
  }
});

test('transaction pruning resumes when only the sealed quarantine backup remains', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable terminal prune backup ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalUnlink = fs.unlinkSync;
  let backupUnlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!backupUnlinkRefused
        && path.basename(pathname) === 'journal.backup'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      backupUnlinkRefused = true;
      const error = new Error('injected terminal backup cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-backup-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(backupUnlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  const quarantinedBackup = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return path.basename(pathname) === 'journal.backup'
          && fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(quarantinedBackup);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.dirname(quarantinedBackup)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning resumes an empty quarantine under its active reservation', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable empty terminal quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);

  const originalRmdir = fs.rmdirSync;
  let quarantineRemovalRefused = false;
  fs.rmdirSync = (pathname, ...args) => {
    if (!quarantineRemovalRefused
        && path.basename(pathname).startsWith('.prune-')) {
      quarantineRemovalRefused = true;
      const error = new Error('injected empty quarantine cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalRmdir(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-empty-prune' });
  let emptyQuarantine;
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(quarantineRemovalRefused, true);
    assert.deepEqual(first.removed, []);
    emptyQuarantine = fs.readdirSync(transactions)
      .find((name) => name.startsWith('.prune-'));
    assert.ok(emptyQuarantine);
    assert.deepEqual(fs.readdirSync(path.join(transactions, emptyQuarantine)), []);
    assert.equal(fs.statSync(path.join(transactions, completed.operationId)).isFile(), true);
  } finally {
    fs.rmdirSync = originalRmdir;
  }

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.join(transactions, emptyQuarantine)), false);
    assert.equal(fs.existsSync(path.join(transactions, completed.operationId)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning removes an orphaned exact source reservation on retry', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki orphaned exact prune reservation ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);

  const originalUnlink = fs.unlinkSync;
  let reservationUnlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationUnlinkRefused
        && pathname === transaction
        && fs.statSync(pathname).isFile()) {
      reservationUnlinkRefused = true;
      const error = new Error('injected exact reservation cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'exact-reservation-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(reservationUnlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(fs.statSync(transaction).isFile(), true);
  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(transaction), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning quarantines before deletion and preserves a last-check pathname replacement', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune final identity race ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const authentic = path.join(root, 'authenticated-terminal-journal.json');
  const replacement = Buffer.from('replacement must survive\n');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const authenticBytes = fs.readFileSync(journal);

  const originalLstat = fs.lstatSync;
  let journalChecks = 0;
  let pathnameReplaced = false;
  fs.lstatSync = (pathname, ...args) => {
    const stat = originalLstat(pathname, ...args);
    if (pathname === journal && ++journalChecks === 3) {
      fs.renameSync(journal, authentic);
      fs.writeFileSync(journal, replacement);
      pathnameReplaced = true;
    }
    return stat;
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'final-identity-race-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.lstatSync = originalLstat;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(pathnameReplaced, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(authentic), authenticBytes);
  const survivingReplacement = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try { return fs.statSync(pathname).isFile() && fs.readFileSync(pathname).equals(replacement); }
      catch { return false; }
    });
  assert.ok(survivingReplacement);
});

test('transaction pruning reports incomplete traversal when its reserve expires before a late candidate', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune incomplete deadline ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const source = path.join(transactions, completed.operationId);
  const youngId = 'a-young-terminal';
  const oldId = 'z-old-terminal';
  const young = path.join(transactions, youngId);
  const old = path.join(transactions, oldId);
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  for (const [operationId, destination, timestamp] of [
    [youngId, young, youngTime],
    [oldId, old, oldTime],
  ]) {
    fs.cpSync(source, destination, { recursive: true });
    const journal = path.join(destination, 'journal.json');
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(journal, `${JSON.stringify({ ...value, operation_id: operationId })}\n`);
    fs.utimesSync(journal, timestamp, timestamp);
  }
  fs.rmSync(source, { recursive: true });

  const clock = makeClock();
  const originalReadFile = fs.readFileSync;
  let advanced = false;
  fs.readFileSync = (pathname, ...args) => {
    const value = originalReadFile(pathname, ...args);
    if (!advanced && pathname === path.join(young, 'journal.json')) {
      clock.advance(800);
      advanced = true;
    }
    return value;
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'incomplete-prune' });
  let first;
  try {
    first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    fs.readFileSync = originalReadFile;
  }
  assert.equal(advanced, true);
  assert.deepEqual(first, { processed: 0, removed: [], complete: false });
  assert.equal(fs.existsSync(old), true);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second, { processed: 1, removed: [oldId], complete: true });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction prune stops between recoverable cleanup phases when cumulative work expires', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki cumulative prune deadline ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  let clockValue = -150;
  const clock = { nowMs: () => { clockValue += 150; return clockValue; } };

  const owner = acquireLock({ wikiRoot: root, operation: 'cumulative-deadline-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
    assert.deepEqual(first, { processed: 0, removed: [], complete: false });
    const preserved = fs.readdirSync(transactions, { recursive: true })
      .map((relative) => path.join(transactions, relative))
      .some((pathname) => {
        try {
          return fs.statSync(pathname).isFile()
            && fs.readFileSync(pathname).equals(journalBytes);
        } catch {
          return false;
        }
      });
    assert.equal(preserved, true);

    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second, {
      processed: 1,
      removed: [completed.operationId],
      complete: true,
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction prune bounds cumulative filesystem discovery after its deadline expires', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki bounded prune discovery ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  const clock = makeClock();
  const owner = acquireLock({ wikiRoot: root, operation: 'bounded-discovery-prune' });
  const methods = ['lstatSync', 'readFileSync', 'readdirSync'];
  const originals = new Map(methods.map((name) => [name, fs[name]]));
  for (const name of methods) {
    fs[name] = (...args) => {
      const value = originals.get(name)(...args);
      clock.advance(90);
      return value;
    };
  }

  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.deepEqual(result, { processed: 0, removed: [], complete: false });
  assert.ok(clock.nowMs() <= 2_000, `discovery stopped at ${clock.nowMs()} ms`);
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction prune CLI exposes bounded terminal cleanup under the caller lock', () => {
  const { acquireLock, createDeadline, ensurePendingScan, releaseLock } = modules();
  const root = temporaryWiki('deep wiki transaction prune cli ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  const completedDirectory = path.dirname(journalFiles(root)[0]);
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(path.join(completedDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(completedDirectory, oldTime, oldTime);
  const owner = acquireLock({ wikiRoot: root, operation: 'transaction-prune-cli' });
  try {
    const result = spawnSync(process.execPath, [
      cliPath,
      'transaction', 'prune',
      '--wiki-root', root,
      '--lock-token', owner.token,
      '--max-age-days', '0',
      '--json',
    ], {
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).removed, [completed.operationId]);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('ensurePendingScan is stale at or before last-scan and repairs corrupt pending only for a newer proposal', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki stale ensure ');
  setState(root, { last: `${T2}\n` });
  assert.equal(ensurePendingScan({
    wikiRoot: root, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  }).status, 'stale');
  assertState(root, { pending: null, last: `${T2}\n` });
  fs.writeFileSync(metaPath(root, '.pending-scan'), Buffer.from([0xff, 0x00]));
  assert.equal(ensurePendingScan({
    wikiRoot: root, proposed: T3, now: new Date(T3), deadline: createDeadline({ budgetMs: 12_000 }),
  }).status, 'created');
  assertState(root, { pending: `${T3}\n`, last: `${T2}\n` });
});

test('ensurePendingScan defers quietly on bounded lock contention without a lock-free fallback', () => {
  const { acquireLock, releaseLock, ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki ensure contention ');
  const owner = acquireLock({ wikiRoot: root, operation: 'held' });
  try {
    const result = ensurePendingScan({
      wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 25 }),
    });
    assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_CONTENDED' });
    assertState(root, { pending: null, last: null });
    assert.equal(journalFiles(root).length, 0);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

for (const linkedParent of ['.wiki-meta', '.transactions', 'operation']) {
  test(`default transaction adapter rejects a ${linkedParent} directory link before external mutation`, () => {
    const { acquireLock, releaseLock, promotePendingScan } = modules();
    const root = temporaryWiki(`deep wiki linked ${linkedParent} transaction parent `);
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `deep wiki outside ${linkedParent} `)));
    roots.add(outside);
    const operationId = `linked-${linkedParent.replace('.', '')}-operation`;
    const meta = metaPath(root, '');
    const transactions = path.join(meta, '.transactions');
    const operation = path.join(transactions, operationId);
    let linkedPath;
    let linkedTarget;
    let externalOperation;

    if (linkedParent === '.wiki-meta') {
      linkedPath = meta;
      linkedTarget = outside;
      externalOperation = path.join(outside, '.transactions', operationId);
      fs.rmSync(meta, { recursive: true });
    } else if (linkedParent === '.transactions') {
      linkedPath = transactions;
      linkedTarget = outside;
      externalOperation = path.join(outside, operationId);
      fs.rmSync(transactions, { recursive: true });
    } else {
      linkedPath = operation;
      linkedTarget = outside;
      externalOperation = outside;
    }

    fs.mkdirSync(externalOperation, { recursive: true });
    fs.writeFileSync(path.join(outside, 'external-sentinel.bin'), Buffer.from([0x00, 0xff, 0x41, 0x0a]));
    fs.writeFileSync(path.join(externalOperation, 'pending.removed'), 'preserve external tombstone\n');
    fs.symlinkSync(linkedTarget, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');

    const owner = acquireLock({ wikiRoot: root, operation: `linked-${linkedParent}-owner` });
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    const beforeExternal = snapshotTree(outside);
    const beforeState = state(root);
    const boundaries = [];
    let result;
    let observedError;
    try {
      result = promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId,
        now: new Date(T3),
        faultInjector(boundary) { boundaries.push(boundary); },
      });
    } catch (error) {
      observedError = error;
    }
    const afterExternal = snapshotTree(outside);
    const afterState = state(root);
    releaseLock({ wikiRoot: root, token: owner.token });

    assert.equal(observedError?.code, 'SCAN_WINDOW_FILESYSTEM', JSON.stringify({
      result,
      error: observedError && { code: observedError.code, message: observedError.message },
      boundaries,
    }));
    assert.deepEqual(boundaries, []);
    assert.deepEqual(afterExternal, beforeExternal);
    assert.deepEqual(afterState, beforeState);
  });
}

test('ensurePendingScan enforces its persistence deadline at journal, stage, destination, commit, and cleanup boundaries', async (t) => {
  const boundaries = [
    'after-transaction-activate',
    'after-stage-pending-after',
    'after-pending-rename',
    'after-scan-window-committed',
    'before-cleanup',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { ensurePendingScan, createDeadline } = modules();
      const root = temporaryWiki(`deep wiki persistence deadline ${boundary} `);
      const clock = makeClock();
      let advanced = false;
      const result = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ clock, budgetMs: 10 }),
        faultInjector(stage) {
          if (stage === boundary && !advanced) {
            advanced = true;
            clock.advance(10);
          }
        },
      });
      assert.equal(advanced, true);
      assert.deepEqual(result, { status: 'deferred', reason: 'DEADLINE_EXCEEDED' });
      assert.equal(fs.existsSync(metaPath(root, '.wiki-lock')), false);
      const journals = journalFiles(root);
      assert.equal(journals.length, 1);
      const interrupted = JSON.parse(fs.readFileSync(journals[0], 'utf8'));
      assert.equal(interrupted.transitions[0], 'scan-window-preflighted');
      assert.equal(interrupted.transitions.includes('cleaned'), false);

      const retryClock = makeClock();
      const retry = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ clock: retryClock, budgetMs: 10 }),
      });
      assert.equal(retry.status, 'created');
      assertState(root, { pending: `${T1}\n`, last: null });
      const recovered = JSON.parse(fs.readFileSync(journals[0], 'utf8'));
      assert.equal(recovered.transitions.at(-1), 'cleaned');
    });
  }
});

test('deadline deferral releases only the caller token and preserves a successor takeover', () => {
  const { ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock } = modules();
  const root = temporaryWiki('deep wiki deadline successor takeover ');
  const clock = makeClock();
  let successor;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ clock, budgetMs: 10 }),
    faultInjector(stage) {
      if (stage !== 'after-transaction-activate') return;
      clock.advance(10);
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'deadline-successor' });
    },
  });
  assert.deepEqual(result, { status: 'deferred', reason: 'DEADLINE_EXCEEDED' });
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'deadline-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('non-expired takeover after journal creation fences every later transaction metadata mutation', () => {
  const {
    ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki token successor after journal ');
  let successor;
  let transaction;
  let atTakeover;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage !== 'after-transaction-activate') return;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'journal-successor' });
      transaction = path.dirname(journalFiles(root)[0]);
      atTakeover = snapshotFlatDirectory(transaction);
    },
  });
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.deepEqual(snapshotFlatDirectory(transaction), atTakeover);
  assert.equal(Object.keys(atTakeover).filter((name) => name.startsWith('stage-')).length, 0);
  assert.deepEqual(JSON.parse(Buffer.from(atTakeover['journal.json'], 'base64')), {
    ...JSON.parse(Buffer.from(atTakeover['journal.json'], 'base64')),
    transitions: ['scan-window-preflighted'],
  });
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'journal-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('token takeover at every transaction publication and cleanup seam performs zero later metadata mutation', async (t) => {
  const boundaries = [
    'before-stage-pending-before-write',
    'before-stage-pending-after-write',
    'before-stage-last-before-write',
    'before-stage-last-after-write',
    'before-transition-scan-window-staged-write',
    'before-transition-last-scan-written-write',
    'before-transition-pending-scan-written-write',
    'before-transition-scan-window-committed-write',
    'before-stage-pending-before-remove',
    'before-stage-pending-after-remove',
    'before-stage-last-before-remove',
    'before-stage-last-after-remove',
    'before-tombstone-cleanup-remove',
    'before-transition-cleaned-write',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { promotePendingScan, acquireLock, recoverLock, assertLockOwner, releaseLock } = modules();
      const root = temporaryWiki(`deep wiki transaction token fence ${boundary} `);
      setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
      const operationId = `token-fence-${boundary}`;
      const transaction = metaPath(root, path.join('.transactions', operationId));
      const owner = acquireLock({ wikiRoot: root, operation: 'old-promoter' });
      let successor;
      let atTakeover;
      let injected = false;
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId,
        faultInjector(stage) {
          if (injected || stage !== boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `successor-${boundary}` });
          atTakeover = snapshotFlatDirectory(transaction);
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      assert.deepEqual(snapshotFlatDirectory(transaction), atTakeover);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `successor-${boundary}`);
      releaseLock({ wikiRoot: root, token: successor.token });
    });
  }
});

test('token takeover before default transaction-directory creation performs no directory mutation', () => {
  const {
    ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki transaction directory fence ');
  const transactions = metaPath(root, '.transactions');
  let successor;
  let injected = false;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage !== 'before-transaction-directory-create') return;
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'transaction-directory-successor' });
      assert.deepEqual(fs.readdirSync(transactions), []);
    },
  });
  assert.equal(injected, true);
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.deepEqual(fs.readdirSync(transactions), []);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'transaction-directory-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('old pending publication cannot overwrite a successor commit after temp identity validation', () => {
  const {
    ensurePendingScan, planScanWindowTransition, applyScanWindowTransition,
    createDeadline, acquireLock, assertLockOwner, releaseLock, recoverLock,
  } = modules();
  const root = temporaryWiki('deep wiki pending post-identity takeover ');
  setState(root, { last: `${T0}\n` });
  const originalLstat = fs.lstatSync;
  let injected = false;
  let successor;
  fs.lstatSync = function injectedLstat(pathname, options) {
    if (!injected && String(pathname).includes('.pending-scan.tmp.')) {
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'pending-successor' });
      const plan = planScanWindowTransition({ wikiRoot: root, kind: 'ensure', proposed: T2 });
      const committed = applyScanWindowTransition({
        wikiRoot: root,
        token: successor.token,
        plan,
        operationId: 'pending-successor-commit',
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      assert.equal(committed.status, 'created');
    }
    return originalLstat.call(fs, pathname, options);
  };
  let result;
  try {
    result = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(injected, true);
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.equal(readMaybe(metaPath(root, '.pending-scan')).toString('utf8'), `${T2}\n`);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'pending-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('transaction parent rejects reused dev and inode with a changed birth-time generation', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki transaction parent generation ');
  const meta = metaPath(root, '.');
  const originalLstat = fs.lstatSync;
  let changed = false;
  fs.lstatSync = function generationLstat(pathname, options) {
    const stat = originalLstat.call(fs, pathname, options);
    if (path.resolve(String(pathname)) !== path.resolve(meta) || options?.bigint !== true) return stat;
    return {
      ...stat,
      dev: 19n,
      ino: 23n,
      birthtimeNs: changed ? 200n : 100n,
    };
  };
  let result;
  try {
    result = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(stage) {
        if (stage === 'before-transaction-activate') changed = true;
      },
    });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.deepEqual(result, { status: 'deferred', reason: 'SCAN_WINDOW_FILESYSTEM' });
  assert.equal(readMaybe(metaPath(root, '.pending-scan')), null);
});

test('old last-scan publication cannot overwrite a successor repair after temp identity validation', () => {
  const {
    promotePendingScan, planScanWindowTransition, applyScanWindowTransition,
    acquireLock, assertLockOwner, releaseLock, recoverLock,
  } = modules();
  const root = temporaryWiki('deep wiki last post-identity takeover ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const oldOwner = acquireLock({ wikiRoot: root, operation: 'old-promoter' });
  const originalLstat = fs.lstatSync;
  let injected = false;
  let successor;
  fs.lstatSync = function injectedLstat(pathname, options) {
    if (!injected && String(pathname).includes('.last-scan.tmp.')) {
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'last-successor' });
      const pendingBytes = readMaybe(metaPath(root, '.pending-scan'));
      const plan = planScanWindowTransition({
        wikiRoot: root,
        kind: 'repair',
        pendingAfter: pendingBytes,
        lastAfter: Buffer.from(`${T2}\n`),
      });
      const committed = applyScanWindowTransition({
        wikiRoot: root,
        token: successor.token,
        plan,
        operationId: 'last-successor-commit',
      });
      assert.equal(committed.status, 'repaired');
    }
    return originalLstat.call(fs, pathname, options);
  };
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: oldOwner.token,
      expected: T1,
      operationId: 'old-promoter-commit',
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(injected, true);
  assert.equal(readMaybe(metaPath(root, '.last-scan')).toString('utf8'), `${T2}\n`);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'last-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('promotePendingScan requires the caller token, advances last monotonically, and clears only a full-string match', () => {
  const { acquireLock, releaseLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki promotion contract ');
  setState(root, { pending: `${T2}\n`, last: `${T0}\n` });
  assert.throws(() => promotePendingScan({
    wikiRoot: root, token: 'wrong', expected: T1, operationId: 'wrong-owner', now: new Date(T3),
  }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  const owner = acquireLock({ wikiRoot: root, operation: 'promote' });
  try {
    const result = promotePendingScan({
      wikiRoot: root, token: owner.token, expected: T1, operationId: 'preserve-newer', now: new Date(T3),
    });
    assert.equal(result.status, 'promoted');
    assert.equal(result.pendingPreserved, true);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assertState(root, { pending: `${T2}\n`, last: `${T1}\n` });
  promote(root, T2, 'clear-matching');
  assertState(root, { pending: null, last: `${T2}\n` });
  setState(root, { pending: `${T1}\n`, last: `${T3}\n` });
  promote(root, T1, 'never-regress');
  assertState(root, { pending: null, last: `${T3}\n` });
});

test('pending removal rechecks token ownership immediately before the destination rename', () => {
  const { acquireLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki pending removal takeover ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const owner = acquireLock({ wikiRoot: root, operation: 'promote' });
  const ownerPath = metaPath(root, path.join('.wiki-lock', 'owner.json'));
  const lockDir = metaPath(root, '.wiki-lock');
  const replacementToken = 'f'.repeat(64);
  let takeoverInjected = false;
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'pending-removal-forced-takeover',
      now: new Date(T3),
      faultInjector(stage) {
        if (stage !== 'before-matching-pending-destination-rename') return;
        takeoverInjected = true;
        const replacement = {
          ...JSON.parse(fs.readFileSync(ownerPath, 'utf8')),
          token: replacementToken,
          operation: 'forced-takeover',
        };
        fs.writeFileSync(ownerPath, `${JSON.stringify(replacement)}\n`);
      },
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(takeoverInjected, true);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(metaPath(root, '.pending-scan'), 'utf8'), `${T1}\n`);
  const journal = JSON.parse(fs.readFileSync(journalFiles(root)[0], 'utf8'));
  assert.equal(journal.transitions.includes('pending-scan-written'), false);
  assert.equal(journal.transitions.includes('scan-window-committed'), false);
});

test('scanner-first then promotion and promotion-first then scanner produce the two serial outcomes', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const scannerFirst = temporaryWiki('deep wiki scanner first ');
  setState(scannerFirst, { pending: `${T1}\n` });
  const before = readMaybe(metaPath(scannerFirst, '.pending-scan'));
  ensurePendingScan({
    wikiRoot: scannerFirst, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.deepEqual(readMaybe(metaPath(scannerFirst, '.pending-scan')), before);
  promote(scannerFirst, T1, 'scanner-first-promote');
  assertState(scannerFirst, { pending: null, last: `${T1}\n` });

  const promotionFirst = temporaryWiki('deep wiki promotion first ');
  setState(promotionFirst, { pending: `${T1}\n` });
  promote(promotionFirst, T1, 'promotion-first-promote');
  ensurePendingScan({
    wikiRoot: promotionFirst, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assertState(promotionFirst, { pending: `${T2}\n`, last: `${T1}\n` });
});

async function waitForFiles(files, timeoutMs = 5_000) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (files.every((file) => fs.existsSync(file))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${files.join(', ')}`);
}

function spawnRacer(root, mode, suffix, startFile) {
  const config = {
    mode,
    wikiRoot: root,
    proposed: mode === 'ensure' ? T2 : undefined,
    expected: mode === 'promote' ? T1 : undefined,
    operationId: mode === 'promote' ? `race-promote-${suffix}` : undefined,
    now: T3,
    timeoutMs: 10_000,
    startFile,
    readyFile: path.join(root, `${mode}-${suffix}.ready.json`),
    resultFile: path.join(root, `${mode}-${suffix}.result.json`),
  };
  const configPath = path.join(root, `${mode}-${suffix}.config.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const child = spawn(process.execPath, [racer, configPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, config, stdout: () => stdout, stderr: () => stderr };
}

for (const order of ['ensure-first', 'promote-first']) {
  test(`real process race is serializable with ${order} spawn order`, async () => {
    const root = temporaryWiki(`deep wiki process race ${order} `);
    setState(root, { pending: `${T1}\n` });
    const start = path.join(root, 'start.barrier');
    const firstMode = order === 'ensure-first' ? 'ensure' : 'promote';
    const secondMode = firstMode === 'ensure' ? 'promote' : 'ensure';
    const first = spawnRacer(root, firstMode, 'first', start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = spawnRacer(root, secondMode, 'second', start);
    await waitForFiles([first.config.readyFile, second.config.readyFile]);
    fs.writeFileSync(start, 'go\n');
    const [[firstCode], [secondCode]] = await Promise.all([once(first.child, 'exit'), once(second.child, 'exit')]);
    assert.equal(firstCode, 0, `${first.stdout()}\n${first.stderr()}`);
    assert.equal(secondCode, 0, `${second.stdout()}\n${second.stderr()}`);
    const firstResult = JSON.parse(fs.readFileSync(first.config.resultFile));
    const secondResult = JSON.parse(fs.readFileSync(second.config.resultFile));
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.notEqual(firstResult.result?.status, 'deferred', JSON.stringify(firstResult));
    assert.notEqual(secondResult.result?.status, 'deferred', JSON.stringify(secondResult));
    const final = state(root);
    const serialOne = final.last?.toString() === `${T1}\n` && final.pending === null;
    const serialTwo = final.last?.toString() === `${T1}\n` && final.pending?.toString() === `${T2}\n`;
    assert.equal(serialOne || serialTwo, true, JSON.stringify({
      last: final.last?.toString(), pending: final.pending?.toString(),
    }));
    assert.equal(fs.existsSync(metaPath(root, '.wiki-lock')), false);
    assert.equal(journalFiles(root).length, 2, JSON.stringify({ firstResult, secondResult }));
  });
}

const ensureFaults = [
  'after-transaction-activate',
  'after-stage-pending-before',
  'after-stage-pending-after',
  'after-stage-last-before',
  'after-stage-last-after',
  'before-pending-rename',
  'after-pending-rename',
  'after-scan-window-committed',
  'before-cleanup',
];

for (const faultPoint of ensureFaults) {
  test(`ensure crash/retry converges after ${faultPoint}`, () => {
    const { ensurePendingScan, createDeadline } = modules();
    const root = temporaryWiki(`deep wiki ensure fault ${faultPoint} `);
    const first = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      now: new Date(T1),
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(stage) {
        if (stage === faultPoint) {
          const error = new Error(`injected ${stage}`);
          error.code = 'INJECTED_CRASH';
          throw error;
        }
      },
    });
    assert.equal(first.status, 'deferred');
    const retry = ensurePendingScan({
      wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.notEqual(retry.status, 'deferred');
    assertState(root, { pending: `${T1}\n`, last: null });
    const journals = journalFiles(root);
    assert.equal(journals.length, 1);
    const journal = JSON.parse(fs.readFileSync(journals[0]));
    assert.equal(journal.transitions.at(-1), 'cleaned');
    assert.equal(new Set(journal.transitions).size, journal.transitions.length);
  });
}

const promoteFaults = [
  'after-transaction-activate',
  'after-stage-pending-before',
  'after-stage-pending-after',
  'after-stage-last-before',
  'after-stage-last-after',
  'before-last-scan-rename',
  'after-last-scan-rename',
  'before-matching-pending-remove',
  'after-matching-pending-remove',
  'after-scan-window-committed',
  'before-cleanup',
];

for (const faultPoint of promoteFaults) {
  test(`promotion crash/retry converges after ${faultPoint}`, () => {
    const { acquireLock, releaseLock, promotePendingScan } = modules();
    const root = temporaryWiki(`deep wiki promote fault ${faultPoint} `);
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    let owner = acquireLock({ wikiRoot: root, operation: 'promote' });
    try {
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `promote-fault-${faultPoint}`,
        now: new Date(T3),
        faultInjector(stage) {
          if (stage === faultPoint) {
            const error = new Error(`injected ${stage}`);
            error.code = 'INJECTED_CRASH';
            throw error;
          }
        },
      }), /injected/);
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    owner = acquireLock({ wikiRoot: root, operation: 'promote-retry' });
    try {
      const retry = promotePendingScan({
        wikiRoot: root, token: owner.token, expected: T1,
        operationId: `promote-fault-${faultPoint}`, now: new Date(T3),
      });
      assert.equal(retry.status, 'promoted');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assertState(root, { pending: null, last: `${T1}\n` });
    const journal = JSON.parse(fs.readFileSync(journalFiles(root)[0]));
    assert.equal(journal.transitions.at(-1), 'cleaned');
    assert.equal(new Set(journal.transitions).size, journal.transitions.length);
  });
}

test('same operation retry is byte-identical and an operation-id collision fails before mutation', () => {
  const root = temporaryWiki('deep wiki operation collision ');
  setState(root, { pending: `${T1}\n` });
  promote(root, T1, 'stable-operation');
  const afterFirst = state(root);
  const journal = journalFiles(root)[0];
  const journalAfterFirst = fs.readFileSync(journal);
  promote(root, T1, 'stable-operation');
  assert.deepEqual(state(root), afterFirst);
  assert.deepEqual(fs.readFileSync(journal), journalAfterFirst);
  setState(root, { pending: `${T2}\n`, last: `${T1}\n` });
  const beforeCollision = state(root);
  assert.throws(() => promote(root, T2, 'stable-operation'), (error) => error.code === 'OPERATION_ID_COLLISION');
  assert.deepEqual(state(root), beforeCollision);
  assert.equal(journalFiles(root).length, 1);
});

test('corrupt staged bytes require manual recovery and preserve both scan-window files', () => {
  const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
  const root = temporaryWiki('deep wiki corrupt stage ');
  setState(root, { last: `${T0}\n` });
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage === 'before-pending-rename') {
        const error = new Error('injected before rename');
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    },
  });
  assert.equal(result.status, 'deferred');
  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath));
  const txDir = path.dirname(journalPath);
  fs.writeFileSync(path.join(txDir, 'stage-pending-after.json'), 'corrupt\n');
  const before = state(root);
  const owner = acquireLock({ wikiRoot: root, operation: 'recover' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root, token: owner.token, operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), before);
});

test('recovery rejects a forged cleaned journal when recorded after bytes were never published', () => {
  const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
  const root = temporaryWiki('deep wiki forged cleaned journal ');
  setState(root, { last: `${T0}\n` });
  const interrupted = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage === 'before-pending-rename') {
        const error = new Error('injected before pending rename');
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    },
  });
  assert.equal(interrupted.status, 'deferred');
  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.transitions = [
    'scan-window-preflighted',
    'scan-window-staged',
    'pending-scan-written',
    'scan-window-committed',
    'cleaned',
  ];
  fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  const beforeState = state(root);
  const transactionDir = path.dirname(journalPath);
  const beforeTransaction = snapshotFlatDirectory(transactionDir);
  const owner = acquireLock({ wikiRoot: root, operation: 'recover-forged-cleaned' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), beforeState);
  assert.deepEqual(snapshotFlatDirectory(transactionDir), beforeTransaction);
});

test('recovery rejects a diverged unchanged target before writing a changed destination', () => {
  const { acquireLock, releaseLock, promotePendingScan, recoverScanWindowTransaction } = modules();
  const root = temporaryWiki('deep wiki diverged unchanged destination ');
  setState(root, { pending: `${T2}\n`, last: `${T0}\n` });
  let owner = acquireLock({ wikiRoot: root, operation: 'promote-interrupted' });
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'diverged-unchanged-target',
      now: new Date(T3),
      faultInjector(stage) {
        if (stage === 'before-last-scan-rename') {
          const error = new Error('injected before last rename');
          error.code = 'INJECTED_CRASH';
          throw error;
        }
      },
    }), /injected before last rename/);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  fs.writeFileSync(metaPath(root, '.pending-scan'), `${T3}\n`);
  const beforeState = state(root);
  const transactionDir = path.dirname(journalPath);
  const beforeTransaction = snapshotFlatDirectory(transactionDir);
  owner = acquireLock({ wikiRoot: root, operation: 'recover-diverged-unchanged' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), beforeState);
  assert.deepEqual(snapshotFlatDirectory(transactionDir), beforeTransaction);
});

test('journal recovery rejects canonical-input, schema, descriptor, hash, and transition mutations without destination writes', async (t) => {
  const mutations = [
    ['input hash', (journal) => { journal.input_sha256 = 'f'.repeat(64); }],
    ['canonical input', (journal) => {
      journal.input.proposed = T2;
      journal.input_sha256 = crypto.createHash('sha256').update(JSON.stringify(journal.input)).digest('hex');
    }],
    ['kind', (journal) => { journal.kind = 'foreign-kind'; }],
    ['result status', (journal) => { journal.result_status = 'foreign-status'; }],
    ['descriptor', (journal) => { journal.states.pending.after.sha256 = '0'.repeat(64); }],
    ['stage hash', (journal) => { journal.stage_sha256['pending-after'] = '0'.repeat(64); }],
    ['unknown transition', (journal) => { journal.transitions.push('foreign-transition'); }],
    ['duplicate transition', (journal) => { journal.transitions.push('scan-window-preflighted'); }],
    ['out-of-order transitions', (journal) => {
      journal.transitions = ['scan-window-preflighted', 'scan-window-committed', 'scan-window-staged'];
    }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
      const root = temporaryWiki(`deep wiki journal mutation ${name} `);
      setState(root, { last: `${T0}\n` });
      const interrupted = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(stage) {
          if (stage === 'before-pending-rename') {
            const error = new Error('injected before pending rename');
            error.code = 'INJECTED_CRASH';
            throw error;
          }
        },
      });
      assert.equal(interrupted.status, 'deferred');
      const journalPath = journalFiles(root)[0];
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.input ||= {
        wiki_root: root,
        kind: 'ensure',
        proposed: T1,
        expected: null,
        repair_pending_after: null,
        repair_last_after: null,
      };
      mutate(journal);
      fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
      const before = state(root);
      const owner = acquireLock({ wikiRoot: root, operation: 'recover-mutated-journal' });
      try {
        assert.throws(() => recoverScanWindowTransaction({
          wikiRoot: root,
          token: owner.token,
          operationId: journal.operation_id,
        }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.deepEqual(state(root), before);
    });
  }
});

function memoryJournalAdapter() {
  let journal = null;
  const stages = new Map();
  return {
    readJournal() { return journal ? structuredClone(journal) : null; },
    writeJournal(value) { journal = structuredClone(value); },
    readStage(name) { return stages.has(name) ? Buffer.from(stages.get(name)) : null; },
    writeStage(name, bytes) { stages.set(name, Buffer.from(bytes)); },
    removeStage(name) { stages.delete(name); },
    snapshot() { return { journal: structuredClone(journal), stages: new Map(stages) }; },
  };
}

for (const scenario of [
  {
    name: 'parent creation',
    boundary: 'before-tombstone-parent-create',
    seed(tombstone) {
      assert.equal(fs.existsSync(path.dirname(tombstone)), false);
    },
    verify(tombstone) {
      assert.equal(fs.existsSync(path.dirname(tombstone)), false);
    },
  },
  {
    name: 'existing-file removal',
    boundary: 'before-tombstone-prepare-remove',
    seed(tombstone) {
      fs.mkdirSync(path.dirname(tombstone), { recursive: true });
      fs.writeFileSync(tombstone, 'preserve-tombstone\n');
    },
    verify(tombstone) {
      assert.equal(fs.readFileSync(tombstone, 'utf8'), 'preserve-tombstone\n');
    },
  },
]) {
  test(`caller tombstone ${scenario.name} is token-fenced before filesystem mutation`, () => {
    const { acquireLock, releaseLock, recoverLock, promotePendingScan, assertLockOwner } = modules();
    const root = temporaryWiki(`deep wiki ${scenario.name} token fence `);
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    const adapter = memoryJournalAdapter();
    const tombstone = metaPath(root, path.join('.caller-tombstones', scenario.boundary, 'pending.removed'));
    adapter.tombstonePath = tombstone;
    scenario.seed(tombstone);
    const owner = acquireLock({ wikiRoot: root, operation: 'old-tombstone-owner' });
    let successor;
    let injected = false;
    try {
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `caller-${scenario.boundary}`,
        journalAdapter: adapter,
        faultInjector(stage) {
          if (stage !== scenario.boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `successor-${scenario.boundary}` });
          scenario.verify(tombstone);
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      scenario.verify(tombstone);
      assert.equal(fs.readFileSync(metaPath(root, '.pending-scan'), 'utf8'), `${T1}\n`);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `successor-${scenario.boundary}`);
    } finally {
      if (successor) releaseLock({ wikiRoot: root, token: successor.token });
      else {
        try { releaseLock({ wikiRoot: root, token: owner.token }); } catch { /* RED cleanup */ }
      }
    }
  });
}

test('journalAdapter embeds the same staged bytes and transition vocabulary for a caller-owned transaction', () => {
  const { acquireLock, releaseLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki journal adapter ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const adapter = memoryJournalAdapter();
  const owner = acquireLock({ wikiRoot: root, operation: 'outer-commit' });
  try {
    promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'outer-commit-operation',
      journalAdapter: adapter,
      now: new Date(T3),
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.journal.operation_id, 'outer-commit-operation');
  assert.equal(snapshot.journal.transitions.includes('scan-window-staged'), true);
  assert.equal(snapshot.journal.transitions.includes('scan-window-committed'), true);
  assert.equal(snapshot.journal.transitions.at(-1), 'cleaned');
  assert.equal(snapshot.stages.size, 0);
  assert.equal(journalFiles(root).length, 0);
  assertState(root, { pending: null, last: `${T1}\n` });
});

test('caller-owned journal adapters are token-fenced at write, transition, removal, and cleanup seams', async (t) => {
  const boundaries = [
    'before-stage-pending-before-write',
    'before-transition-scan-window-staged-write',
    'before-stage-pending-before-remove',
    'before-tombstone-cleanup-remove',
    'before-transition-cleaned-write',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { acquireLock, releaseLock, recoverLock, promotePendingScan, assertLockOwner } = modules();
      const root = temporaryWiki(`deep wiki caller adapter token fence ${boundary} `);
      setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
      const adapter = memoryJournalAdapter();
      const owner = acquireLock({ wikiRoot: root, operation: 'caller-adapter-old-owner' });
      let successor;
      let atTakeover;
      let injected = false;
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `caller-adapter-${boundary}`,
        journalAdapter: adapter,
        faultInjector(stage) {
          if (injected || stage !== boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `caller-successor-${boundary}` });
          atTakeover = adapter.snapshot();
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      assert.deepEqual(adapter.snapshot(), atTakeover);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `caller-successor-${boundary}`);
      releaseLock({ wikiRoot: root, token: successor.token });
    });
  }
});
