'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statePath = '../hooks/scripts/runtime/wiki-state.js';
const scanWindow = require('../hooks/scripts/runtime/scan-window.js');
const { spawnSync } = require('node:child_process');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { readIndexPayload } = require('../hooks/scripts/read-index-envelope.js');

const OPERATION_ID = '01JZ7P9Q6MD7S5PB8H4Y40HJ83';
const EVENT_ID = '01JZ7P9Q6MD7S5PB8H4Y40HJ84';
const TS = '2026-07-11T00:00:00Z';
const cli = path.resolve(__dirname, '..', 'scripts', 'wiki-runtime.js');
const roots = new Set();

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(prefix = 'deep wiki state Unicode 공간 ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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

function pageContent(title, sources, body = '# Topic\r\n') {
  return `---\r\ntitle: ${title}\r\nsources: [${sources.join(', ')}]\r\ntags: [test]\r\naliases: []\r\n---\r\n\r\n${body}`;
}

function manifest(overrides = {}) {
  return {
    operation: 'ingest',
    operation_id: OPERATION_ID,
    pages: [{
      file: 'topic.md',
      action: 'create',
      expected_sha256: null,
      content: pageContent('Topic', ['source-a']),
    }],
    sources: [{ slug: 'source-a', content: 'origin: C:\\Source Space\\자료.md\ntype: file\n' }],
    events: [{
      event_id: EVENT_ID,
      ts: TS,
      action: 'ingest',
      source: 'source-a',
      pages_created: ['topic.md'],
      pages_updated: [],
    }],
    refresh_index: true,
    promote_pending_scan: null,
    ...overrides,
  };
}

function withLock(root, callback) {
  const owner = acquireLock({ wikiRoot: root, operation: 'wiki-state-test', now: new Date(TS) });
  try { return callback(owner.token); }
  finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function artifactSnapshot(root) {
  const files = [
    'pages/topic.md',
    '.wiki-meta/sources/source-a.yaml',
    '.wiki-meta/index.json',
    'index.md',
    'log.jsonl',
    'log.md',
    '.wiki-meta/.last-scan',
    '.wiki-meta/.pending-scan',
  ];
  const result = {};
  for (const relative of files) {
    const absolute = path.join(root, relative);
    result[relative] = fs.existsSync(absolute) ? fs.readFileSync(absolute).toString('base64') : null;
  }
  return result;
}

test('wiki-state exports the one state surface and exact shared promotion identity', () => {
  const state = require(statePath);
  assert.deepEqual(Object.keys(state).sort(), [
    'applyCommit', 'cleanupInbox', 'fixWiki', 'inspectWiki', 'promotePendingScan',
    'recoverTransaction', 'registerIngestFailure', 'setupWiki', 'snapshotWiki',
  ]);
  assert.equal(state.promotePendingScan, scanWindow.promotePendingScan);
  const source = fs.readFileSync(require.resolve(statePath), 'utf8');
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm)(?:Sync)?\([^\n]*(?:\.pending-scan|\.last-scan)/);
});

test('manifest preflight rejects schema, path, source, event, and create/update defects before mutation', async (t) => {
  const { applyCommit } = require(statePath);
  const cases = [
    ['unknown manifest key', (value) => { value.extra = true; }],
    ['page traversal', (value) => { value.pages[0].file = '../topic.md'; }],
    ['malformed basename', (value) => { value.pages[0].file = 'Topic Name.md'; }],
    ['duplicate page', (value) => { value.pages.push({ ...value.pages[0] }); }],
    ['unknown page action', (value) => { value.pages[0].action = 'replace'; }],
    ['operation event mismatch', (value) => { value.events[0].action = 'ingest-repair'; }],
    ['invalid event id', (value) => { value.events[0].event_id = 'event-1'; }],
    ['invalid timestamp', (value) => { value.events[0].ts = '2026-07-11'; }],
    ['missing source event', (value) => { value.events = []; }],
    ['duplicate source event', (value) => { value.events.push({ ...value.events[0], event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85' }); }],
    ['missing source record', (value) => { value.sources = []; }],
    ['event page mismatch', (value) => { value.events[0].pages_created = []; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture(`deep wiki preflight ${name} `);
      const value = structuredClone(manifest());
      mutate(value);
      const before = artifactSnapshot(root);
      withLock(root, (token) => {
        assert.throws(() => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
      });
      assert.deepEqual(artifactSnapshot(root), before);
      assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
    });
  }
});

test('operation-specific manifest semantics reject eventless rebuild and mutating ingest-fail', () => {
  const { applyCommit } = require(statePath);
  const cases = [
    {
      operation: 'rebuild', operation_id: OPERATION_ID, pages: [], sources: [], events: [],
      refresh_index: true, promote_pending_scan: null,
    },
    {
      ...manifest(),
      operation: 'ingest-fail',
      events: [{ ...manifest().events[0], action: 'ingest-fail' }],
      promote_pending_scan: TS,
    },
  ];
  for (const value of cases) {
    const root = fixture('deep wiki operation semantics ');
    const before = artifactSnapshot(root);
    withLock(root, (token) => assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
      (error) => error.code === 'MANIFEST_INVALID',
    ));
    assert.deepEqual(artifactSnapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
  }
});

test('scan-window bytes are validated during mutation-free preflight', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki scan preflight ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'corrupt\n');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const value = manifest({ promote_pending_scan: TS });
  const before = artifactSnapshot(root);
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
    (error) => ['SCAN_WINDOW_INVALID', 'MANIFEST_INVALID'].includes(error.code),
  ));
  assert.deepEqual(artifactSnapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
});

test('expected hash conflict and exactly-once history rejection preserve every artifact', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki expected hash ');
  const existing = pageContent('Existing', ['source-a'], '# Old\n');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), existing);
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: old\ntype: file\n');
  fs.writeFileSync(path.join(root, 'log.jsonl'), `${JSON.stringify({
    event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ80', ts: TS, action: 'ingest', source: 'source-a',
    pages_created: ['already-created.md'], pages_updated: [],
  })}\n`);
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'update', expected_sha256: '0'.repeat(64),
      content: pageContent('Topic', ['source-a']),
    }],
    events: [{ ...manifest().events[0], pages_created: [], pages_updated: ['topic.md'] }],
  });
  const before = artifactSnapshot(root);
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
      (error) => error.code === 'EXPECTED_HASH_CONFLICT',
    );
  });
  assert.deepEqual(artifactSnapshot(root), before);

  const duplicateHistory = manifest({
    pages: [{
      file: 'already-created.md', action: 'create', expected_sha256: null,
      content: pageContent('Already Created', ['source-a']),
    }],
    sources: [],
    events: [{
      ...manifest().events[0], pages_created: ['already-created.md'], pages_updated: [],
    }],
  });
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: duplicateHistory, now: new Date(TS) }),
      /exactly-once|created/i,
    );
  });
  assert.deepEqual(artifactSnapshot(root), before);
});

