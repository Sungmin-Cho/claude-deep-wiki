'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const supervisorPath = path.join(root, 'hooks', 'scripts', 'scan-vault-changes.js');
const workerPath = path.join(root, 'hooks', 'scripts', 'scan-vault-worker.js');
const fixturePath = path.join(__dirname, 'fixtures', 'scanner-worker-fixture.js');
const persistFixturePath = path.join(__dirname, 'fixtures', 'scan-window-persist-fixture.js');
const roots = new Set();

function temporaryRoot(prefix) {
  const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(value);
  return value;
}

test.after(() => {
  for (const value of roots) fs.rmSync(value, { recursive: true, force: true });
});

function validResult(base) {
  return {
    contract_version: 1,
    status: 'ok',
    detected_at: '2026-07-11T00:00:00Z',
    wiki_root: path.join(base, 'wiki'),
    vault_root: path.join(base, 'vault'),
    total: 2,
    files: ['notes/a.md', '한글 폴더/space note.md'],
  };
}

test('supervisor owns a 12-second cap and validates one exact newline-terminated result', async () => {
  const { PARENT_BUDGET_MS, MAX_CAPTURE_BYTES, runSupervisor } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor valid ');
  const result = validResult(base);
  const calls = [];
  const output = await runSupervisor({
    workerPath: fixturePath,
    timeoutMs: 1000,
    env: { ...process.env, SCANNER_FIXTURE_MODE: 'valid', SCANNER_RESULT_JSON: JSON.stringify(result) },
    ensurePendingScan(options) { calls.push(options); return { status: 'created' }; },
  });
  assert.equal(PARENT_BUDGET_MS, 12_000);
  assert.equal(MAX_CAPTURE_BYTES, 1024 * 1024);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wikiRoot, result.wiki_root);
  assert.equal(calls[0].proposed, result.detected_at);
  assert.match(output, /2개의 새로운\/수정된 파일/);
  assert.match(output, /한글 폴더\/space note\.md/);
});

test('hook boundary wraps detected files in the shared SessionStart JSON contract', async () => {
  const { hookMain } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor hook output ');
  const stdout = [];
  const status = await hookMain({
    workerPath: fixturePath,
    timeoutMs: 1000,
    env: {
      ...process.env,
      SCANNER_FIXTURE_MODE: 'valid',
      SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
    },
    ensurePendingScan() { return { status: 'created' }; },
    stdout: { write(value) { stdout.push(value); } },
  });

  assert.equal(status, 0);
  const output = JSON.parse(stdout.join(''));
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /2개의 새로운\/수정된 파일/);
  assert.match(output.hookSpecificOutput.additionalContext, /한글 폴더\/space note\.md/);
});

test('parent deadline remains authoritative through persistence and before output', async () => {
  const { runSupervisor } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor persistence deadline ');
  await assert.rejects(
    runSupervisor({
      workerPath: fixturePath,
      timeoutMs: 100,
      env: {
        ...process.env,
        SCANNER_FIXTURE_MODE: 'valid',
        SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
      },
      ensurePendingScan() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return { status: 'created' };
      },
    }),
    /deadline/i,
  );
});

for (const mode of ['hang', 'partial', 'stderr', 'malformed', 'missing', 'oversize', 'nonzero']) {
  test(`hook boundary is quiet exit-zero for ${mode} worker failure`, async () => {
    const { hookMain } = require(supervisorPath);
    const base = temporaryRoot(`deep wiki supervisor ${mode} `);
    const stdout = [];
    const stderr = [];
    let ensureCalls = 0;
    const status = await hookMain({
      workerPath: fixturePath,
      timeoutMs: mode === 'hang' ? 50 : 1000,
      env: {
        ...process.env,
        SCANNER_FIXTURE_MODE: mode,
        SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
      },
      ensurePendingScan() { ensureCalls += 1; return { status: 'created' }; },
      stdout: { write(value) { stdout.push(value); } },
      stderr: { write(value) { stderr.push(value); } },
    });
    assert.equal(status, 0);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, []);
    assert.equal(ensureCalls, 0);
  });
}

