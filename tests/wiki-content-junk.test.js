'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const statePath = '../hooks/scripts/runtime/wiki-state.js';
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { readIndexPayload } = require('../hooks/scripts/read-index-envelope.js');

const APPLE_DOUBLE = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);
const TS = '2026-07-11T00:00:00Z';
const CLI = path.resolve(__dirname, '..', 'scripts', 'wiki-runtime.js');
const roots = new Set();
let operationCounter = 0;

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function ulid(seed) {
  const tail = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16).toUpperCase();
  return `01JZ7P9Q6MD7S5PB8H4Y${tail}`.slice(0, 26);
}

function fixture(prefix = 'deep wiki AppleDouble ') {
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

function pageContent(title = 'Topic', sources = ['source-a'], body = '# Topic\r\n') {
  return `---\r\ntitle: ${title}\r\nsources: [${sources.join(', ')}]\r\ntags: [test]\r\naliases: []\r\n---\r\n\r\n${body}`;
}

function manifest(overrides = {}) {
  const operationId = ulid(`manifest-${operationCounter += 1}`);
  const eventId = ulid(`event-${operationCounter += 1}`);
  return {
    operation: 'ingest',
    operation_id: operationId,
    pages: [{
      file: 'topic.md', action: 'create', expected_sha256: null,
      content: pageContent(),
    }],
    sources: [{ slug: 'source-a', content: 'origin: source-a\ntype: file\n' }],
    events: [{
      event_id: eventId, ts: TS, action: 'ingest', source: 'source-a',
      pages_created: ['topic.md'], pages_updated: [],
    }],
    refresh_index: true,
    promote_pending_scan: null,
    ...overrides,
  };
}

function rebuildManifest(overrides = {}) {
  const operationId = ulid(`rebuild-${operationCounter += 1}`);
  const eventId = ulid(`rebuild-event-${operationCounter += 1}`);
  return {
    operation: 'rebuild', operation_id: operationId, pages: [], sources: [],
    events: [{
      event_id: eventId, ts: TS, action: 'rebuild', source: null,
      pages_created: [], pages_updated: [],
    }],
    refresh_index: true, promote_pending_scan: null,
    ...overrides,
  };
}

function lintManifest() {
  const operationId = ulid(`lint-${operationCounter += 1}`);
  const eventId = ulid(`lint-event-${operationCounter += 1}`);
  return {
    operation: 'lint', operation_id: operationId, pages: [], sources: [],
    events: [{
      event_id: eventId, ts: TS, action: 'lint', source: null,
      pages_created: [], pages_updated: [],
    }],
    refresh_index: true, promote_pending_scan: null,
  };
}

function withLock(root, callback) {
  const owner = acquireLock({ wikiRoot: root, operation: 'wiki-content-junk-test', now: new Date(TS) });
  try { return callback(owner.token); }
  finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function seedNormal(root) {
  const state = require(statePath);
  withLock(root, (token) => state.applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
  }));
}

function stageInterrupted(root, value) {
  const state = require(statePath);
  withLock(root, (token) => assert.throws(() => state.applyCommit({
    wikiRoot: root, token, manifest: value, now: new Date(TS),
    faultInjector(boundary) {
      if (boundary === 'after-transition-staged') throw new Error('stop after staging');
    },
  }), /stop after staging/));
  return JSON.parse(fs.readFileSync(journalPath(root, value.operation_id), 'utf8'));
}

function transactionPath(root, operationId) {
  return path.join(root, '.wiki-meta', '.transactions', operationId);
}

function journalPath(root, operationId) {
  return path.join(transactionPath(root, operationId), 'journal.json');
}

function capture(call) {
  try { return { value: call(), error: null }; }
  catch (error) { return { value: null, error }; }
}

function writeAppleDouble(file) {
  fs.writeFileSync(file, Buffer.concat([APPLE_DOUBLE, Buffer.from(` ${path.basename(file)}\n`)]));
  return fs.readFileSync(file);
}

