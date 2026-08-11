'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const wikiState = require('../hooks/scripts/runtime/wiki-state.js');

const roots = new Set();

function migration() {
  return require('../hooks/scripts/runtime/config-migration.js');
}

function fixture({
  legacy = true,
  globalAutoIngest = '  ignore_globs: [archive/**, drafts/**]\n  require_tag: project\n',
  local,
} = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-local-migration-')));
  roots.add(base);
  const wikiRoot = path.join(base, 'wiki');
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  const globalPath = path.join(base, 'deep-wiki-config.yaml');
  const globalBytes = Buffer.from(`# retained comment\nwiki_root: ${wikiRoot}\n${legacy ? `auto_ingest:\n${globalAutoIngest}` : ''}obsidian_cli:\n  available: false\n`, 'utf8');
  fs.writeFileSync(globalPath, globalBytes);
  const target = path.join(wikiRoot, '.wiki-meta', '.config.json');
  if (local !== undefined) fs.writeFileSync(target, local);
  return {
    wikiRoot,
    globalPath,
    globalBytes,
    target,
    env: { DEEP_WIKI_CONFIG: globalPath, HOME: base },
  };
}

function deadline() {
  return createDeadline({ budgetMs: 1_000 });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function expiredDeadline() {
  let now = 0;
  const value = createDeadline({ budgetMs: 1, clock: { nowMs: () => now } });
  now = 1;
  return value;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('migration publishes canonical local JSON, preserves A5 keys, and never rewrites legacy YAML', () => {
  const input = fixture({
    local: '{"a5_worker_timeout_sec":90,"a5_fanout_threshold":3}\n',
  });

  const result = migration().migrateAutoIngestPolicy({
    env: input.env, wikiRoot: input.wikiRoot, deadline: deadline(), fs,
  });

  assert.deepEqual(result, {
    status: 'migrated',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'wiki_local_migrated',
  });
  assert.equal(fs.readFileSync(input.target, 'utf8'), [
    '{',
    '  "a5_fanout_threshold": 3,',
    '  "a5_worker_timeout_sec": 90,',
    '  "auto_ingest": {',
    '    "ignore_globs": [',
    '      "archive/**",',
    '      "drafts/**"',
    '    ],',
    '    "require_tag": "project"',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(fs.readFileSync(input.globalPath), input.globalBytes);
});

test('migration is idempotent for an equivalent local policy and rejects divergent or invalid local state', () => {
  const equivalent = fixture({
    local: '{"a5_fanout_threshold":3,"auto_ingest":{"require_tag":" project ","ignore_globs":["drafts/**","archive/**","archive/**"]}}\n',
  });
  let targetRenames = 0;
  const countedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return (source, destination) => {
        if (destination === equivalent.target) targetRenames += 1;
        return target.renameSync(source, destination);
      };
      return target[property];
    },
  });
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: equivalent.env, wikiRoot: equivalent.wikiRoot, deadline: deadline(), fs: countedFs,
  }), {
    status: 'already-local',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'wiki_local_migrated',
  });
  assert.equal(targetRenames, 0);

  const divergent = fixture({
    local: '{"auto_ingest":{"ignore_globs":["other/**"]}}\n',
  });
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: divergent.env, wikiRoot: divergent.wikiRoot, deadline: deadline(), fs,
  }), 'CONFIG_CONFLICT');

  const invalid = fixture({ local: '{"unknown":true}\n' });
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: invalid.env, wikiRoot: invalid.wikiRoot, deadline: deadline(), fs,
  }), 'CONFIG_INVALID');
});

test('migration converges when a cooperating host publishes an equivalent local policy before lock acquisition', () => {
  const input = fixture();
  const lockPath = path.join(input.wikiRoot, '.wiki-meta', '.wiki-lock');
  let converged = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (pathname, options) => {
        if (pathname === lockPath && !converged) {
          converged = true;
          target.writeFileSync(input.target, '{"auto_ingest":{"ignore_globs":["archive/**","drafts/**"],"require_tag":"project"}}\n');
        }
        return target.mkdirSync(pathname, options);
      };
      return target[property];
    },
  });

  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: input.env, wikiRoot: input.wikiRoot, deadline: deadline(), fs: racingFs,
  }), {
    status: 'already-local',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'wiki_local_migrated',
  });
  assert.equal(converged, true);
});

