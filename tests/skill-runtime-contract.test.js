'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateSkillCommands,
  SKILL_COMMAND_CONTRACTS,
} = require('../scripts/lib/executable-contract.js');

const root = path.resolve(__dirname, '..');
const ENTRY_SKILLS = SKILL_COMMAND_CONTRACTS;
const MANIFEST_KEYS = [
  'events', 'operation', 'operation_id', 'pages', 'promote_pending_scan',
  'refresh_index', 'sources',
];
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function dataObjects(relative) {
  return [...read(relative).matchAll(/<!-- deep-wiki:data -->\s*```json\s*([\s\S]*?)\s*```/g)]
    .map((match) => JSON.parse(match[1]));
}

test('every shipped entry skill uses only classified Node argv or the one Obsidian probe', () => {
  for (const [skill, allowlist] of Object.entries(ENTRY_SKILLS)) {
    const relative = `skills/${skill}/SKILL.md`;
    const result = validateSkillCommands(relative, read(relative), allowlist);
    assert.deepEqual(result.violations, [], relative);
    assert.ok(result.commands.length > 0, relative);
    assert.ok(result.commands.every((command) => command.executable === 'node'
      || (skill === 'wiki-setup' && command.executable === 'obsidian')));
  }
});

test('every shipped entry skill declares the same Claude and Codex runtime hosts', () => {
  for (const skill of Object.keys(ENTRY_SKILLS)) {
    assert.match(read(`skills/${skill}/SKILL.md`), /runtime_hosts:\s*\[claude, codex\]/);
  }
});

test('setup accepts native drive, slash-drive, and UNC paths without POSIX conversion', () => {
  const setup = read('skills/wiki-setup/SKILL.md');
  assert.match(setup, /C:\\Users\\name\\Wiki/);
  assert.match(setup, /C:\/Users\/name\/Wiki/);
  assert.match(setup, /\\\\server\\share\\Wiki/);
  assert.doesNotMatch(setup, /Windows users must supply a POSIX|\/mnt\/c\/|\/c\/Users\//i);
});

test('schema and storage make Node token ownership and recovery authoritative', () => {
  const contract = [
    read('skills/wiki-schema/SKILL.md'),
    read('skills/wiki-schema/wiki-schema.yaml'),
    read('skills/wiki-schema/references/storage-layout.md'),
  ].join('\n');
  for (const expected of ['owner token', 'owner.json', 'journal', 'lock recover', '.last-scan']) {
    assert.match(contract.toLowerCase(), new RegExp(expected.replace('.', '\\.')));
  }
  assert.match(contract, /wiki-runtime\.js/);
  assert.doesNotMatch(contract, /three[- ]bash[- ]trap|bash trap catalog/i);
  assert.match(contract, /\.transactions\/(?:<operation_id>|OPERATION_ID)\/journal\.json/);
  assert.doesNotMatch(contract, /\.runtime\/journal/);
});

test('documented commit manifests use the exact runtime schema and valid stable ids', () => {
  const expected = {
    'wiki-ingest': ['ingest', 'ingest'],
    'wiki-query': ['query-autofile', 'query-filed'],
    'wiki-rebuild': ['rebuild', 'rebuild'],
  };
  for (const [skill, [operation, action]] of Object.entries(expected)) {
    const manifest = dataObjects(`skills/${skill}/SKILL.md`)
      .find((value) => Object.hasOwn(value, 'operation_id'));
    assert.ok(manifest, skill);
    assert.deepEqual(Object.keys(manifest).sort(), MANIFEST_KEYS, skill);
    assert.equal(manifest.operation, operation, skill);
    assert.match(manifest.operation_id, ULID_RE, skill);
    assert.equal(manifest.refresh_index, true, skill);
    assert.ok(manifest.promote_pending_scan === null
      || typeof manifest.promote_pending_scan === 'string', skill);
    assert.ok(Array.isArray(manifest.pages), skill);
    assert.ok(Array.isArray(manifest.sources), skill);
    assert.ok(Array.isArray(manifest.events), skill);
    for (const event of manifest.events) {
      assert.match(event.event_id, ULID_RE, skill);
      assert.equal(event.action, action, skill);
    }
    const relative = `skills/${skill}/SKILL.md`;
    const route = validateSkillCommands(relative, read(relative), ENTRY_SKILLS[skill]);
    const recoveries = route.commands.filter((command) => command.argv[1] === 'transaction'
      && command.argv[2] === 'recover');
    assert.equal(recoveries.length, 1, skill);
    const idIndex = recoveries[0].argv.indexOf('--operation-id');
    assert.equal(recoveries[0].argv[idIndex + 1], manifest.operation_id, skill);
  }
});

test('rebuild exposes one journaled commit and no split index or event mutation', () => {
  const relative = 'skills/wiki-rebuild/SKILL.md';
  const result = validateSkillCommands(relative, read(relative), ENTRY_SKILLS['wiki-rebuild']);
  const commits = result.commands.filter((command) => command.argv[1] === 'commit');
  assert.equal(commits.length, 1);
  assert.doesNotMatch(read(relative), /index rebuild|event append/i);
  assert.match(read(relative), /operation_id/);
  assert.match(read(relative), /"operation"\s*:\s*"rebuild"/);
});
