'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const debris = require('../hooks/scripts/runtime/transaction-debris.js');
const fsSafe = require('../hooks/scripts/runtime/fs-safe.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const markerFixture = require('./helpers/maintenance-marker-fixture.js');

const roots = new Set();

function temporaryDirectory(prefix = 'deep wiki pressure ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(root);
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function deadline(options = {}) {
  return createDeadline({ budgetMs: 12_000, ...options });
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

function ioError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pressureFs({ stat, entries = [], onOpendir, onRead, onLstat } = {}) {
  const calls = { lstatSync: 0, opendirSync: 0, readdirSync: 0, readSync: 0, closeSync: 0 };
  return {
    calls,
    fs: {
      lstatSync(pathname, options) {
        calls.lstatSync += 1;
        if (typeof onLstat === 'function') onLstat(pathname, options, calls);
        if (stat instanceof Error) throw stat;
        if (typeof stat === 'function') return stat(pathname, options);
        return stat;
      },
      opendirSync(pathname) {
        calls.opendirSync += 1;
        if (typeof onOpendir === 'function') onOpendir(pathname, calls);
        let index = 0;
        return {
          readSync() {
            calls.readSync += 1;
            if (typeof onRead === 'function') onRead(calls);
            if (index >= entries.length) return null;
            const entry = entries[index];
            index += 1;
            return entry;
          },
          closeSync() { calls.closeSync += 1; },
        };
      },
      readdirSync() {
        calls.readdirSync += 1;
        throw new Error('readdirSync must not be used for directory pressure');
      },
    },
  };
}

function inspect(pathname, options = {}) {
  return debris.inspectDirectoryPressure(pathname, {
    deadline: options.deadline || deadline(),
    ...options,
  });
}

test('pressure constants match the §0.1 thresholds', () => {
  assert.equal(debris.PRESSURE_ENTRY_CAP, 4096);
  assert.equal(debris.PRESSURE_SIZE_THRESHOLD, 196608);
  assert.equal(debris.PRESSURE_NLINK_THRESHOLD, 512);
});

test('APFS-shaped size above threshold is oversized by tier-1 without enumeration', () => {
  const size = 250000n;
  const { fs: injected, calls } = pressureFs({
    stat: { nlink: 2n, size, isDirectory: () => true, isSymbolicLink: () => false },
  });
  const result = inspect('/wiki/.wiki-meta/.transactions/orphan', {
    allowEnumeration: true,
    fs: injected,
  });
  assert.deepEqual(result, {
    oversized: true,
    method: 'stat',
    estimatedEntries: Number(size / 48n),
  });
  assert.equal(calls.opendirSync, 0);
  assert.equal(calls.readdirSync, 0);
});

test('APFS-shaped nlink above threshold is oversized by tier-1 without enumeration', () => {
  const nlink = 600n;
  const { fs: injected, calls } = pressureFs({
    stat: { nlink, size: 64n, isDirectory: () => true, isSymbolicLink: () => false },
  });
  const result = inspect('/wiki/.wiki-meta/.transactions/orphan', {
    allowEnumeration: true,
    fs: injected,
  });
  assert.deepEqual(result, {
    oversized: true,
    method: 'stat',
    estimatedEntries: Number(nlink),
  });
  assert.equal(calls.opendirSync, 0);
});

test('FUSE-shaped stat is oversized by tier-1 without enumeration', () => {
  const size = 2_097_120n;
  const { fs: injected, calls } = pressureFs({
    stat: { nlink: 65535n, size, isDirectory: () => true, isSymbolicLink: () => false },
  });
  const result = inspect('/wiki/.wiki-meta/.transactions/orphan', {
    allowEnumeration: true,
    fs: injected,
  });
  assert.equal(result.oversized, true);
  assert.equal(result.method, 'stat');
  assert.equal(result.estimatedEntries, Number(size / 48n));
  assert.equal(calls.opendirSync, 0);
  assert.equal(calls.readSync, 0);
});

test('NTFS-shaped stat has no signal and does not enumerate when allowEnumeration is false', () => {
  const { fs: injected, calls } = pressureFs({
    stat: { nlink: 1n, size: 0n, isDirectory: () => true, isSymbolicLink: () => false },
    entries: [{ name: 'a' }, { name: 'b' }],
  });
  const result = inspect('/wiki/.wiki-meta/.transactions/orphan', {
    allowEnumeration: false,
    fs: injected,
  });
  assert.deepEqual(result, { oversized: false, method: 'none', estimatedEntries: null });
  assert.equal(calls.opendirSync, 0);
  assert.equal(calls.readdirSync, 0);
});

test('NTFS-shaped stat enumerates only when allowEnumeration is true', () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({ name: `e${index}` }));
  const { fs: injected, calls } = pressureFs({
    stat: { nlink: 1n, size: 0n, isDirectory: () => true, isSymbolicLink: () => false },
    entries,
  });
  const result = inspect('/wiki/.wiki-meta/.transactions/orphan', {
    entryCap: 32,
    allowEnumeration: true,
    fs: injected,
  });
  assert.deepEqual(result, { oversized: false, method: 'enumeration', estimatedEntries: 8 });
  assert.equal(calls.opendirSync, 1);
  assert.equal(calls.closeSync, 1);
  assert.equal(calls.readdirSync, 0);
});

test('ENOENT is not oversized', () => {
  const { fs: injected, calls } = pressureFs({ stat: ioError('ENOENT') });
  const result = inspect('/missing', { allowEnumeration: true, fs: injected });
  assert.deepEqual(result, { oversized: false, method: 'none', estimatedEntries: null });
  assert.equal(calls.opendirSync, 0);
});

test('non-ENOENT lstat failures fail closed as WIKI_STATE_FILESYSTEM', () => {
  const { fs: injected } = pressureFs({ stat: ioError('EACCES', 'denied') });
  assert.throws(
    () => inspect('/denied', { allowEnumeration: true, fs: injected }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && /unavailable/.test(error.message),
  );
});

test('real directory at injected cap is not oversized; cap+1 is oversized by enumeration', () => {
  const cap = 32;
  const directory = temporaryDirectory();
  for (let index = 0; index < cap; index += 1) {
    fs.writeFileSync(path.join(directory, `e${index}`), '');
  }
  const atCap = inspect(directory, { entryCap: cap, allowEnumeration: true });
  assert.equal(atCap.oversized, false);
  assert.equal(atCap.method, 'enumeration');
  assert.equal(atCap.estimatedEntries, cap);

  fs.writeFileSync(path.join(directory, 'extra'), '');
  const over = inspect(directory, { entryCap: cap, allowEnumeration: true });
  assert.equal(over.oversized, true);
  assert.equal(over.method, 'enumeration');
  assert.equal(over.estimatedEntries, cap + 1);
});

test('tier-2 enumeration asserts the deadline on each entry and still closes the directory', () => {
  const clock = { now: 0, nowMs() { return this.now; } };
  const { fs: injected, calls } = pressureFs({
    stat: { nlink: 1n, size: 0n, isDirectory: () => true, isSymbolicLink: () => false },
    entries: Array.from({ length: 8 }, (_, index) => ({ name: `e${index}` })),
    onRead(callsSoFar) {
      if (callsSoFar.readSync >= 3) clock.now = 10;
    },
  });
  assert.throws(
    () => inspect('/wiki/.wiki-meta/.transactions/orphan', {
      deadline: createDeadline({ clock, budgetMs: 10 }),
      entryCap: 32,
      allowEnumeration: true,
      fs: injected,
    }),
    (error) => error.code === 'DEADLINE_EXCEEDED',
  );
  assert.equal(calls.closeSync, 1);
});

test('allowEnumeration false never calls opendirSync even on a real directory', () => {
  const directory = temporaryDirectory();
  fs.writeFileSync(path.join(directory, 'only'), '');
  const calls = [];
  const spy = {
    lstatSync(...args) { return fs.lstatSync(...args); },
    opendirSync(...args) {
      calls.push('opendirSync');
      return fs.opendirSync(...args);
    },
    readdirSync(...args) {
      calls.push('readdirSync');
      return fs.readdirSync(...args);
    },
  };
  const result = inspect(directory, { allowEnumeration: false, fs: spy });
  assert.equal(result.oversized, false);
  assert.equal(result.method, 'none');
  assert.deepEqual(calls, []);
});

test('resolveUnknownDirent uses the known type without lstat', () => {
  const calls = [];
  const injected = { lstatSync() { calls.push('lstatSync'); throw new Error('must not lstat'); } };
  assert.deepEqual(
    debris.resolveUnknownDirent('/store', fakeDirent('tx', 'directory'), injected),
    { kind: 'directory' },
  );
  assert.deepEqual(
    debris.resolveUnknownDirent('/store', fakeDirent('tx', 'symlink'), injected),
    { kind: 'symlink' },
  );
  assert.deepEqual(
    debris.resolveUnknownDirent('/store', fakeDirent('tx', 'file'), injected),
    { kind: 'other' },
  );
  assert.deepEqual(calls, []);
});

test('resolveUnknownDirent settles DT_UNKNOWN with one direct-child lstat', () => {
  const directory = temporaryDirectory();
  fs.mkdirSync(path.join(directory, 'dir'));
  fs.writeFileSync(path.join(directory, 'file'), '');
  fs.symlinkSync('dir', path.join(directory, 'link'));

  const calls = [];
  const spy = {
    lstatSync(target) {
      calls.push(path.basename(target));
      return fs.lstatSync(target);
    },
  };
  assert.deepEqual(
    debris.resolveUnknownDirent(directory, fakeDirent('dir'), spy),
    { kind: 'directory' },
  );
  assert.deepEqual(
    debris.resolveUnknownDirent(directory, fakeDirent('file'), spy),
    { kind: 'other' },
  );
  assert.deepEqual(
    debris.resolveUnknownDirent(directory, fakeDirent('link'), spy),
    { kind: 'symlink' },
  );
  assert.deepEqual(calls, ['dir', 'file', 'link']);
});

test('resolveUnknownDirent lookup failure is fail-closed as unresolved', () => {
  const injected = {
    lstatSync() { throw ioError('ENOENT'); },
  };
  assert.deepEqual(
    debris.resolveUnknownDirent('/store', fakeDirent('gone'), injected),
    { kind: 'unresolved' },
  );
  injected.lstatSync = () => { throw ioError('EACCES'); };
  assert.deepEqual(
    debris.resolveUnknownDirent('/store', fakeDirent('denied'), injected),
    { kind: 'unresolved' },
  );
});

function wikiFixture() {
  const root = temporaryDirectory();
  markerFixture.ensureWikiMeta(root);
  return root;
}

function withLock(root, callback) {
  const owner = acquireLock({
    wikiRoot: root,
    operation: 'pressure-marker-test',
    now: new Date('2026-08-25T00:00:00Z'),
  });
  try { return callback(owner.token); }
  finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function assertNoSecret(error, secret) {
  assert.equal(error.message.includes(secret), false, error.message);
  assert.equal(JSON.stringify(error).includes(secret), false);
}

test('descriptorMatchesPathIdentity uses directional Windows fd-vs-path dev compatibility', () => {
  const pathIdentity = {
    dev: 0x1_0000_0002n, ino: 10n, type: 0o100000n,
    birthtimeNs: 1n, mtimeNs: 2n, nlink: 1n,
  };
  const fdIdentity = { ...pathIdentity, dev: 0x2n };
  assert.equal(fsSafe.devicesCompatible(fdIdentity.dev, pathIdentity.dev), true);
  assert.equal(fsSafe.descriptorMatchesPathIdentity(fdIdentity, pathIdentity), true);
  assert.equal(fsSafe.descriptorMatchesPathIdentity({ ...fdIdentity, ino: 11n }, pathIdentity), false);
  assert.equal(fsSafe.descriptorMatchesPathIdentity({ ...fdIdentity, nlink: 2n }, pathIdentity), false);
});

test('upsertQuarantineBundle keeps position, refuses duplicate keys, and evicts from the head', () => {
  const first = markerFixture.bundleRecord({ state: 'pending' }, 0);
  const second = markerFixture.bundleRecord({ state: 'pending' }, 1);
  let marker = debris.upsertQuarantineBundle(markerFixture.emptyMarker(), first);
  marker = debris.upsertQuarantineBundle(marker, second);
  const complete = { ...first, state: 'complete', at: '2026-08-25T01:00:00Z' };
  marker = debris.upsertQuarantineBundle(marker, complete);
  assert.equal(marker.quarantine_bundles.length, 2);
  assert.equal(marker.quarantine_bundles[0].state, 'complete');
  assert.equal(marker.quarantine_bundles[0].bundle, first.bundle);
  assert.equal(marker.quarantine_bundles[1].bundle, second.bundle);

  let filled = markerFixture.emptyMarker();
  for (let index = 0; index < 65; index += 1) {
    filled = debris.upsertQuarantineBundle(filled, markerFixture.bundleRecord({ state: 'pending' }, index));
  }
  assert.equal(filled.quarantine_bundles.length, 64);
  assert.equal(filled.quarantine_bundles[0].bundle, markerFixture.bundleName({}, 1));
  assert.equal(filled.quarantine_bundles[63].bundle, markerFixture.bundleName({}, 64));
});

test('removePendingQuarantineBundle removes pending only', () => {
  const pending = markerFixture.bundleRecord({ state: 'pending' }, 0);
  const incomplete = markerFixture.bundleRecord({ state: 'incomplete' }, 1);
  let marker = debris.upsertQuarantineBundle(markerFixture.emptyMarker(), pending);
  marker = debris.upsertQuarantineBundle(marker, incomplete);
  marker = debris.removePendingQuarantineBundle(marker, pending.bundle);
  assert.equal(marker.quarantine_bundles.length, 1);
  assert.equal(marker.quarantine_bundles[0].bundle, incomplete.bundle);
  const refused = debris.removePendingQuarantineBundle(marker, incomplete.bundle);
  assert.equal(refused.quarantine_bundles.length, 1);
  assert.equal(refused.quarantine_bundles[0].state, 'incomplete');
});

test('maintenance marker schema rejects operation_id at any depth and round-trips without it', () => {
  const root = wikiFixture();
  withLock(root, (token) => {
    const written = debris.writeMaintenanceMarker(root, token, (current) => {
      current.promoted = ['scan-window-ensure-aa'];
      return current;
    });
    assert.equal(Object.hasOwn(written, 'operation_id'), false);
    assert.equal(JSON.stringify(written).includes('operation_id'), false);
    const parsed = JSON.parse(fs.readFileSync(markerFixture.markerPath(root), 'utf8'));
    assert.equal(Object.hasOwn(parsed, 'operation_id'), false);
    assert.deepEqual(Object.keys(parsed), [
      'schema', 'updated_at', 'prune_failures', 'promoted', 'skipped_oversized', 'quarantine_bundles',
    ]);
  });
});

test('writeMaintenanceMarker is atomic and invokes the ancestor-seal callback', () => {
  const root = wikiFixture();
  let seals = 0;
  withLock(root, (token) => {
    debris.writeMaintenanceMarker(root, token, (current) => {
      current.skipped_oversized = ['orphan'];
      return current;
    }, {
      beforePublish() { seals += 1; },
    });
  });
  assert.equal(seals >= 1, true);
  assert.equal(fs.existsSync(markerFixture.markerPath(root)), true);
});

test('writeMaintenanceMarker removes an idle marker', () => {
  const root = wikiFixture();
  withLock(root, (token) => {
    debris.writeMaintenanceMarker(root, token, (current) => {
      current.promoted = ['once'];
      return current;
    });
    debris.writeMaintenanceMarker(root, token, (current) => {
      current.promoted = [];
      return current;
    });
  });
  assert.equal(fs.existsSync(markerFixture.markerPath(root)), false);
});

test('readMaintenanceMarker returns null when wiki-meta, runtime, or the marker is absent', () => {
  const missingMeta = temporaryDirectory();
  assert.equal(debris.readMaintenanceMarker(missingMeta), null);
  const missingRuntime = wikiFixture();
  assert.equal(debris.readMaintenanceMarker(missingRuntime), null);
  markerFixture.ensureRuntime(missingRuntime);
  assert.equal(debris.readMaintenanceMarker(missingRuntime), null);
});

test('readMaintenanceMarker fail-closes parent symlinks without exposing the target name', () => {
  const secret = `secret-target-${Date.now()}`;
  for (const [label, install] of [
    ['.runtime', (root, target) => markerFixture.replaceWithSymlink(markerFixture.runtimePath(root), target)],
    ['.wiki-meta', (root, target) => markerFixture.replaceWithSymlink(markerFixture.metaPath(root), target)],
  ]) {
    for (const kind of ['internal', 'external', 'dangling']) {
      const root = wikiFixture();
      markerFixture.ensureRuntime(root);
      markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({
        promoted: ['keep'],
      })));
      const target = kind === 'internal'
        ? path.join(root, secret)
        : kind === 'external'
          ? path.join(temporaryDirectory(), secret)
          : path.join(temporaryDirectory(), secret);
      if (kind !== 'dangling') fs.mkdirSync(target, { recursive: true });
      install(root, target);
      assert.throws(
        () => debris.readMaintenanceMarker(root),
        (error) => {
          assert.equal(error.code, 'WIKI_STATE_FILESYSTEM');
          assertNoSecret(error, secret);
          return true;
        },
      );
    }
  }
});

test('readMaintenanceMarker rejects a symlink marker leaf before open', () => {
  const root = wikiFixture();
  markerFixture.ensureRuntime(root);
  const target = path.join(root, 'elsewhere.json');
  fs.writeFileSync(target, '{"secret":true}\n');
  fs.symlinkSync(target, markerFixture.markerPath(root));
  let opened = 0;
  const spy = {
    ...fs,
    openSync(...args) { opened += 1; return fs.openSync(...args); },
  };
  assert.throws(
    () => debris.readMaintenanceMarker(root, { fs: spy }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  );
  assert.equal(opened, 0);
});

test('readMaintenanceMarker rejects a file-swap between lstat and open without exposing bytes', () => {
  const root = wikiFixture();
  const original = markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({ promoted: ['original'] }));
  markerFixture.writeRawMarker(root, original);
  const swapped = path.join(root, 'swapped.json');
  fs.writeFileSync(swapped, '{"schema":1,"secret":"nope"}\n');
  assert.throws(
    () => debris.readMaintenanceMarker(root, {
      faultInjector(boundary) {
        if (boundary === 'after-leaf-lstat') {
          fs.rmSync(markerFixture.markerPath(root));
          fs.renameSync(swapped, markerFixture.markerPath(root));
        }
      },
    }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && !/nope/.test(error.message),
  );
});

test('readMaintenanceMarker rejects a parent-swap with identity changed mid-read', () => {
  const root = wikiFixture();
  markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({
    promoted: ['keep'],
  })));
  const displaced = path.join(root, '.runtime.displaced');
  assert.throws(
    () => debris.readMaintenanceMarker(root, {
      faultInjector(boundary) {
        if (boundary === 'after-parent-capture') {
          fs.renameSync(markerFixture.runtimePath(root), displaced);
          fs.mkdirSync(markerFixture.runtimePath(root));
          fs.writeFileSync(markerFixture.markerPath(root), '{"schema":1}\n');
        }
      },
    }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && /identity changed mid-read/.test(error.message),
  );
});

test('readMaintenanceMarker discards bytes when post-read revalidation fails', () => {
  const root = wikiFixture();
  markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({
    promoted: ['visible-if-leaked'],
  })));
  const result = (() => {
    try {
      return {
        value: debris.readMaintenanceMarker(root, {
          faultInjector(boundary) {
            if (boundary === 'after-read') {
              fs.renameSync(markerFixture.runtimePath(root), path.join(root, '.runtime.gone'));
              fs.mkdirSync(markerFixture.runtimePath(root));
            }
          },
        }),
      };
    } catch (error) {
      return { error };
    }
  })();
  assert.equal(result.value, undefined);
  assert.equal(result.error?.code, 'WIKI_STATE_FILESYSTEM');
  assert.equal(JSON.stringify(result.error || {}).includes('visible-if-leaked'), false);
});