test('commit atomically coordinates page, source, indexes, logs, versions, and pending promotion', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki successful commit ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const result = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest({ promote_pending_scan: TS }), now: new Date(TS),
  }));
  assert.deepEqual(result.pagesCreated, ['topic.md']);
  assert.deepEqual(result.pagesUpdated, []);
  assert.deepEqual(result.eventIds, [EVENT_ID]);
  assert.equal(result.promotedWindow, TS);
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), manifest().pages[0].content);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'utf8'), /자료\.md/);
  const index = readIndexPayload(path.join(root, '.wiki-meta', 'index.json'));
  assert.deepEqual(index.pages.map((page) => page.file), ['topic.md']);
  assert.match(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), /topic\.md/);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(new RegExp(EVENT_ID, 'g')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'log.md'), 'utf8').match(new RegExp(`deep-wiki:event:${EVENT_ID}`, 'g')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);

  const beforeRetry = artifactSnapshot(root);
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest({ promote_pending_scan: TS }), now: new Date(TS),
  }));
  assert.deepEqual(artifactSnapshot(root), beforeRetry);
  const collision = manifest({ promote_pending_scan: TS });
  collision.events[0].ts = '2026-07-11T00:00:01Z';
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: collision, now: new Date(TS) }),
      (error) => error.code === 'OPERATION_ID_COLLISION',
    );
  });
});

