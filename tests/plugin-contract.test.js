'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('Codex manifest uses default hook discovery and has no MCP surface', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.equal(manifest.skills, './skills/');
});

test('all package versions remain exactly aligned', () => {
  const versions = [
    readJson('.codex-plugin/plugin.json').version,
    readJson('.claude-plugin/plugin.json').version,
    readJson('package.json').version,
  ];
  assert.equal(new Set(versions).size, 1, `version drift: ${versions.join(', ')}`);
});

test('default SessionStart hook has one supported command entry', () => {
  const config = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(config).sort(), ['description', 'hooks']);
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart']);
  assert.equal(config.hooks.SessionStart.length, 1);

  const registration = config.hooks.SessionStart[0];
  assert.equal(registration.matcher, '*');
  assert.equal(registration.hooks.length, 1);

  const command = registration.hooks[0];
  const allowed = new Set(['type', 'command', 'commandWindows', 'timeout', 'statusMessage']);
  assert.deepEqual(
    Object.keys(command).filter((key) => !allowed.has(key)),
    [],
  );
  assert.equal(command.type, 'command');
  assert.equal(command.timeout, 15);
  assert.equal(typeof command.command, 'string');
  assert.notEqual(command.command.trim(), '');
  if (Object.hasOwn(command, 'commandWindows')) {
    assert.equal(typeof command.commandWindows, 'string');
    assert.notEqual(command.commandWindows.trim(), '');
  }
});

test('portable npm test cannot discover the credentialed release smoke', () => {
  const pkg = readJson('package.json');
  const portable = pkg.scripts.test;
  const driver = path.join(ROOT, 'tests', 'codex-plugin-hook-smoke-driver.test.js');
  const release = path.join(ROOT, 'tests', 'release', 'codex-plugin-hook-smoke.release.js');

  assert.equal(fs.existsSync(driver), true);
  assert.equal(fs.existsSync(release), true);
  assert.match(driver, /\.test\.js$/);
  assert.doesNotMatch(release, /\.test\.js$/);
  assert.doesNotMatch(portable, /codex-plugin-hook-smoke\.release|test:codex-windows-release/);
});