test('readMaintenanceMarker rejects an oversized marker before reading the body', () => {
  const root = wikiFixture();
  markerFixture.writeRawMarker(root, Buffer.alloc(debris.MAINTENANCE_MARKER_MAX_BYTES + 1, 0x20));
  let reads = 0;
  const spy = {
    ...fs,
    readSync(...args) { reads += 1; return fs.readSync(...args); },
  };
  assert.throws(
    () => debris.readMaintenanceMarker(root, { fs: spy }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  );
  assert.equal(reads, 0);
});

test('readMaintenanceMarker rejects in-place growth and shrink of the same inode', () => {
  const root = wikiFixture();
  const bytes = markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({ promoted: ['grow'] }));
  markerFixture.writeRawMarker(root, bytes);
  assert.throws(
    () => debris.readMaintenanceMarker(root, {
      faultInjector(boundary) {
        if (boundary === 'after-fstat') fs.writeFileSync(markerFixture.markerPath(root), Buffer.concat([bytes, Buffer.from('x')]));
      },
    }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  );
  markerFixture.writeRawMarker(root, bytes);
  assert.throws(
    () => debris.readMaintenanceMarker(root, {
      faultInjector(boundary) {
        if (boundary === 'after-fstat') fs.writeFileSync(markerFixture.markerPath(root), bytes.subarray(0, bytes.length - 4));
      },
    }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  );
});

test('readMaintenanceMarker fail-closes EACCES on parent and leaf', () => {
  const root = wikiFixture();
  markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker()));
  const denied = {
    ...fs,
    lstatSync(target, options) {
      if (String(target).includes('.wiki-meta')) throw ioError('EACCES');
      return fs.lstatSync(target, options);
    },
  };
  assert.throws(
    () => debris.readMaintenanceMarker(root, { fs: denied }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && /unavailable/.test(error.message),
  );
});

test('count-capped marker fits the byte budget without eviction', () => {
  const root = wikiFixture();
  const filled = markerFixture.countCappedMarker();
  assert.equal(markerFixture.canonicalMarkerBytes(filled).length <= debris.MAINTENANCE_MARKER_MAX_BYTES, true);
  withLock(root, (token) => {
    debris.writeMaintenanceMarker(root, token, () => filled);
  });
  const roundTrip = debris.readMaintenanceMarker(root);
  assert.equal(roundTrip.quarantine_bundles.length, 64);
  assert.equal(roundTrip.promoted.length, 32);
  assert.equal(roundTrip.skipped_oversized.length, 32);
  assert.equal(roundTrip.prune_failures.length, 8);
});

test('worst-case admitted-name marker round-trips at or under the byte budget', () => {
  const root = wikiFixture();
  const probe = temporaryDirectory();
  const fitted = markerFixture.maxFittingMarkerBytes(debris.MAINTENANCE_MARKER_MAX_BYTES, probe);
  withLock(root, (token) => {
    debris.writeMaintenanceMarker(root, token, () => fitted.marker);
  });
  const published = fs.readFileSync(markerFixture.markerPath(root));
  assert.equal(published.length <= debris.MAINTENANCE_MARKER_MAX_BYTES, true);
  const roundTrip = debris.readMaintenanceMarker(root);
  assert.equal(roundTrip.promoted.length, fitted.marker.promoted.length);
  assert.equal(roundTrip.skipped_oversized.length, fitted.marker.skipped_oversized.length);
});

test('byte-budget eviction follows complete, skipped, promoted, prune_failures, then active bundles', () => {
  const root = wikiFixture();
  const marker = markerFixture.emptyMarker({
    prune_failures: [{ code: 'P0', at: '2026-08-25T00:00:00Z' }],
    promoted: ['promoted-old', 'promoted-new'],
    skipped_oversized: ['skip-old', 'skip-new'],
    quarantine_bundles: [
      markerFixture.bundleRecord({ state: 'complete', source_name: 'complete-old' }, 0),
      markerFixture.bundleRecord({ state: 'complete', source_name: 'complete-new' }, 1),
      markerFixture.bundleRecord({ state: 'pending', source_name: 'pending-old' }, 2),
      markerFixture.bundleRecord({ state: 'incomplete', source_name: 'incomplete-old' }, 3),
    ],
  });
  const observed = [];
  withLock(root, (token) => {
    assert.throws(
      () => debris.writeMaintenanceMarker(root, token, () => JSON.parse(JSON.stringify(marker)), {
        maxBytes: 1,
        atomicWriteFile() { throw new Error('must not publish while forcing eviction observation'); },
        onEvict(kind, record) { observed.push(`${kind}:${record}`); },
      }),
      (error) => error.code === 'WIKI_STATE_INVALID',
    );
  });
  const uniqueOrder = observed.map((entry) => entry.split(':')[0])
    .filter((kind, index, all) => all.indexOf(kind) === index);
  assert.deepEqual(uniqueOrder, [
    'complete', 'skipped_oversized', 'promoted', 'prune_failures', 'active',
  ]);
  assert.equal(observed[0], 'complete:complete-old');
  assert.equal(observed[1], 'complete:complete-new');
  assert.equal(observed[2], 'skipped_oversized:skip-old');
});

test('single-record overflow fail-closes without calling atomicWriteFile or changing the existing marker', () => {
  const root = wikiFixture();
  const existing = markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({ promoted: ['keep-me'] }));
  markerFixture.writeRawMarker(root, existing);
  let writes = 0;
  withLock(root, (token) => {
    assert.throws(
      () => debris.writeMaintenanceMarker(root, token, () => markerFixture.emptyMarker({
        promoted: ['x'.repeat(2000)],
      }), {
        maxBytes: 64,
        atomicWriteFile() { writes += 1; },
      }),
      (error) => error.code === 'WIKI_STATE_INVALID' || error.code === 'WIKI_STATE_FILESYSTEM',
    );
  });
  assert.equal(writes, 0);
  assert.deepEqual(fs.readFileSync(markerFixture.markerPath(root)), existing);
});

