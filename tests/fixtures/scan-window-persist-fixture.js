'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { acquireLock } = require('../../hooks/scripts/runtime/lock.js');
const { createDeadline } = require('../../hooks/scripts/runtime/deadline.js');
const { ensurePendingScan } = require('../../hooks/scripts/runtime/scan-window.js');

function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function environmentValue(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function absoluteEnvironmentPath(name) {
  const value = environmentValue(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.normalize(value);
}

const mode = environmentValue('PERSIST_FIXTURE_MODE');
if (!['success', 'hang-after-lock'].includes(mode)) {
  throw new Error(`unsupported PERSIST_FIXTURE_MODE: ${mode}`);
}

const wikiRoot = flagValue('--wiki-root');
const proposed = flagValue('--proposed');

if (mode === 'success') {
  const markerFile = absoluteEnvironmentPath('PERSIST_SUCCESS_MARKER_FILE');
  const result = ensurePendingScan({
    wikiRoot,
    proposed,
    now: new Date(proposed),
    deadline: createDeadline({ budgetMs: 10_000 }),
  });
  if (!result || result.status === 'deferred') process.exitCode = 2;
  else fs.writeFileSync(markerFile, String(process.pid));
} else {
  const pidFile = absoluteEnvironmentPath('PERSIST_LOCK_PID_FILE');
  acquireLock({ wikiRoot, operation: 'scan-window-ensure' });
  fs.writeFileSync(pidFile, String(process.pid));
  setTimeout(() => process.exit(70), 30_000).unref();
  setInterval(() => {}, 1000);
}
