'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const repoRoot = path.resolve(__dirname, '..');
const runtimePath = path.join(repoRoot, 'scripts', 'wiki-runtime.js');
const blockerPath = path.join(__dirname, 'fixtures', 'block-journal-lstat.js');
const workerFixturePath = path.join(__dirname, 'fixtures', 'snapshot-worker-fixture.js');
const roots = new Set();
const files = new Set();

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki snapshot deadline ')));
  roots.add(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  for (const file of files) fs.rmSync(file, { force: true });
});

function treeBytes(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      entries.push([relative, entry.isDirectory() ? null : fs.readFileSync(absolute).toString('base64')]);
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(root);
  return entries;
}

function terminateCliTree(child) {
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    spawnSync(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), [
      '/PID', String(child.pid), '/T', '/F',
    ], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: 2_000,
    });
  } else {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const expiresAt = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsAlive(pid);
}

function killFixtureTree(child) {
  if (!child || !Number.isSafeInteger(child.pid)) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function fixtureWorkerOptions(root, mode, options = {}) {
  return {
    wikiRoot: root,
    timeoutMs: 1_000,
    workerPath: workerFixturePath,
    env: {
      ...process.env,
      SNAPSHOT_WORKER_FIXTURE_MODE: mode,
    },
    ...options,
  };
}

function runSnapshotCli({ wikiRoot, journal, descendantPidFile, outerTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      runtimePath,
      'snapshot',
      '--wiki-root', wikiRoot,
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${blockerPath}`.trim(),
        DEEP_WIKI_TEST_BLOCK_LSTAT: journal,
        DEEP_WIKI_TEST_INHERITED_DESCENDANT: '1',
        DEEP_WIKI_TEST_DESCENDANT_PID_FILE: descendantPidFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateCliTree(child);
    }, outerTimeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

test('snapshot CLI deadline returns without awaiting a blocked worker close and preserves recovery evidence', {
  timeout: 20_000,
}, async () => {
  const root = fixture();
  const transaction = path.join(
    root,
    '.wiki-meta',
    '.transactions',
    'scan-window-ensure-01KYSNQQ54KHPBDTYHP48JJHQ2',
  );
  const journal = path.join(transaction, 'journal.json');
  const bytes = Buffer.from(JSON.stringify({
    engine: 'scan-window',
    transitions: ['scan-window-committed'],
  }));
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(journal, bytes);
  const before = treeBytes(root);
  const descendantPidFile = `${root}.snapshot-descendant.pid`;
  files.add(descendantPidFile);

  const startedAt = Date.now();
  const result = await runSnapshotCli({
    wikiRoot: root,
    journal,
    descendantPidFile,
    outerTimeoutMs: 15_000,
  });
  assert.equal(result.timedOut, false, 'CLI must beat the independent 15-second wall-time');
  assert.equal(result.code, 5);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^DEADLINE_EXCEEDED: /);
  assert.match(result.stderr, /stop all hosts/i);
  assert.match(result.stderr, /restore filesystem readability/i);
  assert.match(
    result.stderr,
    /termination (?:requested but unconfirmed|could not be requested or confirmed)/i,
  );
  assert.ok(Date.now() - startedAt < 15_000, 'snapshot CLI must return instead of hanging');
  assert.deepEqual(fs.readFileSync(journal), bytes, 'read-only timeout must preserve the blocked journal');
  assert.deepEqual(treeBytes(root), before, 'read-only timeout must preserve the complete wiki tree');
  assert.equal(fs.existsSync(descendantPidFile), true, 'blocked worker must record its descendant');
  const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
  assert.equal(
    await waitForExit(descendantPid),
    true,
    'snapshot timeout must terminate the inherited worker descendant',
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(treeBytes(root), before, 'terminated descendants must not mutate the wiki later');

  const { runSnapshotWorker } = require(runtimePath);
  const snapshot = await runSnapshotWorker({ wikiRoot: root, timeoutMs: 2_000 });
  assert.deepEqual(snapshot.pages, []);
  assert.deepEqual(snapshot.events, []);
});

test('snapshot turns an unreadable transaction journal into recovery-required without mutation', async () => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();
  const transaction = path.join(
    root,
    '.wiki-meta',
    '.transactions',
    'scan-window-ensure-01KYSNQQ54KHPBDTYHP48JJHQ3',
  );
  const journal = path.join(transaction, 'journal.json');
  const bytes = Buffer.from('unreadable journal evidence\n');
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(journal, bytes);

  await assert.rejects(
    runSnapshotWorker({
      wikiRoot: root,
      timeoutMs: 2_000,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${blockerPath}`.trim(),
        DEEP_WIKI_TEST_BLOCK_LSTAT: journal,
        DEEP_WIKI_TEST_LSTAT_MODE: 'unreadable',
      },
    }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && /restore filesystem readability/i.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(journal), bytes);
});