function fakeDirent(name, type = 'unknown') {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function spawnJsonChild(script, args) {
  const result = spawnSync(process.execPath, ['-e', script, ...args], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
}

function t7ChildScript() {
  return String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const state = require(process.argv[1]);
    const root = process.argv[2];
    const mode = process.argv[3];
    const pages = fs.realpathSync.native(path.join(root, 'pages'));
    const expected = mode === 'regular' ? '._unknown.md' : '._missing.md';
    const expectedPath = path.join(pages, expected);
    const originalReaddirSync = fs.readdirSync;
    const originalLstatSync = fs.lstatSync;
    let pagesReads = 0;
    let injections = 0;
    let lstatCalls = 0;
    let delegatedReaddir = 0;
    let delegatedLstat = 0;
    fs.readdirSync = function wrappedReaddir(target, options) {
      const result = originalReaddirSync.apply(this, arguments);
      let targetReal = null;
      try { targetReal = fs.realpathSync.native(target); } catch {}
      if (options?.withFileTypes === true && targetReal === pages) {
        pagesReads += 1;
        injections += 1;
        return [...result, { name: expected, isFile: () => false, isDirectory: () => false,
          isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
          isFIFO: () => false, isSocket: () => false }];
      }
      delegatedReaddir += 1;
      return result;
    };
    fs.lstatSync = function wrappedLstat(target) {
      if (path.resolve(target) === path.resolve(expectedPath)) {
        lstatCalls += 1;
        if (mode === 'missing') {
          const error = new Error('missing injected lstat target');
          error.code = 'ENOENT';
          throw error;
        }
      } else delegatedLstat += 1;
      return originalLstatSync.apply(this, arguments);
    };
    let value = null;
    let error = null;
    try {
      if (mode === 'regular') fs.writeFileSync(expectedPath, Buffer.from([0x00, 0x05, 0x16, 0x07]));
      value = state.snapshotWiki({ wikiRoot: root });
    } catch (caught) { error = { code: caught.code, message: caught.message }; }
    fs.readdirSync = originalReaddirSync;
    fs.lstatSync = originalLstatSync;
    const restored = fs.readdirSync === originalReaddirSync && fs.lstatSync === originalLstatSync;
    process.stdout.write(JSON.stringify({ value, error, pagesReads, injections, lstatCalls,
      delegatedReaddir, delegatedLstat, restored }));
  `;
}

function t8ChildScript() {
  return String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const state = require(process.argv[1]);
    const deadlineModule = require(process.argv[2]);
    const root = process.argv[3];
    const mode = process.argv[4];
    const versions = fs.realpathSync.native(path.join(root, '.wiki-meta', '.versions'));
    const originalReaddirSync = fs.readdirSync;
    const originalLstatSync = fs.lstatSync;
    let versionsReads = 0;
    let injections = 0;
    let lstatCalls = 0;
    let delegatedFirst = false;
    let delegatedOther = 0;
    let expired = false;
    let deadline;
    if (mode === 'deadline') {
      deadline = deadlineModule.createDeadline({
        clock: { nowMs: () => expired ? 1 : 0 }, budgetMs: 1,
      });
    }
    fs.readdirSync = function wrappedReaddir(target, options) {
      const result = originalReaddirSync.apply(this, arguments);
      let targetReal = null;
      try { targetReal = fs.realpathSync.native(target); } catch {}
      if (options?.withFileTypes === true && targetReal === versions) {
        versionsReads += 1;
        if (versionsReads === 1) delegatedFirst = true;
        if (versionsReads !== 2) { delegatedOther += 1; return result; }
        if (mode === 'eacces') {
          const error = new Error('collector versions denied');
          error.code = 'EACCES';
          throw error;
        }
        if (mode === 'unknown') {
          injections += 1;
          return [...result, { name: '._collector-missing.md', isFile: () => false,
            isDirectory: () => false, isSymbolicLink: () => false, isBlockDevice: () => false,
            isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false }];
        }
        if (mode === 'deadline') {
          injections += 2;
          const injected = [
            { name: '._z.md', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
              isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false },
            { name: '._a.md', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
              isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false },
          ];
          expired = true;
          return injected;
        }
      }
      delegatedOther += 1;
      return result;
    };
    fs.lstatSync = function wrappedLstat(target) {
      if (path.resolve(target) === path.join(versions, '._collector-missing.md')) {
        lstatCalls += 1;
        const error = new Error('collector lstat denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalLstatSync.apply(this, arguments);
    };
    let value = null;
    let error = null;
    try {
      if (mode === 'reader-precedence') {
        fs.writeFileSync(path.join(root, 'pages', '._reader.md'), Buffer.from([0x00, 0x05, 0x16, 0x07]));
        let calls = 0;
        const clock = { nowMs: () => (calls++ === 0 ? 0 : 1) };
        value = state.inspectWiki({ wikiRoot: root, deadline: deadlineModule.createDeadline({ clock, budgetMs: 1 }) });
      } else {
        value = state.inspectWiki({ wikiRoot: root, ...(deadline ? { deadline } : {}) });
      }
    } catch (caught) { error = { code: caught.code, message: caught.message, boundary: caught.boundary }; }
    fs.readdirSync = originalReaddirSync;
    fs.lstatSync = originalLstatSync;
    const restored = fs.readdirSync === originalReaddirSync && fs.lstatSync === originalLstatSync;
    process.stdout.write(JSON.stringify({ value, error, versionsReads, injections, lstatCalls,
      delegatedFirst, delegatedOther, restored }));
  `;
}

test('T1 issue repro: page AppleDouble is ignored by the repair route', () => {
  const state = require(statePath);
  const root = fixture('deep wiki AppleDouble T1 ');
  seedNormal(root);
  const junk = path.join(root, 'pages', '._topic.md');
  writeAppleDouble(junk);
  const attempt = capture(() => state.fixWiki({ wikiRoot: root, now: new Date(TS) }));
  assert.equal(attempt.error, null, `T1 base RED: ${attempt.error?.code} ${attempt.error?.message}`);
  assert.equal(attempt.value.status, 'fixed');
  assert.equal(attempt.value.after.ok, true);
  assert.equal(attempt.value.after.pages, 1);
  assert.equal(fs.existsSync(junk), true);
});

test('T2 no reclaim: content AppleDouble bytes remain outside transaction reclamation', () => {
  const state = require(statePath);
  const root = fixture('deep wiki AppleDouble T2 ');
  seedNormal(root);
  const junk = path.join(root, 'pages', '._topic.md');
  const bytes = writeAppleDouble(junk);
  const attempt = capture(() => state.fixWiki({ wikiRoot: root, now: new Date(TS) }));
  assert.equal(attempt.error, null, `T2 base RED: ${attempt.error?.code} ${attempt.error?.message}`);
  assert.equal(attempt.value.status, 'fixed');
  assert.deepEqual(fs.readFileSync(junk), bytes);
  assert.equal(attempt.value.removed_junk.includes('._topic.md'), false);
});

test('T3 all mutation catalogs tolerate regular AppleDouble without indexing it', () => {
  const state = require(statePath);
  const root = fixture('deep wiki AppleDouble T3 ');
  seedNormal(root);
  const page = path.join(root, 'pages', '._page.md');
  const source = path.join(root, '.wiki-meta', 'sources', '._source.yaml');
  const version = path.join(root, '.wiki-meta', '.versions', '._version.md');
  const bytes = [writeAppleDouble(page), writeAppleDouble(source), writeAppleDouble(version)];
  const existing = fs.readFileSync(path.join(root, 'pages', 'topic.md'));
  const value = manifest({
    pages: [{ file: 'topic.md', action: 'update', expected_sha256: sha(existing), content: pageContent('Updated') }],
    sources: [{ slug: 'source-a', content: 'origin: updated\ntype: file\n' }],
    events: [{
      event_id: ulid(`t3-event-${operationCounter += 1}`), ts: TS, action: 'ingest', source: 'source-a',
      pages_created: [], pages_updated: ['topic.md'],
    }],
  });
  const attempt = capture(() => withLock(root, (token) => state.applyCommit({
    wikiRoot: root, token, manifest: value, now: new Date(TS),
  })));
  assert.equal(attempt.error, null, `T3 base RED: ${attempt.error?.code} ${attempt.error?.message}`);
  for (const [file, original] of [[page, bytes[0]], [source, bytes[1]], [version, bytes[2]]]) {
    assert.deepEqual(fs.readFileSync(file), original);
  }
  const index = readIndexPayload(path.join(root, '.wiki-meta', 'index.json'));
  assert.deepEqual(index.pages.map((item) => item.file), ['topic.md']);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), /\._(?:page|source|version)/);
});