test('listQuarantineBundleNames returns empty when .quarantine is absent', () => {
  const root = wikiFixture();
  assert.deepEqual(
    debris.listQuarantineBundleNames(root, { deadline: deadline() }),
    {
      bundles: [], count: 0, truncated: false, unexpected: 0,
      oversized: false, method: 'none', estimated_entries: null,
    },
  );
});

test('listQuarantineBundleNames reports matching names only and never joins bundle children', () => {
  const root = wikiFixture();
  const quarantine = markerFixture.quarantinePath(root);
  const first = markerFixture.bundleName({}, 0);
  const second = markerFixture.bundleName({}, 1);
  fs.mkdirSync(path.join(quarantine, first, 'tree'), { recursive: true });
  fs.writeFileSync(path.join(quarantine, first, 'quarantine.meta.json'), '{}\n');
  fs.mkdirSync(path.join(quarantine, second), { recursive: true });
  fs.writeFileSync(path.join(quarantine, 'not-a-bundle'), '');
  const calls = [];
  const spy = {
    ...fs,
    lstatSync(target, options) {
      calls.push({ method: 'lstatSync', target });
      return fs.lstatSync(target, options);
    },
    openSync(target, ...rest) {
      calls.push({ method: 'openSync', target });
      return fs.openSync(target, ...rest);
    },
    readdirSync(target, options) {
      calls.push({ method: 'readdirSync', target });
      return fs.readdirSync(target, options);
    },
    readFileSync(target, ...rest) {
      calls.push({ method: 'readFileSync', target });
      return fs.readFileSync(target, ...rest);
    },
  };
  const result = debris.listQuarantineBundleNames(root, { deadline: deadline(), fs: spy });
  assert.deepEqual(result.bundles, [first, second].sort());
  assert.equal(result.count, 2);
  assert.equal(result.unexpected, 1);
  assert.equal(result.truncated, false);
  const interior = calls.filter(({ target }) => {
    const relative = path.relative(quarantine, String(target));
    const parts = relative.split(path.sep);
    return relative !== '' && !relative.startsWith('..') && parts.length > 1;
  });
  assert.deepEqual(interior, []);
});

