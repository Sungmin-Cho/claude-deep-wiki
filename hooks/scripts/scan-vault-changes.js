'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const {
  createDeadline,
  assertBeforeDeadline,
  remainingMs,
  DeadlineExceeded,
} = require('./runtime/deadline.js');
const { recoverLock: defaultRecoverLock } = require('./runtime/lock.js');
const { resolveConfig } = require('./runtime/config.js');
const { migrateAutoIngestPolicy } = require('./runtime/config-migration.js');

const PARENT_BUDGET_MS = 12_000;
const MIGRATION_BUDGET_MS = 2_000;
const WINDOWS_TERMINATION_RESERVE_MS = 1_250;
const PERSISTENCE_EXECUTION_RESERVE_MS = 750;
const SCAN_CUTOFF_RESERVE_MS = WINDOWS_TERMINATION_RESERVE_MS + PERSISTENCE_EXECUTION_RESERVE_MS;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const RESULT_KEYS = [
  'contract_version', 'status', 'detected_at', 'wiki_root', 'vault_root', 'total', 'files',
];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POLICY_SOURCES = new Set(['default', 'global_legacy', 'wiki_local', 'wiki_local_migrated']);
const terminationSleep = new Int32Array(new SharedArrayBuffer(4));

function codePointCompare(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(codePointCompare);
  const wanted = [...expected].sort(codePointCompare);
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000Z', 'Z') === value;
}

function validateResultBytes(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('worker result is not UTF-8');
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r')) {
    throw new Error('worker result must be exactly one newline-terminated JSON line');
  }
  const payload = text.slice(0, -1);
  let value;
  try { value = JSON.parse(payload); } catch { throw new Error('worker result is not JSON'); }
  if (!hasExactKeys(value, RESULT_KEYS)
      || value.contract_version !== 1
      || value.status !== 'ok'
      || !canonicalTimestamp(value.detected_at)
      || typeof value.wiki_root !== 'string'
      || typeof value.vault_root !== 'string'
      || !path.isAbsolute(value.wiki_root)
      || !path.isAbsolute(value.vault_root)
      || !Number.isSafeInteger(value.total)
      || value.total < 0
      || !Array.isArray(value.files)
      || value.files.length > 20
      || value.total < value.files.length) {
    throw new Error('worker result violates the scanner contract');
  }
  if (JSON.stringify(value) !== payload) {
    throw new Error('worker result must be canonical single-line JSON');
  }
  const seen = new Set();
  for (const file of value.files) {
    if (typeof file !== 'string' || file.length === 0 || file.includes('\0')
        || file.includes('\\') || path.posix.isAbsolute(file)
        || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')
        || path.posix.normalize(file) !== file || seen.has(file)) {
      throw new Error('worker result contains an invalid relative path');
    }
    seen.add(file);
  }
  const sorted = [...value.files].sort(codePointCompare);
  if (!value.files.every((file, index) => file === sorted[index])) {
    throw new Error('worker result files are not sorted');
  }
  return value;
}

function validatedTaskkillPath(env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('SystemRoot is unavailable');
  }
  const executable = path.win32.normalize(path.win32.join(systemRoot, 'System32', 'taskkill.exe'));
  const expected = path.win32.normalize(`${systemRoot}\\System32\\taskkill.exe`);
  if (executable.toLowerCase() !== expected.toLowerCase()) throw new Error('taskkill path is invalid');
  return executable;
}