test('update backups retain the newest three numeric versions', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki versions ');
  const existing = pageContent('Topic', ['source-a'], '# Old\n');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), existing);
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: old\ntype: file\n');
  for (let version = 1; version <= 3; version += 1) {
    fs.writeFileSync(path.join(root, '.wiki-meta', '.versions', `topic.v${version}.md`), `v${version}\n`);
  }
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'update', expected_sha256: sha(Buffer.from(existing)),
      content: pageContent('Topic', ['source-a'], '# 새 내용\r\n'),
    }],
    sources: [],
    events: [{ ...manifest().events[0], pages_created: [], pages_updated: ['topic.md'] }],
  });
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort(),
    ['topic.v2.md', 'topic.v3.md', 'topic.v4.md'],
  );
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.versions', 'topic.v4.md'), 'utf8'), existing);
});

test('every observed publication fault blocks readers and same-operation retry converges byte-identically', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const baselineRoot = fixture('deep wiki fault baseline ');
  fs.writeFileSync(path.join(baselineRoot, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const observed = [];
  withLock(baselineRoot, (token) => applyCommit({
    wikiRoot: baselineRoot,
    token,
    manifest: manifest({ promote_pending_scan: TS }),
    now: new Date(TS),
    faultInjector(boundary) { observed.push(boundary); },
  }));
  const baseline = artifactSnapshot(baselineRoot);
  const publicationBoundaries = [...new Set(observed.filter((value) => value.startsWith('after-')))].sort();
  assert.ok(publicationBoundaries.length >= 12, JSON.stringify(publicationBoundaries));

  for (const boundary of publicationBoundaries) {
    const root = fixture(`deep wiki fault ${boundary} `);
    fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
    let fired = false;
    withLock(root, (token) => {
      assert.throws(() => applyCommit({
        wikiRoot: root,
        token,
        manifest: manifest({ promote_pending_scan: TS }),
        now: new Date(TS),
        faultInjector(value) {
          if (!fired && value === boundary) { fired = true; throw Object.assign(new Error('process terminated'), { code: 'INJECTED_CRASH' }); }
        },
      }));
    });
    assert.equal(fired, true, boundary);
    if ([
      'after-transition-committed', 'after-cleanup', 'after-transition-cleaned',
      'after-receipt-publish', 'after-transaction-compacted',
    ].includes(boundary)) {
      assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
    } else {
      assert.throws(() => snapshotWiki({ wikiRoot: root }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
    }
    withLock(root, (token) => applyCommit({
      wikiRoot: root,
      token,
      manifest: manifest({ promote_pending_scan: TS }),
      now: new Date(TS),
    }));
    assert.deepEqual(artifactSnapshot(root), baseline, boundary);
  }
});

test('portable CLI consumes an absolute regular manifest file and keeps external inputs', () => {
  const root = fixture('deep wiki cli manifest 공간 ');
  const external = path.join(root, '..', `manifest-${crypto.randomUUID()}.json`);
  roots.add(external);
  fs.writeFileSync(external, `${JSON.stringify(manifest())}\n`);
  const owner = acquireLock({ wikiRoot: root, operation: 'cli-commit', now: new Date(TS) });
  try {
    const commit = spawnSync(process.execPath, [
      cli, 'commit', '--wiki-root', root, '--lock-token', owner.token,
      '--manifest-file', external, '--json',
    ], { encoding: 'utf8', shell: false });
    assert.equal(commit.status, 0, commit.stderr);
    assert.deepEqual(JSON.parse(commit.stdout).eventIds, [EVENT_ID]);
    assert.equal(fs.existsSync(external), true, 'external manifest must not be deleted');
  } finally { releaseLock({ wikiRoot: root, token: owner.token }); }

  const snapshot = spawnSync(process.execPath, [cli, 'snapshot', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout).pages, ['topic.md']);
  const index = spawnSync(process.execPath, [cli, 'index', 'read', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(index.status, 0, index.stderr);
  assert.deepEqual(JSON.parse(index.stdout).pages.map((page) => page.file), ['topic.md']);

  const symlink = path.join(path.dirname(external), `manifest-link-${crypto.randomUUID()}.json`);
  roots.add(symlink);
  fs.symlinkSync(external, symlink);
  const rejected = spawnSync(process.execPath, [
    cli, 'commit', '--wiki-root', root, '--lock-token', 'invalid',
    '--manifest-file', symlink, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(rejected.status, 4, rejected.stderr);
  assert.match(rejected.stderr, /MANIFEST_INVALID/);
});

test('journal manifest and artifact seal mutations stop recovery before later publication', () => {
  const { applyCommit } = require(statePath);
  for (const mutation of ['manifest', 'artifact']) {
    const root = fixture(`deep wiki journal seal ${mutation} `);
    withLock(root, (token) => {
      assert.throws(() => applyCommit({
        wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
        faultInjector(boundary) {
          if (boundary === 'after-transition-staged') throw new Error('stop after staging');
        },
      }));
    });
    const journalPath = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (mutation === 'manifest') journal.manifest.events[0].ts = '2026-07-11T00:00:01Z';
    else journal.artifacts[0].relative_path = 'CLAUDE.md';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const before = artifactSnapshot(root);
    withLock(root, (token) => {
      assert.throws(
        () => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }),
        (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
      );
    });
    assert.deepEqual(artifactSnapshot(root), before);
  }
});

test('sealed unchanged inputs cannot drift into a stale rebuilt index on recovery', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki sealed rebuild inputs ');
  const original = pageContent('Original', ['source-a']);
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), original);
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: old\ntype: file\n');
  const rebuild = {
    operation: 'rebuild', operation_id: OPERATION_ID, pages: [], sources: [],
    events: [{
      event_id: EVENT_ID, ts: TS, action: 'rebuild', source: null,
      pages_created: [], pages_updated: [],
    }],
    refresh_index: true, promote_pending_scan: null,
  };
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: rebuild, now: new Date(TS),
    faultInjector(boundary) { if (boundary === 'after-transition-staged') throw new Error('stop'); },
  })));
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), pageContent('Drifted', ['source-a']));
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: rebuild, now: new Date(TS) }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  ));
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
});