test('listQuarantineBundleNames fail-closes a .quarantine symlink without exposing the target', () => {
  const secret = `q-secret-${Date.now()}`;
  for (const kind of ['internal', 'external', 'dangling']) {
    const root = wikiFixture();
    const target = kind === 'internal'
      ? path.join(root, secret)
      : path.join(temporaryDirectory(), secret);
    if (kind !== 'dangling') fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(markerFixture.metaPath(root), { recursive: true });
    fs.symlinkSync(target, markerFixture.quarantinePath(root));
    assert.throws(
      () => debris.listQuarantineBundleNames(root, { deadline: deadline() }),
      (error) => {
        assert.equal(error.code, 'WIKI_STATE_FILESYSTEM');
        assertNoSecret(error, secret);
        return true;
      },
    );
  }
});

test('listQuarantineBundleNames fail-closes a .wiki-meta symlink', () => {
  const secret = `meta-secret-${Date.now()}`;
  const root = temporaryDirectory();
  const target = path.join(temporaryDirectory(), secret);
  fs.mkdirSync(target);
  fs.symlinkSync(target, markerFixture.metaPath(root));
  assert.throws(
    () => debris.listQuarantineBundleNames(root, { deadline: deadline() }),
    (error) => {
      assert.equal(error.code, 'WIKI_STATE_FILESYSTEM');
      assertNoSecret(error, secret);
      return true;
    },
  );
});