test('an expired deadline reports already-local when no migration is required', () => {
  const localOnly = fixture({
    legacy: false,
    local: '{"auto_ingest":{"ignore_globs":["local/**"]}}\n',
  });
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: localOnly.env, wikiRoot: localOnly.wikiRoot, deadline: expiredDeadline(), fs,
  }), {
    status: 'already-local',
    policy: { ignoreGlobs: ['local/**'], requireTag: null },
    policySource: 'wiki_local',
  });

  const migrated = fixture({
    local: '{"auto_ingest":{"ignore_globs":["archive/**","drafts/**"],"require_tag":"project"}}\n',
  });
  assert.equal(migration().migrateAutoIngestPolicy({
    env: migrated.env, wikiRoot: migrated.wikiRoot, deadline: expiredDeadline(), fs,
  }).status, 'already-local');

  const defaultPolicy = fixture({ legacy: false });
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: defaultPolicy.env, wikiRoot: defaultPolicy.wikiRoot, deadline: expiredDeadline(), fs,
  }), {
    status: 'already-local',
    policy: { ignoreGlobs: [], requireTag: null },
    policySource: 'default',
  });
});

for (const boundary of ['before-rename', 'before-publish']) {
  test(`migration detects target replacement at ${boundary} before publication`, () => {
    const input = fixture({ local: '{"a5_fanout_threshold":3}\n' });
    const replacement = path.join(path.dirname(input.target), 'replacement.json');
    fs.writeFileSync(replacement, '{"a5_fanout_threshold":99}\n');
    expectCode(() => migration().migrateAutoIngestPolicy({
      env: input.env,
      wikiRoot: input.wikiRoot,
      deadline: deadline(),
      fs,
      faultInjector(point) {
        if (point !== boundary) return;
        fs.renameSync(replacement, input.target);
      },
    }), 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(input.target, 'utf8'), '{"a5_fanout_threshold":99}\n');
  });
}

test('migration requires an initially absent target to remain absent at both publication boundaries', () => {
  for (const boundary of ['before-rename', 'before-publish']) {
    const input = fixture();
    expectCode(() => migration().migrateAutoIngestPolicy({
      env: input.env,
      wikiRoot: input.wikiRoot,
      deadline: deadline(),
      fs,
      faultInjector(point) {
        if (point === boundary) fs.writeFileSync(input.target, '{"a5_fanout_threshold":3}\n');
      },
    }), 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(input.target, 'utf8'), '{"a5_fanout_threshold":3}\n');
  }
});

test('migration detects an in-place target edit and a type replacement at publication boundaries', () => {
  const changed = fixture({ local: '{"a5_fanout_threshold":3}\n' });
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: changed.env,
    wikiRoot: changed.wikiRoot,
    deadline: deadline(),
    fs,
    faultInjector(point) {
      if (point === 'before-publish') fs.appendFileSync(changed.target, ' ');
    },
  }), 'CONFIG_INVALID');

  const typed = fixture({ local: '{"a5_fanout_threshold":3}\n' });
  const outside = path.join(path.dirname(typed.wikiRoot), 'outside.json');
  fs.writeFileSync(outside, '{}\n');
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: typed.env,
    wikiRoot: typed.wikiRoot,
    deadline: deadline(),
    fs,
    faultInjector(point) {
      if (point === 'before-rename') {
        fs.rmSync(typed.target);
        fs.symlinkSync(outside, typed.target);
      }
    },
  }), 'CONFIG_INVALID');
});