test('corrupt staged data rolls every published artifact back to recorded before bytes', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki corrupt stage rollback ');
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) { if (boundary === 'after-publish-page-topic.md') throw new Error('stop'); },
  })));
  const stage = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID, 'after', '0000.json');
  fs.writeFileSync(stage, 'corrupt\n');
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  ));
  assert.equal(fs.existsSync(path.join(root, 'pages', 'topic.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml')), false);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), '');
});

test('supported readers block on a nonterminal shared scan-window journal', () => {
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki scan reader block ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(root, (token) => assert.throws(() => scanWindow.promotePendingScan({
    wikiRoot: root,
    token,
    expected: TS,
    operationId: 'reader-block-probe',
    faultInjector(boundary) { if (boundary === 'after-last-scan-rename') throw new Error('stop'); },
  })));
  assert.throws(
    () => snapshotWiki({ wikiRoot: root }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  );
});

test('third ingest failure emits one terminal event before shared pending promotion and retries exactly once', () => {
  const { registerIngestFailure } = require(statePath);
  const root = fixture('deep wiki terminal ingest failure ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(root, (token) => {
    assert.equal(registerIngestFailure({ wikiRoot: root, token, source: 'source-a', now: new Date(TS) }).count, 1);
    assert.equal(registerIngestFailure({ wikiRoot: root, token, source: 'source-a', now: new Date(TS) }).count, 2);
    assert.throws(() => registerIngestFailure({
      wikiRoot: root, token, source: 'source-a', now: new Date(TS),
      faultInjector(boundary) {
        if (boundary === 'after-publish-log-jsonl') throw new Error('terminal emit interrupted');
      },
    }));
  });
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), true);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', '.pending-scan-retry-count'), 'utf8'), /:3\n$/);
  const result = withLock(root, (token) => registerIngestFailure({
    wikiRoot: root, token, source: 'source-a', now: new Date(TS),
  }));
  assert.equal(result.status, 'terminal');
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan-retry-count')), false);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'utf8'), /partial_fail: true/);
  const jsonLog = fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8');
  const markdownLog = fs.readFileSync(path.join(root, 'log.md'), 'utf8');
  assert.equal((jsonLog.match(/"action":"ingest-fail"/g) || []).length, 1);
  assert.equal((markdownLog.match(/— ingest-fail/g) || []).length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
});