test('listQuarantineBundleNames fail-closes a mid-inventory replacement', () => {
  const root = wikiFixture();
  const quarantine = markerFixture.quarantinePath(root);
  fs.mkdirSync(path.join(quarantine, markerFixture.bundleName({}, 0)), { recursive: true });
  assert.throws(
    () => debris.listQuarantineBundleNames(root, {
      deadline: deadline(),
      faultInjector(boundary) {
        if (boundary === 'after-readdir') {
          fs.renameSync(quarantine, path.join(root, '.quarantine.gone'));
          fs.mkdirSync(quarantine);
        }
      },
    }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && /identity changed mid-inventory/.test(error.message),
  );
});

test('listQuarantineBundleNames fail-closes EACCES as unavailable', () => {
  const root = wikiFixture();
  fs.mkdirSync(markerFixture.quarantinePath(root));
  const denied = {
    ...fs,
    lstatSync(target, options) {
      if (String(target).includes('.quarantine')) throw ioError('EACCES');
      return fs.lstatSync(target, options);
    },
  };
  assert.throws(
    () => debris.listQuarantineBundleNames(root, { deadline: deadline(), fs: denied }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM' && /unavailable/.test(error.message),
  );
});

test('listQuarantineBundleNames skips symlink children and counts unexpected names only', () => {
  const root = wikiFixture();
  const quarantine = markerFixture.quarantinePath(root);
  const bundle = markerFixture.bundleName({}, 0);
  fs.mkdirSync(path.join(quarantine, bundle), { recursive: true });
  fs.symlinkSync(bundle, path.join(quarantine, 'link-child'));
  fs.writeFileSync(path.join(quarantine, 'regular-file'), '');
  const result = debris.listQuarantineBundleNames(root, { deadline: deadline() });
  assert.deepEqual(result.bundles, [bundle]);
  assert.equal(result.unexpected >= 1, true);
  assert.equal(result.bundles.includes('link-child'), false);
});

test('listQuarantineBundleNames settles DT_UNKNOWN children with one lstat', () => {
  const root = wikiFixture();
  const quarantine = markerFixture.quarantinePath(root);
  const bundle = markerFixture.bundleName({}, 0);
  fs.mkdirSync(path.join(quarantine, bundle), { recursive: true });
  const original = fs.readdirSync;
  const lstatTargets = [];
  const spy = {
    ...fs,
    readdirSync(target, options) {
      const entries = original.call(fs, target, options);
      if (path.resolve(target) === path.resolve(quarantine)) {
        return entries.map((entry) => (entry.name === bundle ? fakeDirent(bundle) : entry));
      }
      return entries;
    },
    lstatSync(target, options) {
      lstatTargets.push(path.basename(target));
      return fs.lstatSync(target, options);
    },
  };
  const result = debris.listQuarantineBundleNames(root, { deadline: deadline(), fs: spy });
  assert.deepEqual(result.bundles, [bundle]);
  assert.equal(lstatTargets.includes(bundle), true);
});

test('injected tier-1 oversized .quarantine skips readdir and reports oversized', () => {
  const root = wikiFixture();
  fs.mkdirSync(markerFixture.quarantinePath(root));
  let reads = 0;
  const spy = {
    ...fs,
    lstatSync(target, options) {
      if (path.resolve(target) === path.resolve(markerFixture.quarantinePath(root))) {
        return { nlink: 600n, size: 64n, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o040000n, ino: 1n, dev: 1n, birthtimeNs: 1n };
      }
      return fs.lstatSync(target, options);
    },
    readdirSync(target, options) {
      reads += 1;
      return fs.readdirSync(target, options);
    },
  };
  const result = debris.listQuarantineBundleNames(root, { deadline: deadline(), fs: spy });
  assert.equal(result.oversized, true);
  assert.deepEqual(result.bundles, []);
  assert.equal(reads, 0);
});

test('listQuarantineBundleNames truncates after 64 names', () => {
  const root = wikiFixture();
  const quarantine = markerFixture.quarantinePath(root);
  for (let index = 0; index < 65; index += 1) {
    fs.mkdirSync(path.join(quarantine, markerFixture.bundleName({}, index)), { recursive: true });
  }
  const result = debris.listQuarantineBundleNames(root, { deadline: deadline() });
  assert.equal(result.count, 65);
  assert.equal(result.bundles.length, 64);
  assert.equal(result.truncated, true);
});