test('migration pins same-digest replacement identity, lock ownership, root/meta rechecks, and boundary deadlines', () => {
  const sameDigest = fixture({ local: '{"a5_fanout_threshold":3}\n' });
  const replacement = path.join(path.dirname(sameDigest.target), 'same-digest.json');
  fs.copyFileSync(sameDigest.target, replacement);
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: sameDigest.env,
    wikiRoot: sameDigest.wikiRoot,
    deadline: deadline(),
    fs,
    faultInjector(point) {
      if (point === 'before-publish') fs.renameSync(replacement, sameDigest.target);
    },
  }), 'CONFIG_INVALID');

  const lockLost = fixture();
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: lockLost.env,
    wikiRoot: lockLost.wikiRoot,
    deadline: deadline(),
    fs,
    faultInjector(point) {
      if (point !== 'before-rename') return;
      const owner = JSON.parse(fs.readFileSync(path.join(lockLost.wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json'), 'utf8'));
      releaseLock({ wikiRoot: lockLost.wikiRoot, token: owner.token });
    },
  }), 'LOCK_TOKEN_MISMATCH');
  assert.equal(fs.existsSync(lockLost.target), false);

  const rootChanged = fixture();
  const alternateRoot = fs.mkdtempSync(path.join(path.dirname(rootChanged.wikiRoot), 'alternate-root-'));
  fs.mkdirSync(path.join(alternateRoot, '.wiki-meta'));
  let useAlternateRoot = false;
  const rootFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'realpathSync') {
        const realpath = (pathname) => (useAlternateRoot && pathname === rootChanged.wikiRoot
          ? alternateRoot : target.realpathSync(pathname));
        realpath.native = realpath;
        return realpath;
      }
      return target[property];
    },
  });
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: rootChanged.env,
    wikiRoot: rootChanged.wikiRoot,
    deadline: deadline(),
    fs: rootFs,
    faultInjector(point) { if (point === 'before-rename') useAlternateRoot = true; },
  }), 'CONFIG_INVALID');
  assert.equal(fs.existsSync(rootChanged.target), false);

  const metaChanged = fixture();
  let rejectMeta = false;
  const metaPath = path.join(metaChanged.wikiRoot, '.wiki-meta');
  const metaFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') return (pathname, options) => {
        if (rejectMeta && pathname === metaPath) {
          const error = new Error('injected metadata replacement');
          error.code = 'ENOENT';
          throw error;
        }
        return target.lstatSync(pathname, options);
      };
      return target[property];
    },
  });
  expectCode(() => migration().migrateAutoIngestPolicy({
    env: metaChanged.env,
    wikiRoot: metaChanged.wikiRoot,
    deadline: deadline(),
    fs: metaFs,
    faultInjector(point) { if (point === 'before-publish') rejectMeta = true; },
  }), 'CONFIG_INVALID');
  assert.equal(fs.existsSync(metaChanged.target), false);

  let now = 0;
  const boundaryDeadline = createDeadline({ budgetMs: 1, clock: { nowMs: () => now } });
  const deadlineChanged = fixture();
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: deadlineChanged.env,
    wikiRoot: deadlineChanged.wikiRoot,
    deadline: boundaryDeadline,
    fs,
    faultInjector(point) { if (point === 'before-rename') now = 1; },
  }), {
    status: 'deferred',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'global_legacy',
  });
  assert.equal(fs.existsSync(deadlineChanged.target), false);
});

test('migration defers only before publication and reconciles a close error after rename', () => {
  const deferred = fixture();
  const before = fs.readFileSync(deferred.globalPath);
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: deferred.env,
    wikiRoot: deferred.wikiRoot,
    deadline: deadline(),
    fs,
    faultInjector(point) {
      if (point === 'before-rename') throw new Error('injected pre-publication fault');
    },
  }), {
    status: 'deferred',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'global_legacy',
  });
  assert.equal(fs.existsSync(deferred.target), false);
  assert.deepEqual(fs.readFileSync(deferred.globalPath), before);

  const reconciled = fixture();
  let renamed = false;
  let closeFaulted = false;
  const closeErrorFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return (source, destination) => {
        target.renameSync(source, destination);
        if (destination === reconciled.target) renamed = true;
      };
      if (property === 'closeSync') return (descriptor) => {
        target.closeSync(descriptor);
        if (renamed && !closeFaulted) {
          closeFaulted = true;
          throw new Error('injected close after rename');
        }
      };
      return target[property];
    },
  });
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: reconciled.env, wikiRoot: reconciled.wikiRoot, deadline: deadline(), fs: closeErrorFs,
  }), {
    status: 'migrated',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'wiki_local_migrated',
  });
});

test('migration defers on a cooperative foreign lock or exhaustion before mutation and is exported through wiki state', () => {
  const contended = fixture();
  const owner = acquireLock({ wikiRoot: contended.wikiRoot, operation: 'cooperative-writer' });
  try {
    assert.deepEqual(migration().migrateAutoIngestPolicy({
      env: contended.env, wikiRoot: contended.wikiRoot, deadline: deadline(), fs,
    }), {
      status: 'deferred',
      policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
      policySource: 'global_legacy',
    });
    assert.equal(fs.existsSync(contended.target), false);
  } finally {
    releaseLock({ wikiRoot: contended.wikiRoot, token: owner.token });
  }

  let now = 0;
  const exhausted = createDeadline({ budgetMs: 1, clock: { nowMs: () => now } });
  now = 1;
  assert.deepEqual(migration().migrateAutoIngestPolicy({
    env: contended.env, wikiRoot: contended.wikiRoot, deadline: exhausted, fs,
  }), {
    status: 'deferred',
    policy: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    policySource: 'global_legacy',
  });
  assert.equal(fs.existsSync(contended.target), false);
  assert.equal(wikiState.migrateAutoIngestPolicy, migration().migrateAutoIngestPolicy);
});