test('T4 counts, drift, excess threshold, and version-prune safety exclude content junk', () => {
  const state = require(statePath);
  const pageRoot = fixture('deep wiki AppleDouble T4 page ');
  seedNormal(pageRoot);
  const pageJunk = path.join(pageRoot, 'pages', '._page.md');
  writeAppleDouble(pageJunk);
  for (let index = 1; index <= 4; index += 1) {
    writeAppleDouble(path.join(pageRoot, '.wiki-meta', '.versions', `._page.v${index}.md`));
  }
  const pageFix = capture(() => state.fixWiki({ wikiRoot: pageRoot, now: new Date(TS) }));
  assert.equal(pageFix.error, null, 'T4 fixed route must remove junk-caused count/drift');
  assert.equal(pageFix.value.status, 'fixed');
  assert.deepEqual(pageFix.value.after.issues, []);

  const baseRoot = fixture('deep wiki AppleDouble T4 base journal ');
  seedNormal(baseRoot);
  const baseBytes = new Map();
  for (let index = 1; index <= 4; index += 1) {
    const file = `._page.v${index}.md`;
    baseBytes.set(file, writeAppleDouble(path.join(baseRoot, '.wiki-meta', '.versions', file)));
  }
  const baseManifest = lintManifest();
  const baseJournal = stageInterrupted(baseRoot, baseManifest);
  assert.equal(baseJournal.contract_version, 2);
  assert.equal(baseJournal.artifacts.some((item) => item.key.startsWith('version-prune-._page')), false);
  withLock(baseRoot, (token) => state.recoverTransaction({
    wikiRoot: baseRoot, token, operationId: baseManifest.operation_id,
  }));
  for (const [file, original] of baseBytes) {
    assert.deepEqual(fs.readFileSync(path.join(baseRoot, '.wiki-meta', '.versions', file)), original);
  }

  const fixedRoot = fixture('deep wiki AppleDouble T4 fixed journal ');
  seedNormal(fixedRoot);
  const fixedBytes = new Map();
  for (let index = 1; index <= 4; index += 1) {
    const file = `._page.v${index}.md`;
    fixedBytes.set(file, writeAppleDouble(path.join(fixedRoot, '.wiki-meta', '.versions', file)));
  }
  const fixedManifest = lintManifest();
  const fixedJournal = stageInterrupted(fixedRoot, fixedManifest);
  assert.equal(fixedJournal.artifacts.some((item) => item.key.startsWith('version-prune-._page')), false);
  withLock(fixedRoot, (token) => state.recoverTransaction({
    wikiRoot: fixedRoot, token, operationId: fixedManifest.operation_id,
  }));
  for (const [file, original] of fixedBytes) {
    assert.deepEqual(fs.readFileSync(path.join(fixedRoot, '.wiki-meta', '.versions', file)), original);
  }
  assert.equal(baseBytes.size, 4);
});

