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
test('1.9.6 release keeps every package version and changelog heading exact', () => { assert.strictEqual(versions.join(','), '1.9.6,1.9.6,1.9.6');
  assert.match(readText('CHANGELOG.md'), /^## \[1\.9\.6\] — 2026-08-04 \(transaction store junk tolerance\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.9\.6\] — 2026-08-04 \(transaction store 잡파일 내성\)$/m);
});
