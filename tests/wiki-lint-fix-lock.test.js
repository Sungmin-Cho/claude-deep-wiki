'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fixWiki } = require('../hooks/scripts/runtime/wiki-state.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');

const roots = new Set();
const TS = '2026-07-11T00:00:00Z';

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki lint lock ')));
  roots.add(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.writeFileSync(path.join(root, 'log.md'), '# Wiki Log\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n');
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('lint fix soft-skips a foreign owner and leaves its lock byte-identical', () => {
  const root = fixture();
  const owner = acquireLock({ wikiRoot: root, operation: 'foreign-writer', now: new Date(TS) });
  const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
  const before = fs.readFileSync(ownerPath);
  try {
    assert.deepEqual(fixWiki({ wikiRoot: root, now: new Date(TS) }), {
      status: 'skipped', reason: 'LOCK_CONTENDED',
    });
    assert.deepEqual(fs.readFileSync(ownerPath), before);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('lint fix releases its token after a successful journaled repair', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), 'invalid\n');
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);
  assert.equal((fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(/"action":"lint"/g) || []).length, 1);
});
