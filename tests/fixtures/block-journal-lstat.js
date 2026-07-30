'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const blocked = process.env.DEEP_WIKI_TEST_BLOCK_LSTAT;
const snapshotWorker = path.basename(process.argv[1] || '') === 'wiki-snapshot-worker.js';
if (blocked && snapshotWorker) {
  if (process.env.DEEP_WIKI_TEST_INHERITED_DESCENDANT === '1'
      && process.env.DEEP_WIKI_TEST_IS_DESCENDANT !== '1') {
    const descendant = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 60_000)',
    ], {
      env: { ...process.env, DEEP_WIKI_TEST_IS_DESCENDANT: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
      shell: false,
      windowsHide: true,
    });
    fs.writeFileSync(process.env.DEEP_WIKI_TEST_DESCENDANT_PID_FILE, String(descendant.pid));
    descendant.unref();
  }
  const originalLstatSync = fs.lstatSync;
  const expected = path.resolve(blocked);
  fs.lstatSync = function blockingLstatSync(pathname, ...args) {
    const actual = path.resolve(String(pathname));
    const matches = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
    if (matches) {
      if (process.env.DEEP_WIKI_TEST_LSTAT_MODE === 'unreadable') {
        const error = new Error('fixture journal is unreadable');
        error.code = 'EACCES';
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return originalLstatSync.call(this, pathname, ...args);
  };
}