test('lint fix self-locks, prunes numeric versions in the journal, rebuilds indexes, and emits one event', () => {
  const { fixWiki } = require(statePath);
  const root = fixture('deep wiki lint state fix ');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), pageContent('Topic', ['source-a']));
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: test\ntype: file\n');
  for (let version = 1; version <= 4; version += 1) {
    fs.writeFileSync(path.join(root, '.wiki-meta', '.versions', `topic.v${version}.md`), `v${version}\n`);
  }
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort(),
    ['topic.v2.md', 'topic.v3.md', 'topic.v4.md'],
  );
  assert.deepEqual(readIndexPayload(path.join(root, '.wiki-meta', 'index.json')).pages.map((page) => page.file), ['topic.md']);
  assert.equal((fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(/"action":"lint"/g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lint reports and repairs invalid or stale scan-window state through the shared planner', () => {
  const { fixWiki, inspectWiki } = require(statePath);
  const root = fixture('deep wiki lint pending repair ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), `${TS}\n`);
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), 'invalid\n');
  const report = inspectWiki({ wikiRoot: root });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'INVALID_PENDING_SCAN'));
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);
  assert.equal(inspectWiki({ wikiRoot: root }).issues.some((issue) => issue.code === 'INVALID_PENDING_SCAN'), false);
  const source = fs.readFileSync(require.resolve(statePath), 'utf8');
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm)(?:Sync)?\([^\n]*(?:\.pending-scan|\.last-scan)/);
});

test('setup commits a compatible wiki before writing the selected host config target', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup home ')));
  roots.add(home);
  const root = path.join(home, 'Vault 공간', 'Wiki');
  const result = setupWiki({
    wikiRoot: root,
    configHost: 'codex',
    env: { ...process.env, HOME: home, CODEX_HOME: '' },
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(result.config.status, 'created');
  assert.equal(result.config.path, path.join(home, '.codex', 'deep-wiki-config.yaml'));
  assert.match(fs.readFileSync(result.config.path, 'utf8'), /wiki_root:/);
});

test('setup resumes its journal after interruption without leaving an incompatible target', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup resume home ')));
  roots.add(home);
  const root = path.join(home, 'Interrupted Wiki');
  assert.throws(() => setupWiki({
    wikiRoot: root,
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    faultInjector(boundary) { if (boundary === 'after-transition-staged') throw new Error('stop'); },
  }));
  const result = setupWiki({
    wikiRoot: root,
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
});

test('setup resumes from its authenticated intent when interrupted before journaling', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup intent home ')));
  roots.add(home);
  const root = path.join(home, 'Intent Wiki');
  assert.throws(() => setupWiki({
    wikiRoot: root,
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    faultInjector(boundary) { if (boundary === 'after-setup-intent') throw new Error('stop'); },
  }));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), true);
  const result = setupWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), false);
});