test('timeout kills the complete POSIX worker tree', { skip: process.platform === 'win32' }, async () => {
  const { hookMain } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor tree ');
  const pidFile = path.join(base, 'grandchild.pid');
  await hookMain({
    workerPath: fixturePath,
    timeoutMs: 100,
    env: {
      ...process.env,
      SCANNER_FIXTURE_MODE: 'grandchild-hang',
      SCANNER_GRANDCHILD_PID_FILE: pidFile,
    },
    ensurePendingScan() { throw new Error('must not persist'); },
    stdout: { write() { throw new Error('must stay quiet'); } },
    stderr: { write() { throw new Error('must stay quiet'); } },
  });
  assert.equal(fs.existsSync(pidFile), true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
});

test('persistence timeout kills its worker and reclaims only that worker lock', async () => {
  const { hookMain, terminateWorkerTree } = require(supervisorPath);
  const { recoverLock: recoverRuntimeLock } = require(path.join(
    root, 'hooks', 'scripts', 'runtime', 'lock.js',
  ));
  const base = temporaryRoot('deep wiki persistence worker timeout ');
  const result = validResult(base);
  const pidFile = path.join(base, 'persist-worker.pid');
  const events = [];
  fs.mkdirSync(result.wiki_root, { recursive: true });
  const env = {
    ...process.env,
    SCANNER_FIXTURE_MODE: 'valid',
    SCANNER_RESULT_JSON: JSON.stringify(result),
    PERSIST_FIXTURE_MODE: 'hang-after-lock',
    PERSIST_LOCK_PID_FILE: pidFile,
  };

  const status = await hookMain({
    workerPath: fixturePath,
    persistWorkerPath: persistFixturePath,
    timeoutMs: 2_000,
    env,
    async terminateWorkerTree(child, options) {
      const childPid = child.pid;
      events.push(['terminate-requested', childPid]);
      const closed = once(child, 'close').then(() => {
        events.push(['termination-confirmed', childPid]);
        return true;
      });
      assert.equal(terminateWorkerTree(child, { env, ...options }), true);
      return closed;
    },
    recoverLock(options) {
      events.push(['recover', options.expectedPid]);
      assert.equal(options.force, true);
      assert.equal(options.staleMs, 0);
      return recoverRuntimeLock(options);
    },
    stdout: { write() { throw new Error('must stay quiet'); } },
    stderr: { write() { throw new Error('must stay quiet'); } },
  });

  assert.equal(status, 0);
  assert.equal(fs.existsSync(pidFile), true);
  const workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.deepEqual(events, [
    ['terminate-requested', workerPid],
    ['termination-confirmed', workerPid],
    ['recover', workerPid],
  ]);
  assert.equal(fs.existsSync(path.join(result.wiki_root, '.wiki-meta', '.wiki-lock')), false);
});

test('persistence child success preserves exact hook stdout and releases its lock', async () => {
  const { hookMain } = require(supervisorPath);
  const base = temporaryRoot('deep wiki persistence worker success ');
  const result = validResult(base);
  const successMarker = path.join(base, 'persist-worker-success.pid');
  const stdout = [];
  fs.mkdirSync(result.wiki_root, { recursive: true });

  const status = await hookMain({
    workerPath: fixturePath,
    persistWorkerPath: persistFixturePath,
    timeoutMs: 2_000,
    env: {
      ...process.env,
      SCANNER_FIXTURE_MODE: 'valid',
      SCANNER_RESULT_JSON: JSON.stringify(result),
      PERSIST_FIXTURE_MODE: 'success',
      PERSIST_SUCCESS_MARKER_FILE: successMarker,
    },
    stdout: { write(value) { stdout.push(value); } },
    stderr: { write() { throw new Error('must stay quiet'); } },
  });

  const expectedContext = [
    '[deep-wiki] 2개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.',
    '',
    '자동 ingest 대상:',
    '',
    '  - notes/a.md',
    '  - 한글 폴더/space note.md',
    '',
    '이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. '
      + `vault 경로: ${result.vault_root}`,
    '',
  ].join('\n');
  const expectedStdout = `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: expectedContext,
    },
  })}\n`;

  assert.equal(status, 0);
  assert.equal(fs.existsSync(successMarker), true);
  const persistenceWitness = JSON.parse(fs.readFileSync(successMarker, 'utf8'));
  assert.equal(Number.isSafeInteger(persistenceWitness.pid), true);
  assert.ok(persistenceWitness.budgetMs > 0);
  assert.ok(persistenceWitness.budgetMs < 2_000);
  assert.equal(fs.readFileSync(path.join(result.wiki_root, '.wiki-meta', '.pending-scan'), 'utf8'),
    `${result.detected_at}\n`);
  assert.deepEqual(stdout, [expectedStdout]);
  assert.equal(fs.existsSync(path.join(result.wiki_root, '.wiki-meta', '.wiki-lock')), false);
});

for (const mode of ['malformed-grandchild-hang', 'missing-grandchild-hang', 'nonzero-grandchild-hang']) {
  test(`protocol failure kills the complete POSIX worker tree: ${mode}`, {
    skip: process.platform === 'win32',
  }, async () => {
    const { hookMain } = require(supervisorPath);
    const base = temporaryRoot(`deep wiki supervisor protocol tree ${mode} `);
    const pidFile = path.join(base, 'grandchild.pid');
    await hookMain({
      workerPath: fixturePath,
      timeoutMs: 150,
      env: {
        ...process.env,
        SCANNER_FIXTURE_MODE: mode,
        SCANNER_GRANDCHILD_PID_FILE: pidFile,
      },
      ensurePendingScan() { throw new Error('must not persist'); },
      stdout: { write() { throw new Error('must stay quiet'); } },
      stderr: { write() { throw new Error('must stay quiet'); } },
    });
    assert.equal(fs.existsSync(pidFile), true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  });
}

for (const mode of ['partial-grandchild-exit', 'missing-grandchild-exit', 'nonzero-grandchild-exit']) {
  test(`close-time protocol failure kills an orphaned POSIX worker tree: ${mode}`, {
    skip: process.platform === 'win32',
  }, async () => {
    const { hookMain } = require(supervisorPath);
    const base = temporaryRoot(`deep wiki supervisor close tree ${mode} `);
    const pidFile = path.join(base, 'grandchild.pid');
    let pid;
    try {
      await hookMain({
        workerPath: fixturePath,
        timeoutMs: 1000,
        env: {
          ...process.env,
          SCANNER_FIXTURE_MODE: mode,
          SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
          SCANNER_GRANDCHILD_PID_FILE: pidFile,
        },
        ensurePendingScan() { throw new Error('must not persist'); },
        stdout: { write() { throw new Error('must stay quiet'); } },
        stderr: { write() { throw new Error('must stay quiet'); } },
      });
      assert.equal(fs.existsSync(pidFile), true);
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
    } finally {
      if (Number.isSafeInteger(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ }
      }
    }
  });
}

test('Windows tree termination validates taskkill success and confirmed root exit', () => {
  const { terminateWorkerTree } = require(supervisorPath);
  const calls = [];
  const child = { pid: 4242 };
  const success = terminateWorkerTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, error: undefined };
    },
    isAlive() { return false; },
  });
  assert.equal(success, true);
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(calls[0].options.shell, false);

  const failure = terminateWorkerTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnSync() { return { status: 1, error: undefined }; },
    isAlive() { return true; },
  });
  assert.equal(failure, false);
});

