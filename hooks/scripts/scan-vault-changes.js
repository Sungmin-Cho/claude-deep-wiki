'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const {
  createDeadline,
  assertBeforeDeadline,
  remainingMs,
} = require('./runtime/deadline.js');
const { recoverLock: defaultRecoverLock } = require('./runtime/lock.js');

const PARENT_BUDGET_MS = 12_000;
const PERSISTENCE_GRACE_MS = 250;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const RESULT_KEYS = [
  'contract_version', 'status', 'detected_at', 'wiki_root', 'vault_root', 'total', 'files',
];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
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

function runPersistenceWorker(result, deadline, options = {}) {
  const workerPath = options.persistWorkerPath
    || path.join(__dirname, 'scan-window-worker.js');
  const env = options.env || process.env;
  const terminate = options.terminateWorkerTree || terminateWorkerTree;
  const recover = options.recoverLock || defaultRecoverLock;
  if (typeof workerPath !== 'string' || !path.isAbsolute(workerPath)) {
    throw new TypeError('persistWorkerPath must be absolute');
  }
  assertBeforeDeadline(deadline, 'scanner-supervisor-before-persistence-spawn');
  const budgetMs = Math.max(1, Math.min(PARENT_BUDGET_MS, Math.floor(remainingMs(deadline))));
  const workerBudgetMs = Math.max(1, budgetMs - PERSISTENCE_GRACE_MS);

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
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      fail(error, false);
      return;
    }
    timer = setTimeout(() => fail(new Error('scanner worker timed out')), timeoutMs);
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
  MAX_CAPTURE_BYTES,
  terminateWorkerTree,
  runSupervisor,
  hookMain,
  formatSessionStartOutput,
};
