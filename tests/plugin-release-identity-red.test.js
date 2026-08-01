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
test('1.9.5 release keeps every package version and changelog heading exact', () => { assert.strictEqual(versions.join(','), '1.9.5,1.9.5,1.9.5');
  assert.match(readText('CHANGELOG.md'), /^## \[1\.9\.5\] — 2026-08-01 \(lock contention observability\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.9\.5\] — 2026-08-01 \(lock 경합 관측성\)$/m);
});