test('T5 source catalog seal excludes junk while historical seal drift still cancels on base', () => {
  const state = require(statePath);
  const baseRoot = fixture('deep wiki AppleDouble T5 base ');
  seedNormal(baseRoot);
  const ordinary = path.join(baseRoot, '.wiki-meta', 'sources', 'ordinary.yaml');
  const junk = path.join(baseRoot, '.wiki-meta', 'sources', '._x.yaml');
  fs.writeFileSync(ordinary, 'origin: ordinary\ntype: file\n');
  const baseJunk = writeAppleDouble(junk);
  const baseManifest = rebuildManifest();
  stageInterrupted(baseRoot, baseManifest);
  fs.writeFileSync(junk, Buffer.concat([baseJunk, Buffer.from('drift\n')]));
  const baseRecovery = capture(() => withLock(baseRoot, (token) => state.recoverTransaction({
    wikiRoot: baseRoot, token, operationId: baseManifest.operation_id,
  })));
  assert.equal(baseRecovery.error, null);

  const fixedRoot = fixture('deep wiki AppleDouble T5 fixed ');
  seedNormal(fixedRoot);
  fs.writeFileSync(path.join(fixedRoot, '.wiki-meta', 'sources', 'ordinary.yaml'), 'origin: ordinary\ntype: file\n');
  const fixedJunk = path.join(fixedRoot, '.wiki-meta', 'sources', '._x.yaml');
  const fixedBytes = writeAppleDouble(fixedJunk);
  const fixedManifest = rebuildManifest();
  stageInterrupted(fixedRoot, fixedManifest);
  fs.writeFileSync(fixedJunk, Buffer.concat([fixedBytes, Buffer.from('drift\n')]));
  const boundaries = [];
  const fixedRecovery = capture(() => withLock(fixedRoot, (token) => state.recoverTransaction({
    wikiRoot: fixedRoot, token, operationId: fixedManifest.operation_id,
    faultInjector(boundary) { boundaries.push(boundary); },
  })));
  assert.equal(fixedRecovery.error, null, `T5 base evidence TRANSACTION_CANCELLED: ${baseRecovery.error?.message}`);
  assert.equal(boundaries.includes('catalog-seal-scan:.wiki-meta/sources/ordinary.yaml'), true);
  assert.equal(fs.existsSync(fixedJunk), true);
});

