'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runCodexPluginHookSmoke,
} = require('../../scripts/codex-plugin-hook-smoke.js');

test('native Windows Codex 0.144.1 installed-plugin hook trust smoke', async () => {
  assert.equal(process.platform, 'win32', 'release smoke requires native Windows');

  const codexBin = process.env.CODEX_BIN || '';
  const candidateSha = process.env.CANDIDATE_SHA || '';
  const workRoot = process.env.RUNNER_TEMP || '';
  assert.equal(path.isAbsolute(codexBin), true, 'CODEX_BIN must be absolute');
  assert.equal(fs.existsSync(codexBin), true, 'CODEX_BIN must exist');
  assert.match(candidateSha, /^[0-9a-f]{40}$/i, 'CANDIDATE_SHA must be the exact candidate');
  assert.equal(path.isAbsolute(workRoot), true, 'RUNNER_TEMP must be absolute');

  const result = await runCodexPluginHookSmoke({
    codexBin,
    candidateSha,
    pluginRoot: path.resolve(__dirname, '..', '..'),
    workRoot,
    platform: 'win32',
    env: process.env,
  });

  assert.equal(result.candidate_sha, candidateSha.toLowerCase());
  assert.equal(result.codex_version, 'codex-cli 0.144.1');
  assert.equal(result.codex_binary_sha256, process.env.CODEX_BINARY_SHA256);
  assert.equal(result.trusted.request_count, 1);
  assert.equal(result.trusted.request.authorization_public, true);
  assert.equal(result.direct_installed_supervisor.stderr_empty, true);
  assert.match(result.direct_installed_supervisor.stdout_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.untrusted, {
    deep_wiki_effect: false,
    model_continued: true,
    request_count: 1,
    mutated: false,
  });
  assert.equal(result.diagnostic.variant, 'commandWindows');
  assert.equal(result.diagnostic.rootEqual, true);
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