function processIsAlive(pid, kill = process.kill) {
  try { kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function terminateWorkerTree(child, options = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const run = options.spawnSync || spawnSync;
  const isAlive = options.isAlive || ((pid) => processIsAlive(pid));
  if (platform === 'win32') {
    let result;
    try {
      result = run(validatedTaskkillPath(env), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        timeout: 1000,
      });
    } catch { return false; }
    if (!result || result.error || result.status !== 0) return false;
    const expiresAt = Date.now() + 250;
    while (isAlive(child.pid) && Date.now() < expiresAt) {
      Atomics.wait(terminationSleep, 0, 0, 5);
    }
    return !isAlive(child.pid);
  }
  try {
    (options.kill || process.kill)(-child.pid, 'SIGKILL');
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    try { return child.kill('SIGKILL') === true; } catch { return false; }
  }
}

function formatOutput(result) {
  if (result.total === 0) return '';
  const lines = result.files.map((file) => `  - ${file}`);
  if (result.total > result.files.length) {
    lines.push(`  - ... and ${result.total - result.files.length} more`);
  }
  return [
    `[deep-wiki] ${result.total}개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.`,
    '',
    '자동 ingest 대상:',
    '',
    ...lines,
    '',
    '이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. '
      + `vault 경로: ${result.vault_root}`,
    '',
  ].join('\n');
}

function formatSessionStartOutput(additionalContext) {
  if (!additionalContext) return '';
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  })}\n`;
}

function persistenceBudgets(deadline) {
  assertBeforeDeadline(deadline, 'scanner-supervisor-before-persistence-spawn');
  const budgetMs = Math.floor(remainingMs(deadline));
  if (budgetMs < SCAN_CUTOFF_RESERVE_MS) {
    throw new DeadlineExceeded('scanner-supervisor-before-persistence-spawn-reserve');
  }
  const workerBudgetMs = budgetMs - WINDOWS_TERMINATION_RESERVE_MS;
  if (workerBudgetMs < PERSISTENCE_EXECUTION_RESERVE_MS) {
    throw new DeadlineExceeded('scanner-supervisor-before-persistence-spawn-execution-reserve');
  }
  return { budgetMs: workerBudgetMs, workerBudgetMs };
}

function migrationBudgetMs(deadline) {
  assertBeforeDeadline(deadline, 'scanner-supervisor-before-config-migration');
  const budgetMs = Math.min(MIGRATION_BUDGET_MS, Math.floor(remainingMs(deadline) - SCAN_CUTOFF_RESERVE_MS));
  if (budgetMs < 1) throw new DeadlineExceeded('scanner-supervisor-before-config-migration-reserve');
  return budgetMs;
}

function scannerWorkerBudgetMs(deadline) {
  assertBeforeDeadline(deadline, 'scanner-supervisor-before-worker-spawn');
  const budgetMs = Math.floor(remainingMs(deadline) - SCAN_CUTOFF_RESERVE_MS);
  if (budgetMs < 1) throw new DeadlineExceeded('scanner-supervisor-before-worker-spawn-reserve');
  return budgetMs;
}

function validatePolicyProofShape(source, digest) {
  if (typeof source !== 'string' || !POLICY_SOURCES.has(source)) {
    throw new Error('policy proof source is invalid');
  }
  if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
    throw new Error('policy proof digest is invalid');
  }
}

function encodePolicySources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('policy source set is invalid');
  const seen = new Set();
  for (const source of sources) {
    if (typeof source !== 'string' || !POLICY_SOURCES.has(source) || seen.has(source)) {
      throw new Error('policy source set is invalid');
    }
    seen.add(source);
  }
  return sources.join(',');
}

function migrationPreconditionCanDefer(error, resolved) {
  return error?.code === 'CONFIG_INVALID'
    && resolved?.policy_source === 'global_legacy'
    && /wiki metadata directory cannot be inspected/.test(error.message || '');
}

function proofFromResolvedConfig(resolved, allowedSources = [resolved.policy_source]) {
  const source = resolved.policy_source;
  const digest = resolved.policy_digest;
  validatePolicyProofShape(source, digest);
  const allowed = encodePolicySources(allowedSources);
  if (!allowedSources.includes(source)) throw new Error('policy source set is invalid');
  return { source, allowed, digest };
}

function resolvePolicyProof({ env, deadline, migrationFaultInjector } = {}) {
  let resolved = resolveConfig(env);
  let allowedSources = [resolved.policy_source];
  if (resolved.migration_required) {
    let widenedForDeferral = false;
    let migrationBudget = 0;
    try { migrationBudget = migrationBudgetMs(deadline); } catch (error) {
      if (error?.code !== 'DEADLINE_EXCEEDED') throw error;
    }
    if (migrationBudget > 0) {
      const migrationDeadline = createDeadline({ clock: deadline.clock, budgetMs: migrationBudget });
      let migration;
      try {
        migration = migrateAutoIngestPolicy({
          env,
          wikiRoot: resolved.config.wikiRoot,
          deadline: migrationDeadline,
          faultInjector: migrationFaultInjector,
        });
      } catch (error) {
        if (!migrationPreconditionCanDefer(error, resolved)) throw error;
        migration = { status: 'deferred' };
      }
      if (!migration || !['already-local', 'migrated', 'deferred'].includes(migration.status)) {
        throw new Error('config migration returned an invalid status');
      }
      if (migration.status === 'deferred' && resolved.policy_source === 'global_legacy') {
        allowedSources = ['global_legacy', 'wiki_local_migrated'];
        widenedForDeferral = true;
      }
      resolved = resolveConfig(env);
      if (!widenedForDeferral) allowedSources = [resolved.policy_source];
    }
  }
  return proofFromResolvedConfig(resolved, allowedSources);
}

function runPersistenceWorker(result, deadline, options = {}) {
  const workerPath = options.persistWorkerPath
    || path.join(__dirname, 'scan-window-worker.js');
  const env = options.env || process.env;
  const terminate = options.terminateWorkerTree || terminateWorkerTree;
  const recover = options.recoverLock || defaultRecoverLock;
  if (typeof workerPath !== 'string' || !path.isAbsolute(workerPath)) {
    throw new TypeError('persistWorkerPath must be absolute');
  }
  const { budgetMs, workerBudgetMs } = persistenceBudgets(deadline);

  return new Promise((resolve, reject) => {
    let child;
    let terminal = false;
    let timer;

    const recoverBoundLock = () => {
      if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
      try {
        recover({
          wikiRoot: result.wiki_root,
          staleMs: 0,
          force: true,
          expectedPid: child.pid,
        });
      } catch { /* the original persistence failure remains authoritative */ }
    };

    const failAfterTermination = async (error) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      const alreadyClosed = child.exitCode !== null || child.signalCode !== null;
      const closed = alreadyClosed ? Promise.resolve() : once(child, 'close');
      let terminationConfirmed = false;
      try {
        terminationConfirmed = await Promise.resolve(terminate(child, { env }));
        if (terminationConfirmed) await closed;
      } catch {
        terminationConfirmed = false;
      }
      if (!terminationConfirmed) {
        reject(new Error('persistence worker tree termination was not confirmed', { cause: error }));
        return;
      }
      recoverBoundLock();
      reject(error);
    };

    try {
      child = spawn(process.execPath, [
        workerPath,
        '--wiki-root', result.wiki_root,
        '--proposed', result.detected_at,
        '--budget-ms', String(workerBudgetMs),
      ], {
        cwd: path.dirname(workerPath),
        env,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    timer = setTimeout(() => {
      void failAfterTermination(new Error('scan-window persistence worker timed out'));
    }, budgetMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      recoverBoundLock();
      reject(new Error('scan-window persistence worker failed'));
    });
  });
}

async function runSupervisor(options = {}) {
  const workerPath = options.workerPath || path.join(__dirname, 'scan-vault-worker.js');
  const timeoutMs = options.timeoutMs === undefined ? PARENT_BUDGET_MS : options.timeoutMs;
  const env = options.env || process.env;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PARENT_BUDGET_MS) {
    throw new RangeError('supervisor timeout must be from 1 through 12_000 milliseconds');
  }
  if (typeof workerPath !== 'string' || !path.isAbsolute(workerPath)) {
    throw new TypeError('workerPath must be absolute');
  }
  const deadline = createDeadline({ budgetMs: timeoutMs });
  const proof = resolvePolicyProof({ env, deadline, migrationFaultInjector: options.migrationFaultInjector });
  const workerBudgetMs = scannerWorkerBudgetMs(deadline);
  const result = await new Promise((resolve, reject) => {
    let child;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let terminal = false;
    let timer;
    let validatedResult = null;

    const fail = (error, terminate = true) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      if (terminate && !terminateWorkerTree(child, { env })) {
        reject(new Error('scanner worker tree termination was not confirmed', { cause: error }));
        return;
      }
      reject(error);
    };

    try {
      child = spawn(process.execPath, [workerPath], {
        cwd: path.dirname(workerPath),
        env: {
          ...env,
          DEEP_WIKI_EXPECTED_POLICY_SOURCE: proof.source,
          DEEP_WIKI_ALLOWED_POLICY_SOURCES: proof.allowed,
          DEEP_WIKI_EXPECTED_POLICY_SHA256: proof.digest,
          DEEP_WIKI_WORKER_BUDGET_MS: String(workerBudgetMs),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      fail(error, false);
      return;
    }
    timer = setTimeout(() => fail(new Error('scanner worker timed out')), workerBudgetMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      if (terminal) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES) fail(new Error('scanner stdout exceeded its cap'));
      else {
        stdout.push(chunk);
        if (Buffer.concat(stdout).includes(0x0a)) {
          try { validatedResult = validateResultBytes(Buffer.concat(stdout)); }
          catch (error) { fail(error); }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (terminal) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CAPTURE_BYTES) fail(new Error('scanner stderr exceeded its cap'));
      else fail(new Error('scanner worker wrote stderr'));
    });
    child.once('error', (error) => fail(error, false));
    child.once('close', (code, signal) => {
      if (terminal) return;
      clearTimeout(timer);
      if (code !== 0 || signal !== null || stderrBytes !== 0) {
        fail(new Error('scanner worker failed'));
        return;
      }
      try {
        const result = validatedResult || validateResultBytes(Buffer.concat(stdout));
        terminal = true;
        resolve(result);
      } catch (error) { fail(error); }
    });
  });

  assertBeforeDeadline(deadline, 'scanner-supervisor-before-persistence');
  if (Object.hasOwn(options, 'ensurePendingScan')) {
    if (typeof options.ensurePendingScan !== 'function') {
      throw new TypeError('ensurePendingScan must be a function');
    }
    const persisted = await Promise.resolve(options.ensurePendingScan({
      wikiRoot: result.wiki_root,
      proposed: result.detected_at,
      now: new Date(result.detected_at),
      deadline,
    }));
    if (!persisted || persisted.status === 'deferred') throw new Error('scan window persistence deferred');
  } else {
    await runPersistenceWorker(result, deadline, { ...options, env });
  }
  assertBeforeDeadline(deadline, 'scanner-supervisor-after-persistence');
  assertBeforeDeadline(deadline, 'scanner-supervisor-before-output');
  return formatOutput(result);
}

async function hookMain(options = {}) {
  const stdout = options.stdout || process.stdout;
  try {
    const output = await runSupervisor(options);
    if (output) stdout.write(formatSessionStartOutput(output));
  } catch { /* SessionStart hooks must never surface boundary failures */ }
  return 0;
}

if (require.main === module) {
  hookMain().then((status) => { process.exitCode = status; }, () => { process.exitCode = 0; });
}

module.exports = {
  PARENT_BUDGET_MS,
  MIGRATION_BUDGET_MS,
  SCAN_CUTOFF_RESERVE_MS,
  PERSISTENCE_EXECUTION_RESERVE_MS,
  WINDOWS_TERMINATION_RESERVE_MS,
  MAX_CAPTURE_BYTES,
  terminateWorkerTree,
  migrationBudgetMs,
  scannerWorkerBudgetMs,
  persistenceBudgets,
  runSupervisor,
  hookMain,
  formatSessionStartOutput,
};
