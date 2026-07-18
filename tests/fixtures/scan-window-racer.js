'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepArray, 0, 0, ms);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function acquireWithRetry(config, acquireLock) {
  const expires = Date.now() + (config.timeoutMs || 10_000);
  while (Date.now() < expires) {
    try {
      return acquireLock({ wikiRoot: config.wikiRoot, operation: 'scan-window-promote' });
    } catch (error) {
      if (error.code !== 'LOCK_CONTENDED') throw error;
      sleep(5);
    }
  }
  const error = new Error('lock contention deadline exceeded');
  error.code = 'LOCK_CONTENDED';
  throw error;
}

function main() {
  if (process.argv.length !== 3) throw new Error('usage: node scan-window-racer.js <config-json-path>');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  writeJson(config.readyFile, { pid: process.pid, mode: config.mode });
  while (!fs.existsSync(config.startFile)) sleep(5);

  const {
    ensurePendingScan,
    promotePendingScan,
  } = require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'scan-window.js'));
  const { createDeadline } = require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'deadline.js'));
  const { acquireLock, releaseLock } = require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'lock.js'));

  let result;
  if (config.mode === 'ensure') {
    result = ensurePendingScan({
      wikiRoot: config.wikiRoot,
      proposed: config.proposed,
      now: new Date(config.now || config.proposed),
      deadline: createDeadline({ budgetMs: config.timeoutMs || 10_000 }),
    });
  } else if (config.mode === 'promote') {
    const owner = acquireWithRetry(config, acquireLock);
    try {
      result = promotePendingScan({
        wikiRoot: config.wikiRoot,
        token: owner.token,
        expected: config.expected,
        operationId: config.operationId,
        now: new Date(config.now || config.expected),
      });
    } finally {
      releaseLock({ wikiRoot: config.wikiRoot, token: owner.token });
    }
  } else {
    throw new Error(`unsupported mode: ${config.mode}`);
  }
  writeJson(config.resultFile, { ok: true, result });
}

try {
  main();
} catch (error) {
  try {
    const configPath = process.argv[2];
    const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
    if (config?.resultFile) writeJson(config.resultFile, {
      ok: false,
      error: { code: error.code || 'ERROR', message: error.message },
    });
  } catch {
    // The child exit status remains the authoritative result if reporting fails.
  }
  process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
}
