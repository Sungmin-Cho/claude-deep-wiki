'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const mode = process.env.SCANNER_FIXTURE_MODE;
const result = process.env.SCANNER_RESULT_JSON || '{}';

function spawnGrandchild({ unref = false } = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  });
  if (process.env.SCANNER_GRANDCHILD_PID_FILE) {
    fs.writeFileSync(process.env.SCANNER_GRANDCHILD_PID_FILE, `${child.pid}\n`);
  }
  if (unref) child.unref();
  return child;
}

if (mode === 'valid') process.stdout.write(`${result}\n`);
else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'grandchild-hang') {
  spawnGrandchild();
  setInterval(() => {}, 1000);
} else if (mode === 'malformed-grandchild-hang') {
  spawnGrandchild();
  process.stdout.write('{malformed}\n');
  setInterval(() => {}, 1000);
} else if (mode === 'missing-grandchild-hang') {
  spawnGrandchild();
  setInterval(() => {}, 1000);
} else if (mode === 'nonzero-grandchild-hang') {
  spawnGrandchild();
  process.exitCode = 7;
} else if (mode === 'partial-grandchild-exit') {
  spawnGrandchild({ unref: true });
  process.stdout.write(result.slice(0, Math.max(1, Math.floor(result.length / 2))));
} else if (mode === 'missing-grandchild-exit') {
  spawnGrandchild({ unref: true });
} else if (mode === 'nonzero-grandchild-exit') {
  spawnGrandchild({ unref: true });
  process.exitCode = 7;
} else if (mode === 'partial') process.stdout.write(result.slice(0, Math.max(1, Math.floor(result.length / 2))));
else if (mode === 'stderr') {
  process.stderr.write('fixture stderr\n');
  process.stdout.write(`${result}\n`);
} else if (mode === 'malformed') process.stdout.write('{malformed}\n');
else if (mode === 'missing') { /* exit zero without a protocol result */ }
else if (mode === 'oversize') process.stdout.write(`${'x'.repeat(1024 * 1024 + 1)}\n`);
else if (mode === 'nonzero') process.exitCode = 7;
else throw new Error(`unsupported fixture mode: ${mode}`);
