#!/usr/bin/env node
'use strict';

const mode = process.env.SNAPSHOT_WORKER_FIXTURE_MODE;
const success = JSON.stringify({
  contract_version: 1,
  status: 'ok',
  snapshot: { pages: [], events: [] },
});
const failure = JSON.stringify({
  contract_version: 1,
  status: 'error',
  error: {
    code: 'TRANSACTION_RECOVERY_REQUIRED',
    message: 'fixture recovery is required',
  },
});

switch (mode) {
  case 'malformed':
    process.stdout.write('not-json\n');
    break;
  case 'multiline':
    process.stdout.write(`${success}\n`);
    setImmediate(() => process.stdout.write(`${success}\n`));
    break;
  case 'success-nonzero':
    process.stdout.write(`${success}\n`);
    process.exitCode = 7;
    break;
  case 'error-wrong-exit':
    process.stdout.write(`${failure}\n`);
    break;
  case 'signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'stderr':
    process.stderr.write('fixture diagnostic\n');
    break;
  case 'oversize-stdout':
    process.stdout.write(Buffer.alloc(1_024, 0x78));
    setInterval(() => {}, 60_000);
    break;
  case 'oversize-stderr':
    process.stderr.write(Buffer.alloc(1_024, 0x78));
    setInterval(() => {}, 60_000);
    break;
  case 'hang':
    setInterval(() => {}, 60_000);
    break;
  default:
    process.stderr.write('unknown snapshot worker fixture mode\n');
    process.exitCode = 2;
}
