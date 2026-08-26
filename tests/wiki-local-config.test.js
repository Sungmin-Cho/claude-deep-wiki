'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require(path.join(__dirname, '..', 'hooks', 'scripts', 'runtime', 'config.js'));
const cli = path.join(__dirname, '..', 'scripts', 'wiki-runtime.js');
const temporaryRoots = new Set();

function temporaryRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-local-config-')));
  temporaryRoots.add(root);
  return root;
}

function localPath(wikiRoot) {
  return path.join(wikiRoot, '.wiki-meta', '.config.json');
}

function writeLocal(wikiRoot, source) {
  const target = localPath(wikiRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

function nestedArrayJson(depth) {
  return `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
}

function nestedObjectJson(depth) {
  let source = '"x"';
  for (let index = 0; index < depth; index += 1) source = `{"x":${source}}`;
  return source;
}

function globalConfig(wikiRoot, autoIngestDefined, autoIngest = {}) {
  return {
    wikiRoot,
    autoIngestDefined,
    autoIngest: { ignoreGlobs: autoIngest.ignoreGlobs || [], requireTag: autoIngest.requireTag || null },
    obsidianCli: { enabled: false, vaultPath: null, vaultName: null, wikiPrefix: null },
  };
}

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('loadWikiLocalConfig distinguishes an absent file from an explicit empty local policy', () => {
  const wikiRoot = temporaryRoot();
  const absent = config.loadWikiLocalConfig(wikiRoot);
  assert.deepEqual(absent, {
    status: 'absent', path: localPath(wikiRoot), autoIngestDefined: false, config: null,
  });

  writeLocal(wikiRoot, '{"auto_ingest":{}}\n');
  const present = config.loadWikiLocalConfig(wikiRoot);
  assert.equal(present.status, 'present');
  assert.equal(present.path, localPath(wikiRoot));
  assert.equal(present.autoIngestDefined, true);
  assert.deepEqual(present.config, { autoIngest: { ignoreGlobs: [], requireTag: null } });
});

test('loadWikiLocalConfig accepts canonical policy and retained integer A5 settings', () => {
  const wikiRoot = temporaryRoot();
  writeLocal(wikiRoot, JSON.stringify({
    a5_worker_timeout_sec: 90,
    auto_ingest: { require_tag: ' project ', ignore_globs: ['drafts\\**', 'archive/**', 'archive/**'] },
    a5_fanout_threshold: 3,
  }));
  assert.deepEqual(config.loadWikiLocalConfig(wikiRoot).config, {
    autoIngest: { ignoreGlobs: ['archive/**', 'drafts/**'], requireTag: 'project' },
    a5FanoutThreshold: 3,
    a5WorkerTimeoutSec: 90,
  });
});

test('loadWikiLocalConfig fails closed for unsafe or invalid local state', () => {
  const cases = [
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['malformed JSON', '{'],
    ['root array', '[]'],
    ['unknown key', '{"unknown":true}'],
    ['duplicate root key', '{"auto_ingest":{},"auto_ingest":{}}'],
    ['duplicate policy key', '{"auto_ingest":{"require_tag":"one","require_tag":"two"}}'],
    ['invalid glob', '{"auto_ingest":{"ignore_globs":[""]}}'],
    ['invalid tag', '{"auto_ingest":{"require_tag":false}}'],
    ['invalid A5', '{"a5_fanout_threshold":1.5}'],
    ['zero A5 fanout', '{"a5_fanout_threshold":0}'],
    ['negative A5 fanout', '{"a5_fanout_threshold":-1}'],
    ['unsafe A5 fanout', '{"a5_fanout_threshold":9007199254740992}'],
    ['zero A5 timeout', '{"a5_worker_timeout_sec":0}'],
    ['negative A5 timeout', '{"a5_worker_timeout_sec":-1}'],
    ['unsafe A5 timeout', '{"a5_worker_timeout_sec":9007199254740992}'],
  ];
  for (const [name, source] of cases) {
    const wikiRoot = temporaryRoot();
    writeLocal(wikiRoot, source);
    assert.throws(() => config.loadWikiLocalConfig(wikiRoot), (error) => error.code === 'CONFIG_INVALID', name);
  }

  const directoryRoot = temporaryRoot();
  fs.mkdirSync(localPath(directoryRoot), { recursive: true });
  assert.throws(() => config.loadWikiLocalConfig(directoryRoot), (error) => error.code === 'CONFIG_INVALID');

  const linkedRoot = temporaryRoot();
  const target = writeLocal(temporaryRoot(), '{"auto_ingest":{}}');
  fs.mkdirSync(path.dirname(localPath(linkedRoot)), { recursive: true });
  fs.symlinkSync(target, localPath(linkedRoot));
  assert.throws(() => config.loadWikiLocalConfig(linkedRoot), (error) => error.code === 'CONFIG_INVALID');
});

test('loadWikiLocalConfig normalizes malformed string tokens, deeply nested input, and unsafe physical identities', () => {
  const invalidStrings = [
    '{"a\\qb":1}',
    '{"auto_ingest":{"require_tag":"a\nb"}}',
  ];
  for (const source of invalidStrings) {
    const wikiRoot = temporaryRoot();
    writeLocal(wikiRoot, source);
    assert.throws(() => config.loadWikiLocalConfig(wikiRoot), (error) => error.code === 'CONFIG_INVALID');
  }
  const deepRoot = temporaryRoot();
  writeLocal(deepRoot, `{"auto_ingest":${'['.repeat(1_000)}${']'.repeat(1_000)}}`);
  assert.throws(() => config.loadWikiLocalConfig(deepRoot), (error) => error.code === 'CONFIG_INVALID');

  const depthCases = [
    ['array boundary is accepted before schema validation', `{"auto_ingest":{"ignore_globs":${nestedArrayJson(255)}}}`, /ignore_globs/i],
    ['array boundary plus one is rejected by the depth guard', `{"auto_ingest":{"ignore_globs":${nestedArrayJson(256)}}}`, /nesting/i],
    ['object boundary is accepted before schema validation', `{"x":${nestedObjectJson(256)}}`, /unsupported key/i],
    ['object boundary plus one is rejected by the depth guard', `{"x":${nestedObjectJson(257)}}`, /nesting/i],
  ];
  for (const [name, source, messagePattern] of depthCases) {
    const depthBoundaryRoot = temporaryRoot();
    writeLocal(depthBoundaryRoot, source);
    assert.throws(
      () => config.loadWikiLocalConfig(depthBoundaryRoot),
      (error) => error.code === 'CONFIG_INVALID' && messagePattern.test(error.message),
      name,
    );
  }

  const linkedRoot = temporaryRoot();
  const linked = writeLocal(linkedRoot, '{"auto_ingest":{}}');
  fs.linkSync(linked, path.join(linkedRoot, '.wiki-meta', '.config-copy.json'));
  assert.throws(() => config.loadWikiLocalConfig(linkedRoot), (error) => error.code === 'CONFIG_INVALID');
});

test('loadWikiLocalConfig exercises injected filesystem error, identity, bounds, root-shape, and Windows path branches', () => {
  const inaccessible = {
    lstatSync() { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; },
  };
  assert.throws(() => config.loadWikiLocalConfig('/virtual/wiki', { fs: inaccessible }),
    (error) => error.code === 'CONFIG_INVALID');

  const replacementRoot = temporaryRoot();
  const replacement = writeLocal(replacementRoot, '{"auto_ingest":{}}');
  const replacementFs = {
    lstatSync: (...args) => fs.lstatSync(...args),
    readFileSync(pathname) {
      const bytes = fs.readFileSync(pathname);
      fs.writeFileSync(pathname, '{"auto_ingest":{"require_tag":"replacement"}}');
      return bytes;
    },
  };
  assert.throws(() => config.loadWikiLocalConfig(replacementRoot, { fs: replacementFs }),
    (error) => error.code === 'CONFIG_INVALID' && /identity/i.test(error.message));
  assert.equal(replacement, localPath(replacementRoot));

  const boundaryRoot = temporaryRoot();
  const base = '{"auto_ingest":{}}';
  writeLocal(boundaryRoot, base + ' '.repeat(64 * 1024 - Buffer.byteLength(base)));
  assert.equal(config.loadWikiLocalConfig(boundaryRoot).status, 'present');
  fs.appendFileSync(localPath(boundaryRoot), ' ');
  assert.throws(() => config.loadWikiLocalConfig(boundaryRoot), (error) => error.code === 'CONFIG_INVALID');

  for (const source of ['123', 'null', '"value"', '']) {
    const root = temporaryRoot();
    writeLocal(root, source);
    assert.throws(() => config.loadWikiLocalConfig(root), (error) => error.code === 'CONFIG_INVALID');
  }

  const stat = {
    dev: 1n, ino: 2n, mode: 0o100600n, birthtimeNs: 3n, mtimeNs: 4n, nlink: 1n, size: 19n,
    isFile: () => true, isSymbolicLink: () => false,
  };
  const windowsFs = { lstatSync: () => stat, readFileSync: () => Buffer.from('{"auto_ingest":{}}') };
  const windows = config.loadWikiLocalConfig('C:\\Wiki', { platform: 'win32', fs: windowsFs });
  assert.equal(windows.path, 'C:\\Wiki\\.wiki-meta\\.config.json');
});

test('resolveConfig never falls back to valid legacy policy when local state is invalid', () => {
  const root = temporaryRoot();
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const global = path.join(root, 'global.yaml');
  fs.writeFileSync(global, `wiki_root: "${wikiRoot}"\nauto_ingest:\n  require_tag: project\n`);
  writeLocal(wikiRoot, '{"auto_ingest":{"require_tag":1}}');
  assert.throws(() => config.resolveConfig({ DEEP_WIKI_CONFIG: global, HOME: root }),
    (error) => error.code === 'CONFIG_INVALID');
});

test('resolveEffectivePolicy normalizes each ownership state and rejects semantic divergence', () => {
  const wikiRoot = temporaryRoot();
  const local = {
    status: 'present', path: localPath(wikiRoot), autoIngestDefined: true,
    config: { autoIngest: { ignoreGlobs: ['b\\*', 'a/**', 'a/**'], requireTag: ' project ' } },
  };
  assert.deepEqual(config.resolveEffectivePolicy({ globalConfig: globalConfig(wikiRoot, false), localConfig: { status: 'absent', path: localPath(wikiRoot), autoIngestDefined: false, config: null } }), {
    policy: { ignoreGlobs: [], requireTag: null }, policySource: 'default', migrationRequired: false,
  });
  assert.deepEqual(config.resolveEffectivePolicy({ globalConfig: globalConfig(wikiRoot, true, { ignoreGlobs: ['b\\*', 'a/**'], requireTag: ' project ' }), localConfig: { status: 'absent', path: localPath(wikiRoot), autoIngestDefined: false, config: null } }), {
    policy: { ignoreGlobs: ['a/**', 'b/*'], requireTag: 'project' }, policySource: 'global_legacy', migrationRequired: true,
  });
  assert.deepEqual(config.resolveEffectivePolicy({ globalConfig: globalConfig(wikiRoot, false), localConfig: local }), {
    policy: { ignoreGlobs: ['a/**', 'b/*'], requireTag: 'project' }, policySource: 'wiki_local', migrationRequired: false,
  });
  assert.deepEqual(config.resolveEffectivePolicy({ globalConfig: globalConfig(wikiRoot, true, { ignoreGlobs: ['a/**', 'b/*'], requireTag: 'project' }), localConfig: local }), {
    policy: { ignoreGlobs: ['a/**', 'b/*'], requireTag: 'project' }, policySource: 'wiki_local_migrated', migrationRequired: false,
  });
  assert.throws(() => config.resolveEffectivePolicy({
    globalConfig: globalConfig(wikiRoot, true, { requireTag: 'different' }), localConfig: local,
  }), (error) => error.code === 'CONFIG_CONFLICT');
});

test('canonicalPolicyDigest is stable for normalized policy and is SHA-256', () => {
  const policy = { ignoreGlobs: ['z/**', 'a/*'], requireTag: 'project' };
  assert.equal(config.canonicalPolicyDigest(policy), crypto.createHash('sha256').update('{"ignore_globs":["a/*","z/**"],"require_tag":"project"}\n').digest('hex'));
});

test('config resolve JSON reports effective-policy metadata without writing a local file', () => {
  const root = temporaryRoot();
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const global = path.join(root, 'deep-wiki-config.yaml');
  fs.writeFileSync(global, `wiki_root: "${wikiRoot}"\nauto_ingest:\n  require_tag: project\n`);
  const result = spawnSync(process.execPath, [cli, 'config', 'resolve', '--json'], {
    env: { ...process.env, DEEP_WIKI_CONFIG: global, HOME: root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.policy_source, 'global_legacy');
  assert.equal(output.migration_required, true);
  assert.equal(output.local_config_path, localPath(wikiRoot));
  assert.equal(output.a5_fanout_threshold, 3);
  assert.equal(output.a5_worker_timeout_sec, 90);
  assert.equal(fs.existsSync(localPath(wikiRoot)), false);

  writeLocal(wikiRoot, '{"a5_fanout_threshold":7}\n');
  const fanoutConfigured = spawnSync(process.execPath, [cli, 'config', 'resolve', '--json'], {
    env: { ...process.env, DEEP_WIKI_CONFIG: global, HOME: root }, encoding: 'utf8',
  });
  assert.equal(fanoutConfigured.status, 0, fanoutConfigured.stderr);
  const fanoutOutput = JSON.parse(fanoutConfigured.stdout);
  assert.equal(fanoutOutput.a5_fanout_threshold, 7);
  assert.equal(fanoutOutput.a5_worker_timeout_sec, 90);

  writeLocal(wikiRoot, '{"a5_worker_timeout_sec":45}\n');
  const timeoutConfigured = spawnSync(process.execPath, [cli, 'config', 'resolve', '--json'], {
    env: { ...process.env, DEEP_WIKI_CONFIG: global, HOME: root }, encoding: 'utf8',
  });
  assert.equal(timeoutConfigured.status, 0, timeoutConfigured.stderr);
  const timeoutOutput = JSON.parse(timeoutConfigured.stdout);
  assert.equal(timeoutOutput.a5_fanout_threshold, 3);
  assert.equal(timeoutOutput.a5_worker_timeout_sec, 45);
});
