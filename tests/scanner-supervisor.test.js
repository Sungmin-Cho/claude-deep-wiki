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

// SIGKILL is asynchronous: the signal is delivered, then the kernel reaps. A fixed sleep
// bets that the reap fits in it, and on a loaded CI runner that bet loses — these tests
// were red on `macos-15-intel` and green on three other runners. Poll for the reap
// instead. The contract is that the process dies, not that it dies inside 50 ms.
async function awaitReaped(pid, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new assert.AssertionError({
        message: `pid ${pid} still alive after ${budgetMs} ms — the worker tree was not killed`,
      });
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

function temporaryRoot(prefix) {
  const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(value);
  return value;
}

function writeYamlConfig(file, wikiRoot, autoIngest) {
  const lines = [
    `wiki_root: ${JSON.stringify(wikiRoot)}`,
    'obsidian_cli:',
    '  available: false',
  ];
  if (autoIngest) {
    lines.push('auto_ingest:');
    lines.push(`  ignore_globs: ${JSON.stringify(autoIngest.ignoreGlobs || [])}`);
    if (autoIngest.requireTag) lines.push(`  require_tag: ${JSON.stringify(autoIngest.requireTag)}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function writeLocalConfig(wikiRoot, autoIngest) {
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  const output = { auto_ingest: { ignore_globs: autoIngest.ignoreGlobs || [] } };
  if (autoIngest.requireTag) output.auto_ingest.require_tag = autoIngest.requireTag;
  fs.writeFileSync(path.join(wikiRoot, '.wiki-meta', '.config.json'), `${JSON.stringify(output, null, 2)}\n`);
}

function supervisorEnv(base, extra = {}, configOptions = {}) {
  const wikiRoot = configOptions.wikiRoot || path.join(base, 'policy-wiki');
  if (configOptions.createMeta !== false) fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  else fs.mkdirSync(wikiRoot, { recursive: true });
  const configPath = path.join(base, 'deep-wiki-config.yaml');
  writeYamlConfig(configPath, wikiRoot, configOptions.autoIngest);
  if (configOptions.localAutoIngest) writeLocalConfig(wikiRoot, configOptions.localAutoIngest);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: base,
    DEEP_WIKI_CONFIG: configPath,
    DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'inherited-garbage',
    DEEP_WIKI_EXPECTED_POLICY_SHA256: 'not-a-sha',
    ...extra,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return { env, wikiRoot, configPath };
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
    timeoutMs: 3_000,
    env: supervisorEnv(base, {
      SCANNER_FIXTURE_MODE: 'valid',
      SCANNER_RESULT_JSON: JSON.stringify(result),
    }).env,
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
    timeoutMs: 3_000,
    env: supervisorEnv(base, {
      SCANNER_FIXTURE_MODE: 'valid',
      SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
    }).env,
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
      timeoutMs: 3_000,
      env: supervisorEnv(base, {
        SCANNER_FIXTURE_MODE: 'valid',
        SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
      }).env,
      ensurePendingScan() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_100);
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
      timeoutMs: mode === 'hang' ? 2_050 : 3_000,
      env: supervisorEnv(base, {
        SCANNER_FIXTURE_MODE: mode,
        SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
      }).env,
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
    timeoutMs: 3_000,
    env: supervisorEnv(base, {
      SCANNER_FIXTURE_MODE: 'grandchild-hang',
      SCANNER_GRANDCHILD_PID_FILE: pidFile,
    }).env,
    ensurePendingScan() { throw new Error('must not persist'); },
    stdout: { write() { throw new Error('must stay quiet'); } },
    stderr: { write() { throw new Error('must stay quiet'); } },
  });
  assert.equal(fs.existsSync(pidFile), true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await awaitReaped(pid);
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
  const env = supervisorEnv(base, {
    SCANNER_FIXTURE_MODE: 'valid',
    SCANNER_RESULT_JSON: JSON.stringify(result),
    PERSIST_FIXTURE_MODE: 'hang-after-lock',
    PERSIST_LOCK_PID_FILE: pidFile,
  }).env;

  const status = await hookMain({
    workerPath: fixturePath,
    persistWorkerPath: persistFixturePath,
    timeoutMs: 3_000,
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
    timeoutMs: 3_000,
    env: {
      ...supervisorEnv(base).env,
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
      timeoutMs: 3_000,
      env: supervisorEnv(base, {
        SCANNER_FIXTURE_MODE: mode,
        SCANNER_GRANDCHILD_PID_FILE: pidFile,
      }).env,
      ensurePendingScan() { throw new Error('must not persist'); },
      stdout: { write() { throw new Error('must stay quiet'); } },
      stderr: { write() { throw new Error('must stay quiet'); } },
    });
    assert.equal(fs.existsSync(pidFile), true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await awaitReaped(pid);
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
        timeoutMs: 3_000,
        env: supervisorEnv(base, {
          SCANNER_FIXTURE_MODE: mode,
          SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
          SCANNER_GRANDCHILD_PID_FILE: pidFile,
        }).env,
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

test('supervisor migrates legacy auto-ingest before spawning and overwrites inherited policy proof', async () => {
  const { runSupervisor } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor migration proof ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'legacy', 'drop.md'), '# drop\n');
  fs.writeFileSync(path.join(vaultRoot, 'notes', 'keep.md'), '# keep\n');
  const { env } = supervisorEnv(base, {}, {
    wikiRoot,
    autoIngest: { ignoreGlobs: ['legacy/**'] },
  });

  const output = await runSupervisor({
    workerPath,
    timeoutMs: 12_000,
    env,
    ensurePendingScan() { return { status: 'created' }; },
  });

  assert.match(output, /notes\/keep\.md/);
  assert.doesNotMatch(output, /legacy\/drop\.md/);
  const localConfig = JSON.parse(fs.readFileSync(path.join(wikiRoot, '.wiki-meta', '.config.json'), 'utf8'));
  assert.deepEqual(localConfig.auto_ingest.ignore_globs, ['legacy/**']);
});

test('supervisor fails closed before worker spawn on hard wiki-local policy errors', async () => {
  const { runSupervisor } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor hard local error ');
  const wikiRoot = path.join(base, 'wiki');
  const { env } = supervisorEnv(base, {
    SCANNER_FIXTURE_MODE: 'valid',
    SCANNER_RESULT_JSON: JSON.stringify(validResult(base)),
  }, { wikiRoot, autoIngest: { ignoreGlobs: ['legacy/**'] } });
  fs.writeFileSync(path.join(wikiRoot, '.wiki-meta', '.config.json'), '{"auto_ingest":{"ignore_globs":[1]}}\n');
  let persisted = false;

  await assert.rejects(
    runSupervisor({
      workerPath: fixturePath,
      timeoutMs: 12_000,
      env,
      ensurePendingScan() { persisted = true; return { status: 'created' }; },
    }),
    /auto_ingest\.ignore_globs/,
  );
  assert.equal(persisted, false);
});

test('supervisor scans with validated legacy policy when migration is lock-deferred', async () => {
  const { runSupervisor } = require(supervisorPath);
  const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
  const base = temporaryRoot('deep wiki supervisor migration deferred ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'legacy', 'drop.md'), '# drop\n');
  fs.writeFileSync(path.join(vaultRoot, 'notes', 'keep.md'), '# keep\n');
  const { env } = supervisorEnv(base, {}, {
    wikiRoot,
    autoIngest: { ignoreGlobs: ['legacy/**'] },
  });
  const owner = acquireLock({ wikiRoot, operation: 'test-lock-defers-migration' });
  let persisted = false;
  try {
    const output = await runSupervisor({
      workerPath,
      timeoutMs: 12_000,
      env,
      ensurePendingScan() { persisted = true; return { status: 'created' }; },
    });
    assert.match(output, /notes\/keep\.md/);
    assert.doesNotMatch(output, /legacy\/drop\.md/);
    assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.config.json')), false);
    assert.equal(persisted, true);
  } finally {
    releaseLock({ wikiRoot, token: owner.token });
  }
});

test('worker rejects malformed or mismatched supervisor policy proof before walking the vault', () => {
  const { workerMain } = require(workerPath);
  const { canonicalPolicyDigest } = require('../hooks/scripts/runtime/config.js');
  const base = temporaryRoot('deep wiki worker proof ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'note.md'), '# note\n');
  const { env } = supervisorEnv(base, {}, { wikiRoot });
  const goodDigest = canonicalPolicyDigest({ ignoreGlobs: [], requireTag: null });
  const cases = [
    ['missing source', { DEEP_WIKI_EXPECTED_POLICY_SHA256: goodDigest }],
    ['malformed source', { DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'global_legacy,wiki_local', DEEP_WIKI_EXPECTED_POLICY_SHA256: goodDigest }],
    ['digest mismatch with valid allowed source set', {
      DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'default',
      DEEP_WIKI_ALLOWED_POLICY_SOURCES: 'default',
      DEEP_WIKI_EXPECTED_POLICY_SHA256: '0'.repeat(64),
    }],
  ];
  for (const [name, proof] of cases) {
    const originalEnv = process.env;
    const originalStdout = process.stdout.write;
    const originalReaddir = fs.readdirSync;
    let walked = false;
    const stdout = [];
    try {
      process.env = { ...env, ...proof };
      process.stdout.write = (value) => { stdout.push(value); return true; };
      fs.readdirSync = function readdirGuard(directory, options) {
        if (directory === vaultRoot) walked = true;
        return originalReaddir.call(this, directory, options);
      };
      assert.throws(() => workerMain(), /policy proof|policy source|policy digest/, name);
      assert.equal(walked, false, name);
      assert.deepEqual(stdout, [], name);
    } finally {
      fs.readdirSync = originalReaddir;
      process.stdout.write = originalStdout;
      process.env = originalEnv;
    }
  }
});

test('worker accepts a deferred migration proof when an equivalent local policy appears before scan', () => {
  const { workerMain } = require(workerPath);
  const { canonicalPolicyDigest } = require('../hooks/scripts/runtime/config.js');
  const base = temporaryRoot('deep wiki worker equivalent convergence ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'legacy', 'drop.md'), '# drop\n');
  fs.writeFileSync(path.join(vaultRoot, 'notes', 'keep.md'), '# keep\n');
  writeLocalConfig(wikiRoot, { ignoreGlobs: ['legacy/**'] });
  const digest = canonicalPolicyDigest({ ignoreGlobs: ['legacy/**'], requireTag: null });
  const { env } = supervisorEnv(base, {
    DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'global_legacy',
    DEEP_WIKI_ALLOWED_POLICY_SOURCES: 'global_legacy,wiki_local_migrated',
    DEEP_WIKI_EXPECTED_POLICY_SHA256: digest,
  }, {
    wikiRoot,
    autoIngest: { ignoreGlobs: ['legacy/**'] },
  });
  const originalEnv = process.env;
  const originalStdout = process.stdout.write;
  const stdout = [];
  try {
    process.env = env;
    process.stdout.write = (value) => { stdout.push(value); return true; };
    workerMain();
  } finally {
    process.stdout.write = originalStdout;
    process.env = originalEnv;
  }
  const result = JSON.parse(stdout.join('').trim());
  assert.deepEqual(result.files, ['notes/keep.md']);
});

test('worker rejects disallowed policy source transitions even when the digest matches', () => {
  const { workerMain } = require(workerPath);
  const { canonicalPolicyDigest } = require('../hooks/scripts/runtime/config.js');
  const base = temporaryRoot('deep wiki worker disallowed source ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'note.md'), '# note\n');
  writeLocalConfig(wikiRoot, { ignoreGlobs: [] });
  const digest = canonicalPolicyDigest({ ignoreGlobs: [], requireTag: null });
  const { env } = supervisorEnv(base, {
    DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'global_legacy',
    DEEP_WIKI_ALLOWED_POLICY_SOURCES: 'global_legacy',
    DEEP_WIKI_EXPECTED_POLICY_SHA256: digest,
  }, {
    wikiRoot,
    autoIngest: { ignoreGlobs: [] },
  });
  const originalEnv = process.env;
  const originalStdout = process.stdout.write;
  try {
    process.env = env;
    process.stdout.write = () => { throw new Error('must not publish'); };
    assert.throws(() => workerMain(), /policy source transition/);
  } finally {
    process.stdout.write = originalStdout;
    process.env = originalEnv;
  }
});

test('supervisor passes the parent-cutoff worker budget to the child environment', async () => {
  const { runSupervisor } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor child budget ');
  const result = validResult(base);
  fs.mkdirSync(result.wiki_root, { recursive: true });
  const budgetFile = path.join(base, 'worker-budget.txt');
  const budgetWorker = path.join(base, 'budget-worker.js');
  fs.writeFileSync(budgetWorker, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(budgetFile)}, String(process.env.DEEP_WIKI_WORKER_BUDGET_MS || ''));`,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)});`,
  ].join('\n'));

  await runSupervisor({
    workerPath: budgetWorker,
    timeoutMs: 12_000,
    env: supervisorEnv(base).env,
    ensurePendingScan() { return { status: 'created' }; },
  });

  const childBudget = Number(fs.readFileSync(budgetFile, 'utf8'));
  assert.equal(Number.isSafeInteger(childBudget), true);
  assert.ok(childBudget > 0);
  assert.ok(childBudget < 11_000);
});

test('worker uses the supervisor-provided cooperative budget instead of its default 11 seconds', () => {
  const { workerMain } = require(workerPath);
  const { canonicalPolicyDigest } = require('../hooks/scripts/runtime/config.js');
  const base = temporaryRoot('deep wiki worker env budget ');
  const vaultRoot = path.join(base, 'vault');
  const wikiRoot = path.join(vaultRoot, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'late.md'), '# late\n');
  const digest = canonicalPolicyDigest({ ignoreGlobs: [], requireTag: null });
  const { env } = supervisorEnv(base, {
    DEEP_WIKI_EXPECTED_POLICY_SOURCE: 'default',
    DEEP_WIKI_ALLOWED_POLICY_SOURCES: 'default',
    DEEP_WIKI_EXPECTED_POLICY_SHA256: digest,
    DEEP_WIKI_WORKER_BUDGET_MS: '1',
  }, { wikiRoot });
  const originalEnv = process.env;
  const originalStat = fs.statSync;
  const originalStdout = process.stdout.write;
  try {
    process.env = env;
    fs.statSync = function slowStat(...args) {
      if (args[0] === path.join(vaultRoot, 'late.md')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      return originalStat.apply(this, args);
    };
    process.stdout.write = () => { throw new Error('must not publish'); };
    assert.throws(() => workerMain(), (error) => error.code === 'DEADLINE_EXCEEDED');
  } finally {
    process.stdout.write = originalStdout;
    fs.statSync = originalStat;
    process.env = originalEnv;
  }
});

test('migration, scanner child, persistence timeout, termination, and close latency stay inside the parent bound', async () => {
  const { hookMain, terminateWorkerTree } = require(supervisorPath);
  const base = temporaryRoot('deep wiki supervisor latency envelope ');
  const result = validResult(base);
  const pidFile = path.join(base, 'persist-worker.pid');
  const events = [];
  fs.mkdirSync(path.join(result.wiki_root, '.wiki-meta'), { recursive: true });
  const env = supervisorEnv(base, {
    SCANNER_FIXTURE_MODE: 'valid',
    SCANNER_RESULT_JSON: JSON.stringify(result),
    PERSIST_FIXTURE_MODE: 'hang-after-lock',
    PERSIST_LOCK_PID_FILE: pidFile,
  }, {
    wikiRoot: result.wiki_root,
    autoIngest: { ignoreGlobs: ['legacy/**'] },
  }).env;
  const started = Date.now();
  const status = await hookMain({
    workerPath: fixturePath,
    persistWorkerPath: persistFixturePath,
    timeoutMs: 12_000,
    env,
    migrationFaultInjector(boundary) {
      if (boundary === 'before-rename') {
        events.push('migration-delay');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    },
    async terminateWorkerTree(child, options) {
      events.push('terminate-requested');
      const closed = once(child, 'close').then(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        events.push('termination-confirmed-with-close-latency');
        return true;
      });
      assert.equal(terminateWorkerTree(child, { env, ...options }), true);
      return closed;
    },
    stdout: { write() { throw new Error('must stay quiet after persistence timeout'); } },
    stderr: { write() { throw new Error('must stay quiet'); } },
  });

  const elapsed = Date.now() - started;
  assert.equal(status, 0);
  assert.ok(fs.existsSync(pidFile), 'persistence worker must have started');
  assert.deepEqual(events, [
    'migration-delay',
    'terminate-requested',
    'termination-confirmed-with-close-latency',
  ]);
  assert.ok(elapsed < 12_000, `elapsed ${elapsed}ms exceeded the original parent bound`);
});

test('parent-anchored deadline arithmetic preserves migration, scan, termination, and persistence reserves', () => {
  const {
    MIGRATION_BUDGET_MS,
    SCAN_CUTOFF_RESERVE_MS,
    PERSISTENCE_EXECUTION_RESERVE_MS,
    WINDOWS_TERMINATION_RESERVE_MS,
    migrationBudgetMs,
    scannerWorkerBudgetMs,
    persistenceBudgets,
  } = require(supervisorPath);
  const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
  let nowMs = 0;
  const deadline = createDeadline({ clock: { nowMs: () => nowMs }, budgetMs: 12_000 });

  assert.equal(MIGRATION_BUDGET_MS, 2_000);
  assert.equal(SCAN_CUTOFF_RESERVE_MS, 2_000);
  assert.equal(WINDOWS_TERMINATION_RESERVE_MS, 1_250);
  assert.equal(PERSISTENCE_EXECUTION_RESERVE_MS, 750);
  assert.equal(WINDOWS_TERMINATION_RESERVE_MS + PERSISTENCE_EXECUTION_RESERVE_MS, SCAN_CUTOFF_RESERVE_MS);
  assert.equal(migrationBudgetMs(deadline), 2_000);
  nowMs = 2_000;
  assert.equal(scannerWorkerBudgetMs(deadline), 8_000);
  nowMs = 10_000;
  assert.deepEqual(persistenceBudgets(deadline), { budgetMs: 750, workerBudgetMs: 750 });
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
