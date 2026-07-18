'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const {
  validateSkillCommands,
  SKILL_COMMAND_CONTRACTS,
} = require('../scripts/lib/executable-contract.js');

const roots = new Set();

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('owner token prevents a foreign release and preserves the live owner', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki owner token ')));
  roots.add(root);
  fs.mkdirSync(path.join(root, '.wiki-meta'), { recursive: true });
  const owner = acquireLock({ wikiRoot: root, operation: 'token-contract' });
  const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
  const before = fs.readFileSync(ownerPath);
  assert.throws(
    () => releaseLock({ wikiRoot: root, token: 'foreign-token' }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  assert.deepEqual(fs.readFileSync(ownerPath), before);
  releaseLock({ wikiRoot: root, token: owner.token });
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('write-capable skills route lock ownership through the Node runtime', () => {
  const root = path.resolve(__dirname, '..');
  const contracts = Object.fromEntries(['wiki-ingest', 'wiki-query', 'wiki-rebuild', 'wiki-lint']
    .map((name) => [name, SKILL_COMMAND_CONTRACTS[name]]));
  for (const [name, allowlist] of Object.entries(contracts)) {
    const relative = `skills/${name}/SKILL.md`;
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    const result = validateSkillCommands(relative, text, allowlist);
    assert.deepEqual(result.violations, [], relative);
    assert.ok(result.commands.some((command) => command.argv[1] === 'lock')
      || result.commands.some((command) => command.argv[1] === 'lint' && command.argv[2] === 'fix'));
  }
});

test('storage authority documents owner, recovery, journal, and guaranteed release', () => {
  const text = fs.readFileSync(path.resolve(
    __dirname, '..', 'skills', 'wiki-schema', 'references', 'storage-layout.md',
  ), 'utf8');
  assert.match(text, /owner token/i);
  assert.match(text, /owner\.json/);
  assert.match(text, /lock recover/);
  assert.match(text, /journal/i);
  assert.match(text, /guaranteed final step/i);
  assert.doesNotMatch(text, /```(?:bash|sh|cmd|powershell)/i);
});