test('setup revalidates compatibility after locking when a concurrent setup wins', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup race home ')));
  roots.add(home);
  const root = path.join(home, 'Racing Wiki');
  let competingResult;
  const result = setupWiki({
    wikiRoot: root,
    now: new Date(TS),
    operationId: '01JZ7P9Q6MD7S5PB8H4Y40HJ85',
    eventId: '01JZ7P9Q6MD7S5PB8H4Y40HJ86',
    faultInjector(boundary) {
      if (boundary === 'before-setup-lock') {
        competingResult = setupWiki({
          wikiRoot: root,
          now: new Date(TS),
          operationId: OPERATION_ID,
          eventId: EVENT_ID,
        });
      }
    },
  });
  assert.equal(competingResult.operationId, OPERATION_ID);
  assert.equal(result.status, 'compatible');
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(/"action":"setup"/g).length, 1);
});

test('setup rejects an unauthenticated empty pages/meta scaffold', () => {
  const { setupWiki } = require(statePath);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki foreign scaffold ')));
  roots.add(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta'));
  assert.throws(
    () => setupWiki({ wikiRoot: root, now: new Date(TS) }),
    (error) => error.code === 'WIKI_STATE_INVALID',
  );
  assert.deepEqual(fs.readdirSync(root).sort(), ['.wiki-meta', 'pages']);
});

test('cleaned transactions compact to bounded receipts while preserving idempotent retry', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki compact receipt ');
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions', OPERATION_ID)), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transaction-receipts', `${OPERATION_ID}.json`)), true);
  const before = artifactSnapshot(root);
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }));
  assert.deepEqual(artifactSnapshot(root), before);
});

test('success-path residual dir self-heals via receipt compaction', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const root = fixture('deep wiki residual receipt ');
  const first = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
  }));
  const residual = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID);
  fs.mkdirSync(path.join(residual, 'before'), { recursive: true });
  assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  clock.now = 2_001;
  const retry = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS), deadline,
  }));
  assert.deepEqual(retry, first);
  assert.equal(fs.existsSync(residual), false);
});

test('readers never see a journal-less live transaction', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const root = fixture('deep wiki journal first ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const operation = path.join(transactions, OPERATION_ID);
  const observed = new Set();
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) {
      if (!['before-transaction-activate', 'after-transaction-activate', 'before-stage-0-before'].includes(boundary)) return;
      observed.add(boundary);
      if (boundary === 'before-transaction-activate') {
        assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
        const names = fs.readdirSync(transactions);
        assert.equal(names.includes(OPERATION_ID), false);
        assert.equal(names.some((name) => name.startsWith('.activate-')), true);
      } else {
        assert.equal(fs.existsSync(path.join(operation, 'journal.json')), true);
        assert.throws(
          () => snapshotWiki({ wikiRoot: root }),
          (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
        );
      }
    },
  }));
  assert.deepEqual([...observed].sort(), [
    'after-transaction-activate', 'before-stage-0-before', 'before-transaction-activate',
  ]);

  const crashRoot = fixture('deep wiki abandoned activation ');
  const crashTransactions = path.join(crashRoot, '.wiki-meta', '.transactions');
  withLock(crashRoot, (token) => assert.throws(() => applyCommit({
    wikiRoot: crashRoot, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) {
      if (boundary === 'before-transaction-activate') throw new Error('activation crash');
    },
  }), /activation crash/));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), true);
  const unrelated = manifest({ operation_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85' });
  unrelated.events[0].event_id = '01JZ7P9Q6MD7S5PB8H4Y40HJ86';
  withLock(crashRoot, (token) => applyCommit({
    wikiRoot: crashRoot, token, manifest: unrelated, now: new Date(TS),
  }));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), false);
});