test('T6 junk-named symlinks and directories remain WIKI_STATE_FILESYSTEM', () => {
  const state = require(statePath);
  const regularRoot = fixture('deep wiki AppleDouble T6 regular ');
  seedNormal(regularRoot);
  const regular = path.join(regularRoot, 'pages', '._regular.md');
  writeAppleDouble(regular);
  const regularSnapshot = state.snapshotWiki({ wikiRoot: regularRoot });
  assert.equal(regularSnapshot.pages.includes('._regular.md'), false, `T6 base RED: ${JSON.stringify(regularSnapshot.pages)}`);
  for (const type of ['symlink', 'directory']) {
    const root = fixture(`deep wiki AppleDouble T6 ${type} `);
    seedNormal(root);
    const external = path.join(os.tmpdir(), `appledouble-external-${crypto.randomUUID()}`);
    if (type === 'symlink') fs.writeFileSync(external, 'external target\n');
    else fs.mkdirSync(external);
    roots.add(external);
    const target = path.join(root, 'pages', `._${type}.md`);
    if (type === 'symlink') fs.symlinkSync(external, target);
    else fs.mkdirSync(target);
    const snapshot = capture(() => state.snapshotWiki({ wikiRoot: root }));
    assert.equal(snapshot.error?.code, 'WIKI_STATE_FILESYSTEM');
    assert.match(snapshot.error?.message || '', /pages contains a non-regular entry/);
    const commit = capture(() => withLock(root, (token) => state.applyCommit({
      wikiRoot: root, token, manifest: lintManifest(), now: new Date(TS),
    })));
    assert.equal(commit.error?.code, 'WIKI_STATE_FILESYSTEM');
    assert.equal(fs.existsSync(external), true);
  }
});

test('T7 DT_UNKNOWN uses one lstat for real regular junk and fails closed for missing names', () => {
  const root = fixture('deep wiki AppleDouble T7 ');
  seedNormal(root);
  const stateAbsolute = require.resolve(statePath);
  const regular = spawnJsonChild(t7ChildScript(), [stateAbsolute, root, 'regular']);
  assert.equal(regular.error, null, JSON.stringify(regular));
  assert.equal(regular.value.pages.includes('._unknown.md'), false, JSON.stringify(regular));
  assert.equal(regular.pagesReads, 1);
  assert.equal(regular.injections, 1);
  assert.equal(regular.lstatCalls, 1);
  assert.equal(regular.delegatedReaddir > 0, true);
  assert.equal(regular.restored, true);

  const missing = spawnJsonChild(t7ChildScript(), [stateAbsolute, root, 'missing']);
  assert.equal(missing.error?.code, 'WIKI_STATE_FILESYSTEM');
  assert.match(missing.error?.message || '', /pages contains a non-regular entry/);
  assert.equal(missing.pagesReads, 1);
  assert.equal(missing.injections, 1);
  assert.equal(missing.lstatCalls, 1);
  assert.equal(missing.delegatedLstat > 0, true);
  assert.equal(missing.restored, true);
});

