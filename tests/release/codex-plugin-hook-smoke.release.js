'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runCodexPluginHookSmoke,
} = require('../../scripts/codex-plugin-hook-smoke.js');

test('native Windows Codex 0.144.1 installed-plugin hook trust smoke', () => {
  assert.equal(process.platform, 'win32', 'release smoke requires native Windows');

  const codexBin = process.env.CODEX_BIN || '';
  const codexHome = process.env.CODEX_HOME || '';
  const model = process.env.CODEX_SMOKE_MODEL || '';
  assert.equal(path.isAbsolute(codexBin), true, 'CODEX_BIN must be absolute');
  assert.equal(fs.existsSync(codexBin), true, 'CODEX_BIN must exist');
  assert.equal(path.isAbsolute(codexHome), true, 'CODEX_HOME must be absolute');
  assert.equal(fs.statSync(codexHome).isDirectory(), true, 'CODEX_HOME must be an existing directory');
  assert.notEqual(model.trim(), '', 'CODEX_SMOKE_MODEL must be nonempty');

  const hookVariant = process.env.CODEX_SMOKE_HOOK_VARIANT || 'both';
  assert.ok(['both', 'single'].includes(hookVariant), 'CODEX_SMOKE_HOOK_VARIANT must be both or single');

  const result = runCodexPluginHookSmoke({
    codexBin,
    codexHome,
    model,
    pluginRoot: path.resolve(__dirname, '..', '..'),
    hookVariant,
    platform: 'win32',
    env: process.env,
  });

  assert.equal(result.codexVersion, 'codex-cli 0.144.1');
  assert.equal(result.trustedHookObserved, true);
  assert.equal(result.untrustedHookDenied, true);
  assert.equal(result.marker.process_platform, 'win32');
  assert.equal(result.marker.PLUGIN_ROOT, result.pluginRoot);
  assert.equal(result.marker.CLAUDE_PLUGIN_ROOT, result.pluginRoot);
  assert.deepEqual(result.marker.secret_leaks, []);
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