test('snapshot worker protocol rejects malformed and multiple-line output', async (t) => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();

  await t.test('malformed JSON', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'malformed')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /invalid JSON/i.test(error.message),
    );
  });

  await t.test('multiple result lines', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'multiline')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /multiple result lines/i.test(error.message),
    );
  });
});

test('snapshot worker protocol requires exact envelope and exit agreement', async (t) => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();

  await t.test('success envelope with nonzero exit', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'success-nonzero')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /violates its contract/i.test(error.message),
    );
  });

  await t.test('error envelope with wrong exit', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'error-wrong-exit')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /error violates its contract/i.test(error.message),
    );
  });

  await t.test('signal termination', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'signal')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /terminated by SIGTERM/i.test(error.message),
    );
  });
});

test('snapshot worker protocol rejects stderr and caps both output streams incrementally', async (t) => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();

  await t.test('stderr', async () => {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'stderr')),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM'
        && /wrote stderr/i.test(error.message),
    );
  });

  for (const stream of ['stdout', 'stderr']) {
    await t.test(`${stream} cap`, async () => {
      await assert.rejects(
        runSnapshotWorker(fixtureWorkerOptions(root, `oversize-${stream}`, {
          maxOutputBytes: 128,
        })),
        (error) => error.code === 'WIKI_STATE_FILESYSTEM'
          && new RegExp(`${stream} exceeded its cap`, 'i').test(error.message),
      );
    });
  }
});

test('snapshot timeout returns promptly when termination cannot be requested or confirmed', async () => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();
  let child;
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'hang', {
        timeoutMs: 300,
        platform: 'linux',
        spawn(...args) {
          child = spawn(...args);
          return child;
        },
        terminateWorkerTree() {
          return false;
        },
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && /termination could not be requested or confirmed/i.test(error.message),
    );
    assert.ok(Date.now() - startedAt < 1_000, 'timeout must not await worker close');
    assert.equal(processIsAlive(child.pid), true, 'unconfirmed adapter leaves cleanup to the caller');
  } finally {
    killFixtureTree(child);
    if (child) await waitForExit(child.pid);
  }
});

test('snapshot Windows deadline does not await a never-closing native terminator', async () => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();
  const terminator = new EventEmitter();
  let child;
  let launch;
  let terminatorUnrefCount = 0;
  terminator.unref = () => { terminatorUnrefCount += 1; };
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'hang', {
        timeoutMs: 300,
        platform: 'win32',
        env: {
          ...process.env,
          SystemRoot: 'C:\\Windows',
          SNAPSHOT_WORKER_FIXTURE_MODE: 'hang',
        },
        spawn(...args) {
          child = spawn(...args);
          return child;
        },
        spawnWindowsTerminator(file, args, options) {
          launch = { file, args, options };
          return terminator;
        },
        terminateWorkerTree() {
          return false;
        },
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && /termination requested but unconfirmed/i.test(error.message),
    );
    assert.ok(Date.now() - startedAt < 1_000, 'timeout must not await terminator close');
    assert.deepEqual(launch, {
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', String(child.pid), '/T', '/F'],
      options: {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      },
    });
    assert.equal(terminatorUnrefCount, 1);
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    if (child) await waitForExit(child.pid);
  }
});

