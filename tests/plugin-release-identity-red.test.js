'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const versions = [
  readJson('.claude-plugin/plugin.json').version,
  readJson('.codex-plugin/plugin.json').version,
  readJson('package.json').version];
test('1.9.4 release keeps every package version and changelog heading exact', () => { assert.strictEqual(versions.join(','), '1.9.4,1.9.4,1.9.4');
  assert.match(readText('CHANGELOG.md'), /^## \[1\.9\.4\] — 2026-07-31 \(lint repair reclamation\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.9\.4\] — 2026-07-31 \(lint repair 회수\)$/m);
});
