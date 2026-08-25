'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const debris = require('../hooks/scripts/runtime/transaction-debris.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');

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