test('snapshot Windows termination launch failure is explicitly unrequested and unconfirmed', async () => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();
  let child;

  try {
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'hang', {
        timeoutMs: 300,
        platform: 'win32',
        env: {
          ...process.env,
          SystemRoot: 'C:\\Windows',
          SNAPSHOT_WORKER_FIXTURE_MODE: 'hang',
        },
        spawn(...args) {
          child = spawn(...args);
          return child;
        },
        spawnWindowsTerminator() {
          throw new Error('fixture taskkill launch failure');
        },
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && /worker tree termination could not be requested or confirmed;/i.test(error.message),
    );
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    if (child) await waitForExit(child.pid);
  }
});

test('snapshot native Windows deadline uses production taskkill for the worker descendant', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  const root = fixture();
  const transaction = path.join(
    root,
    '.wiki-meta',
    '.transactions',
    'scan-window-ensure-01KYSNQQ54KHPBDTYHP48JJHQ4',
  );
  const journal = path.join(transaction, 'journal.json');
  const bytes = Buffer.from(JSON.stringify({
    engine: 'scan-window',
    transitions: ['scan-window-committed'],
  }));
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(journal, bytes);
  const before = treeBytes(root);
  const descendantPidFile = `${root}.native-windows-snapshot-descendant.pid`;
  files.add(descendantPidFile);

  const startedAt = Date.now();
  const result = await runSnapshotCli({
    wikiRoot: root,
    journal,
    descendantPidFile,
    outerTimeoutMs: 15_000,
  });
  assert.equal(result.timedOut, false, 'CLI must beat the independent 15-second wall-time');
  assert.equal(result.code, 5);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^DEADLINE_EXCEEDED: /);
  assert.match(result.stderr, /worker tree termination requested but unconfirmed;/i);
  assert.ok(Date.now() - startedAt < 15_000, 'snapshot CLI must return instead of hanging');
  assert.deepEqual(fs.readFileSync(journal), bytes, 'read-only timeout must preserve the blocked journal');
  assert.deepEqual(treeBytes(root), before, 'read-only timeout must preserve the complete wiki tree');
  assert.equal(fs.existsSync(descendantPidFile), true, 'blocked worker must record its descendant');
  const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
  assert.equal(
    await waitForExit(descendantPid, 5_000),
    true,
    'production taskkill /T must eventually reap the inherited worker descendant',
  );
});

test('snapshot timeout reports conservative POSIX and Windows termination states', async (t) => {
  const { runSnapshotWorker } = require(runtimePath);
  const root = fixture();

  await t.test('POSIX termination remains unconfirmed', async () => {
    let child;
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'hang', {
        timeoutMs: 300,
        platform: 'linux',
        spawn(...args) {
          child = spawn(...args);
          return child;
        },
        terminateWorkerTree(target, options) {
          assert.equal(options.platform, 'linux');
          killFixtureTree(target);
          return true;
        },
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && /termination requested but unconfirmed/i.test(error.message),
    );
    if (child) await waitForExit(child.pid);
  });

  await t.test('Windows termination request remains unconfirmed', async () => {
    let child;
    const terminator = new EventEmitter();
    terminator.unref = () => {};
    await assert.rejects(
      runSnapshotWorker(fixtureWorkerOptions(root, 'hang', {
        timeoutMs: 300,
        platform: 'win32',
        env: {
          ...process.env,
          SystemRoot: 'C:\\Windows',
          SNAPSHOT_WORKER_FIXTURE_MODE: 'hang',
        },
        spawn(...args) {
          child = spawn(...args);
          return child;
        },
        spawnWindowsTerminator(file, args, options) {
          assert.equal(file, 'C:\\Windows\\System32\\taskkill.exe');
          assert.deepEqual(args, ['/PID', String(child.pid), '/T', '/F']);
          assert.equal(options.shell, false);
          child.kill('SIGKILL');
          return terminator;
        },
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && /worker tree termination requested but unconfirmed;/i.test(error.message),
    );
    if (child) await waitForExit(child.pid);
  });
});