test('worker checks its cooperative deadline after a blocking stat boundary', () => {
  const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
  const { scanVault } = require(workerPath);
  const originalRead = fs.readdirSync;
  const originalStat = fs.statSync;
  try {
    fs.readdirSync = () => [{
      name: 'late.md',
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
    }];
    fs.statSync = () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return { mtimeMs: 10_000 };
    };
    assert.throws(
      () => scanVault({
        vaultRoot: path.parse(root).root,
        wikiRoot: path.join(path.parse(root).root, 'wiki'),
        boundMs: 0,
        config: { autoIngest: { ignoreGlobs: [], requireTag: null } },
        deadline: createDeadline({ budgetMs: 1 }),
      }),
      (error) => error.code === 'DEADLINE_EXCEEDED',
    );
  } finally {
    fs.readdirSync = originalRead;
    fs.statSync = originalStat;
  }
});

test('persistence refuses a sub-millisecond remainder instead of dispatching equal budgets', () => {
  const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
  const { persistenceBudgets } = require(supervisorPath);
  let nowMs = 0;
  const clock = { nowMs: () => nowMs };
  const deadline = createDeadline({ clock, budgetMs: 1 });
  nowMs = 0.5;

  assert.throws(
    () => persistenceBudgets(deadline),
    (error) => error.code === 'DEADLINE_EXCEEDED',
  );
});

test('parent and worker never write scan-window files directly and child spawn is shell-free', () => {
  for (const file of [supervisorPath, workerPath]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /writeFile(?:Sync)?\([^\n]*(?:\.pending-scan|\.last-scan)/);
  }
  const supervisor = fs.readFileSync(supervisorPath, 'utf8');
  assert.match(supervisor, /shell:\s*false/);
  assert.match(supervisor, /taskkill\.exe/);
  assert.doesNotMatch(supervisor, /COMSPEC/);
});
