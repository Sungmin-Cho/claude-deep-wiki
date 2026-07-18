'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanWindow = require('../hooks/scripts/runtime/scan-window.js');
const wikiState = require('../hooks/scripts/runtime/wiki-state.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { validateSkillCommands } = require('../scripts/lib/executable-contract.js');

const roots = new Set();
const T0 = '2026-07-11T00:00:00Z';
const T1 = '2026-07-11T01:00:00Z';

function temporaryWiki() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki promotion ')));
  roots.add(root);
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions'), { recursive: true });
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('wiki state exports the shared scan-window promotion implementation', () => {
  assert.equal(wikiState.promotePendingScan, scanWindow.promotePendingScan);
});

test('shared promotion authenticates one owner and advances last-scan monotonically', () => {
  const root = temporaryWiki();
  const meta = path.join(root, '.wiki-meta');
  fs.writeFileSync(path.join(meta, '.last-scan'), `${T0}\n`);
  fs.writeFileSync(path.join(meta, '.pending-scan'), `${T1}\n`);
  const owner = acquireLock({ wikiRoot: root, operation: 'promotion-contract', now: new Date(T1) });
  try {
    const result = wikiState.promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'promotion-contract-operation-0001',
      now: new Date(T1),
    });
    assert.equal(result.status, 'promoted');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.equal(fs.readFileSync(path.join(meta, '.last-scan'), 'utf8'), `${T1}\n`);
  assert.equal(fs.existsSync(path.join(meta, '.pending-scan')), false);
});

test('ingest routes promotion and failure through classified Node runtime calls', () => {
  const file = 'skills/wiki-ingest/SKILL.md';
  const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const result = validateSkillCommands(file, text, [
    'config', 'inbox', 'snapshot', 'lock', 'commit', 'scan-window', 'transaction',
  ]);
  assert.deepEqual(result.violations, []);
  const scanCommands = result.commands.filter((command) => command.argv[1] === 'scan-window');
  assert.deepEqual(scanCommands.map((command) => command.argv[2]).sort(), ['fail', 'promote']);
  assert.match(text, /\.last-scan[^\n]*monotonic/i);
});
