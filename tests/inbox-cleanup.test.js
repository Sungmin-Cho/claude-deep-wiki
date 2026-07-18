'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { cleanupInbox } = require('../hooks/scripts/runtime/wiki-state.js');

const roots = new Set();
const NOW = new Date('2026-07-18T00:00:00.000Z');

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki inbox cleanup ')));
  roots.add(root);
  const inbox = path.join(root, '.wiki-meta', '.inbox');
  const sources = path.join(root, '.wiki-meta', 'sources');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(sources, { recursive: true });
  const owner = acquireLock({ wikiRoot: root, operation: 'inbox-cleanup', now: NOW });
  return { root, inbox, sources, owner };
}

function writeAged(file, bytes, days) {
  fs.writeFileSync(file, bytes);
  const timestamp = new Date(NOW.getTime() - days * 86_400_000);
  fs.utimesSync(file, timestamp, timestamp);
}

function cleanup(state) {
  return cleanupInbox({
    wikiRoot: state.root,
    token: state.owner.token,
    maxAgeDays: 7,
    now: NOW,
  });
}

test('Node inbox cleanup quarantines stale files and preserves their bytes', () => {
  const state = fixture();
  const stale = path.join(state.inbox, 'stale.txt');
  writeAged(stale, Buffer.from('old session\0bytes'), 8);
  try {
    assert.deepEqual(cleanup(state), { moved: ['stale.txt'] });
    assert.equal(fs.existsSync(stale), false);
    const quarantine = path.join(state.inbox, '.quarantine');
    const entries = fs.readdirSync(quarantine);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /-stale\.txt$/);
    assert.deepEqual(fs.readFileSync(path.join(quarantine, entries[0])), Buffer.from('old session\0bytes'));
  } finally {
    releaseLock({ wikiRoot: state.root, token: state.owner.token });
  }
});

test('Node inbox cleanup preserves fresh files', () => {
  const state = fixture();
  const fresh = path.join(state.inbox, 'fresh.txt');
  writeAged(fresh, 'recent session', 1);
  try {
    assert.deepEqual(cleanup(state), { moved: [] });
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'recent session');
    assert.equal(fs.existsSync(path.join(state.inbox, '.quarantine')), false);
  } finally {
    releaseLock({ wikiRoot: state.root, token: state.owner.token });
  }
});

for (const quote of ['"', "'"]) {
  test(`Node inbox cleanup preserves partial-fail origin in ${quote} quotes`, () => {
    const state = fixture();
    const protectedFile = path.join(state.inbox, `protected-${quote === '"' ? 'double' : 'single'}.txt`);
    writeAged(protectedFile, 'pending retry', 8);
    fs.writeFileSync(path.join(state.sources, 'protected.yaml'), [
      'type: text',
      `origin: ${quote}${protectedFile}${quote}`,
      'partial_fail: true',
      '',
    ].join('\n'));
    try {
      assert.deepEqual(cleanup(state), { moved: [] });
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'pending retry');
    } finally {
      releaseLock({ wikiRoot: state.root, token: state.owner.token });
    }
  });
}

test('Node inbox cleanup rejects a foreign token before mutation', () => {
  const state = fixture();
  const stale = path.join(state.inbox, 'foreign-token.txt');
  writeAged(stale, 'must remain', 8);
  try {
    assert.throws(() => cleanupInbox({
      wikiRoot: state.root,
      token: 'f'.repeat(64),
      maxAgeDays: 7,
      now: NOW,
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(fs.readFileSync(stale, 'utf8'), 'must remain');
  } finally {
    releaseLock({ wikiRoot: state.root, token: state.owner.token });
  }
});