test('scan-window producer never exposes a journal-less operation dir', () => {
  const root = fixture('deep wiki scan atomic activation ');
  const operationId = 'scan-window-atomic-activation';
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const observed = [];
  withLock(root, (token) => scanWindow.promotePendingScan({
    wikiRoot: root, token, expected: TS, operationId,
    faultInjector(boundary) {
      observed.push(boundary);
      const operation = path.join(transactions, operationId);
      assert.equal(!fs.existsSync(operation) || fs.existsSync(path.join(operation, 'journal.json')), true, boundary);
    },
  }));
  assert.equal(observed.includes('before-transaction-activate'), true);
  assert.equal(observed.includes('after-transaction-activate'), true);

  const crashRoot = fixture('deep wiki scan activation retry ');
  const crashTransactions = path.join(crashRoot, '.wiki-meta', '.transactions');
  fs.mkdirSync(crashTransactions, { recursive: true });
  fs.writeFileSync(path.join(crashRoot, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(crashRoot, (token) => assert.throws(() => scanWindow.promotePendingScan({
    wikiRoot: crashRoot, token, expected: TS, operationId,
    faultInjector(boundary) {
      if (boundary === 'before-transaction-activate') throw new Error('scan activation crash');
    },
  }), /scan activation crash/));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), true);
  const retry = withLock(crashRoot, (token) => scanWindow.promotePendingScan({
    wikiRoot: crashRoot, token, expected: TS, operationId,
  }));
  assert.equal(retry.status, 'promoted');
  assert.equal(fs.readFileSync(path.join(crashRoot, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), false);
});

test('transaction debris sweep yields before consuming the primary-operation reserve', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep deadline reserve ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (const name of ['plain-a', 'plain-b', 'plain-c']) fs.mkdirSync(path.join(transactions, name));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  clock.now = 2_001;
  withLock(root, (token) => assert.doesNotThrow(() => sweepTransactionDebris(root, token, { deadline })));
  assert.deepEqual(fs.readdirSync(transactions).sort(), ['plain-a', 'plain-b', 'plain-c']);
});

test('transaction debris sweep never removes a transaction with a journal', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep journal safety ');
  const transaction = path.join(root, '.wiki-meta', '.transactions', 'journalled');
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(path.join(transaction, 'journal.json'), 'preserve exactly\n');
  fs.writeFileSync(path.join(transaction, 'stray'), 'also preserve\n');
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, { deadline }));
  assert.equal(fs.readFileSync(path.join(transaction, 'journal.json'), 'utf8'), 'preserve exactly\n');
  assert.equal(fs.readFileSync(path.join(transaction, 'stray'), 'utf8'), 'also preserve\n');
});

test('transaction debris sweep completes valid cancelled tombstone teardown', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep cancelled teardown ');
  const operationId = '01JZ7P9Q6MD7S5PB8H4Y40HJ85';
  const transaction = path.join(root, '.wiki-meta', '.transactions', operationId);
  fs.mkdirSync(path.join(transaction, 'after'), { recursive: true });
  fs.writeFileSync(path.join(transaction, 'after', '0000.json'), 'staged\n');
  fs.writeFileSync(path.join(transaction, 'cancelled.json'), `${JSON.stringify({
    contract_version: 1,
    operation_id: operationId,
    reason: 'catalog-drift',
    drift: ['pages/topic.md'],
  })}\n`);
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, { deadline }));
  assert.equal(fs.existsSync(transaction), false);
});

test('setup refuses a nonempty incompatible target before creating wiki state', () => {
  const { setupWiki } = require(statePath);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki incompatible setup ')));
  roots.add(root);
  fs.writeFileSync(path.join(root, 'foreign.txt'), 'preserve me\n');
  assert.throws(
    () => setupWiki({ wikiRoot: root, now: new Date(TS) }),
    (error) => error.code === 'WIKI_STATE_INVALID',
  );
  assert.deepEqual(fs.readdirSync(root), ['foreign.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'foreign.txt'), 'utf8'), 'preserve me\n');
});