test('T8 report shape, collector errors, lstat omission, sorting, and deadline precedence', () => {
  const state = require(statePath);
  const cleanRoot = fixture('deep wiki AppleDouble T8 clean ');
  seedNormal(cleanRoot);
  assert.deepEqual(state.inspectWiki({ wikiRoot: cleanRoot }), {
    ok: true, pages: 1, events: 1, issues: [],
    ignored_os_metadata: { pages: [], sources: [], versions: [] },
    maintenance_residue: {
      prune_failures: [], promoted: [], skipped_oversized: [], quarantine_bundles: [],
      bundles: [], count: 0, truncated: false, unexpected: 0,
      oversized: false, method: 'none', estimated_entries: null,
    },
  });

  const populatedRoot = fixture('deep wiki AppleDouble T8 populated ');
  seedNormal(populatedRoot);
  writeAppleDouble(path.join(populatedRoot, 'pages', '._z.md'));
  writeAppleDouble(path.join(populatedRoot, 'pages', '._a.md'));
  writeAppleDouble(path.join(populatedRoot, '.wiki-meta', 'sources', '._b.yaml'));
  writeAppleDouble(path.join(populatedRoot, '.wiki-meta', '.versions', '._c.md'));
  const expectedReport = { pages: ['._a.md', '._z.md'], sources: ['._b.yaml'], versions: ['._c.md'] };
  const inspected = state.inspectWiki({ wikiRoot: populatedRoot });
  assert.deepEqual(inspected.ignored_os_metadata, expectedReport);
  assert.equal(inspected.ok, true);
  const cliInspect = spawnSync(process.execPath, [CLI, 'lint', 'inspect', '--wiki-root', populatedRoot, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(cliInspect.status, 0, cliInspect.stderr);
  assert.deepEqual(JSON.parse(cliInspect.stdout).ignored_os_metadata, expectedReport);
  const fixed = state.fixWiki({ wikiRoot: populatedRoot, now: new Date(TS) });
  assert.deepEqual(fixed.before.ignored_os_metadata, expectedReport);
  assert.deepEqual(fixed.after.ignored_os_metadata, expectedReport);
  assert.equal(fixed.status, 'fixed');
  for (const relative of ['pages/._z.md', 'pages/._a.md', '.wiki-meta/sources/._b.yaml', '.wiki-meta/.versions/._c.md']) {
    assert.equal(fs.existsSync(path.join(populatedRoot, relative)), true);
  }

  const cliRoot = fixture('deep wiki AppleDouble T8 CLI fix ');
  seedNormal(cliRoot);
  writeAppleDouble(path.join(cliRoot, 'pages', '._cli.md'));
  const cliFix = spawnSync(process.execPath, [CLI, 'lint', 'fix', '--wiki-root', cliRoot, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(cliFix.status, 0, cliFix.stderr);
  const cliFixValue = JSON.parse(cliFix.stdout);
  assert.equal(cliFixValue.status, 'fixed');
  assert.deepEqual(cliFixValue.before.ignored_os_metadata.pages, ['._cli.md']);
  assert.deepEqual(cliFixValue.after.ignored_os_metadata.pages, ['._cli.md']);

  const stateAbsolute = require.resolve(statePath);
  const deadlineAbsolute = require.resolve('../hooks/scripts/runtime/deadline.js');
  const eaccesRoot = fixture('deep wiki AppleDouble T8 EACCES ');
  seedNormal(eaccesRoot);
  const eacces = spawnJsonChild(t8ChildScript(), [stateAbsolute, deadlineAbsolute, eaccesRoot, 'eacces']);
  assert.equal(eacces.error?.code, 'EACCES', JSON.stringify(eacces));
  assert.equal(eacces.error?.message, 'collector versions denied');
  assert.equal(eacces.versionsReads, 2);
  assert.equal(eacces.delegatedFirst, true);
  assert.equal(eacces.restored, true);

  const unknownRoot = fixture('deep wiki AppleDouble T8 unknown ');
  seedNormal(unknownRoot);
  const unknown = spawnJsonChild(t8ChildScript(), [stateAbsolute, deadlineAbsolute, unknownRoot, 'unknown']);
  assert.equal(unknown.error, null, JSON.stringify(unknown));
  assert.equal(unknown.versionsReads, 2);
  assert.equal(unknown.injections, 1);
  assert.equal(unknown.lstatCalls, 1);
  assert.equal(unknown.value.ignored_os_metadata.versions.includes('._collector-missing.md'), false);
  assert.equal(unknown.delegatedFirst, true);
  assert.equal(unknown.restored, true);

  const deadlineRoot = fixture('deep wiki AppleDouble T8 deadline ');
  seedNormal(deadlineRoot);
  const deadline = spawnJsonChild(t8ChildScript(), [stateAbsolute, deadlineAbsolute, deadlineRoot, 'deadline']);
  assert.equal(deadline.error?.code, 'DEADLINE_EXCEEDED', JSON.stringify(deadline));
  assert.equal(deadline.error?.boundary, 'wiki-state:ignored-os-metadata:versions:._a.md');
  assert.equal(deadline.versionsReads, 2);
  assert.equal(deadline.injections, 2);
  assert.equal(deadline.lstatCalls, 0);
  assert.equal(deadline.delegatedFirst, true);
  assert.equal(deadline.restored, true);

  const precedenceRoot = fixture('deep wiki AppleDouble T8 reader precedence ');
  seedNormal(precedenceRoot);
  const precedence = spawnJsonChild(t8ChildScript(), [stateAbsolute, deadlineAbsolute, precedenceRoot, 'reader-precedence']);
  assert.equal(precedence.error?.code, 'DEADLINE_EXCEEDED');
  assert.equal(precedence.error?.boundary, 'wiki-state:read-directory:._reader.md');
  assert.equal(precedence.restored, true);
});

test('T9 valid historical contract_version 2 journal recovers a junk seal path', () => {
  const state = require(statePath);
  const root = fixture('deep wiki AppleDouble T9 historical ');
  seedNormal(root);
  const value = rebuildManifest();
  stageInterrupted(root, value);
  const journalFile = journalPath(root, value.operation_id);
  const junkPath = path.join(root, 'pages', '._junk.md');
  const junkBytes = writeAppleDouble(junkPath);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const originalSeals = structuredClone(journal.catalog_seal);
  const originalStaged = {
    before: fs.readdirSync(path.join(transactionPath(root, value.operation_id), 'before')).map((name) => fs.readFileSync(path.join(transactionPath(root, value.operation_id), 'before', name))),
    after: fs.readdirSync(path.join(transactionPath(root, value.operation_id), 'after')).map((name) => fs.readFileSync(path.join(transactionPath(root, value.operation_id), 'after', name))),
  };
  const originalHashes = {
    manifest: journal.manifest_sha256,
    artifacts: journal.artifacts_sha256,
    result: journal.result_sha256,
  };
  journal.catalog_seal.push({ relative_path: 'pages/._junk.md', sha256: sha(junkBytes) });
  journal.catalog_seal_sha256 = sha(Buffer.from(JSON.stringify(journal.catalog_seal)));
  fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
  const stagedAfterJournalEdit = {
    before: fs.readdirSync(path.join(transactionPath(root, value.operation_id), 'before')).map((name) => fs.readFileSync(path.join(transactionPath(root, value.operation_id), 'before', name))),
    after: fs.readdirSync(path.join(transactionPath(root, value.operation_id), 'after')).map((name) => fs.readFileSync(path.join(transactionPath(root, value.operation_id), 'after', name))),
  };
  assert.deepEqual(stagedAfterJournalEdit, originalStaged);
  const observed = [];
  const recovery = capture(() => withLock(root, (token) => state.recoverTransaction({
    wikiRoot: root, token, operationId: value.operation_id,
    faultInjector(boundary) { observed.push(boundary); },
  })));
  assert.equal(recovery.error, null, recovery.error?.message);
  assert.equal(journal.contract_version, 2);
  assert.deepEqual(journal.catalog_seal.slice(0, originalSeals.length), originalSeals);
  assert.deepEqual(journal.manifest_sha256, originalHashes.manifest);
  assert.deepEqual(journal.artifacts_sha256, originalHashes.artifacts);
  assert.deepEqual(journal.result_sha256, originalHashes.result);
  assert.equal(observed.includes('catalog-seal-scan:pages/._junk.md'), true);
  assert.deepEqual(fs.readFileSync(junkPath), junkBytes);
  assert.equal(fs.existsSync(transactionPath(root, value.operation_id)), false);
});
