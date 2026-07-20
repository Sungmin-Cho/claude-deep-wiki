'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  discoverCandidates,
  parseVaultOutput,
  probeObsidian,
  runObsidian,
} = require('../hooks/scripts/runtime/obsidian-probe.js');

function existsIn(paths) {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
}

test('discovery finds a PATH entry under both binary casings on POSIX', () => {
  const env = { PATH: '/usr/bin:/Applications/Obsidian.app/Contents/MacOS', HOME: '/Users/tester' };
  const candidates = discoverCandidates({
    env,
    platform: 'darwin',
    exists: existsIn(['/Applications/Obsidian.app/Contents/MacOS/Obsidian']),
  });
  assert.deepEqual(candidates, [{
    executable: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
    source: 'path',
  }]);
});

test('discovery falls back to the macOS application bundle when PATH has no entry', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/Users/tester' };
  const candidates = discoverCandidates({
    env,
    platform: 'darwin',
    exists: existsIn(['/Applications/Obsidian.app/Contents/MacOS/Obsidian']),
  });
  assert.deepEqual(candidates, [{
    executable: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
    source: 'well-known',
  }]);
});

test('discovery honors an absolute DEEP_WIKI_OBSIDIAN_BIN override first and ignores a relative one', () => {
  const override = '/opt/custom/obsidian';
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const exists = existsIn([override, bundled]);
  const absolute = discoverCandidates({
    env: { DEEP_WIKI_OBSIDIAN_BIN: override, PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists,
  });
  assert.deepEqual(absolute[0], { executable: override, source: 'env' });
  const relative = discoverCandidates({
    env: { DEEP_WIKI_OBSIDIAN_BIN: 'obsidian', PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists,
  });
  assert.ok(relative.every((candidate) => candidate.source !== 'env'));
});

test('discovery searches Windows PATH with executable extensions and LOCALAPPDATA fallback', () => {
  const appBin = 'C:\\Users\\tester\\AppData\\Local\\Programs\\obsidian\\Obsidian.exe';
  const fromPath = discoverCandidates({
    env: { Path: 'C:\\Tools;C:\\Windows', USERPROFILE: 'C:\\Users\\tester' },
    platform: 'win32',
    exists: existsIn(['C:\\Tools\\obsidian.cmd']),
  });
  assert.deepEqual(fromPath, [{ executable: 'C:\\Tools\\obsidian.cmd', source: 'path' }]);
  const fromInstall = discoverCandidates({
    env: {
      Path: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\tester',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    },
    platform: 'win32',
    exists: existsIn([appBin]),
  });
  assert.deepEqual(fromInstall, [{ executable: appBin, source: 'well-known' }]);
});

test('discovery deduplicates candidates that repeat across PATH and well-known roots', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const candidates = discoverCandidates({
    env: { PATH: '/Applications/Obsidian.app/Contents/MacOS', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
  });
  assert.equal(candidates.filter((entry) => entry.executable === bundled).length, 1);
});

test('vault output parses tab-separated name and path lines', () => {
  const parsed = parseVaultOutput([
    'name\tPersonal Vault',
    'path\t/Users/tester/Vaults/Personal Vault',
    'files\t1658',
  ].join('\n'));
  assert.deepEqual(parsed, {
    name: 'Personal Vault',
    path: '/Users/tester/Vaults/Personal Vault',
  });
  assert.equal(parseVaultOutput('no tabs here'), null);
});

test('probe reports found and reachable with vault details on a clean run', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const calls = [];
  const result = probeObsidian({
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: (executable, argv, options) => {
      calls.push({ executable, argv, options });
      return { status: 0, stdout: 'name\tPersonal Vault\npath\t/Users/tester/Vaults/Personal Vault\n', stderr: '' };
    },
  });
  assert.deepEqual(calls[0].argv, ['vault']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 3000);
  assert.deepEqual(result, {
    found: true,
    reachable: true,
    executable: bundled,
    source: 'well-known',
    vault: { name: 'Personal Vault', path: '/Users/tester/Vaults/Personal Vault' },
    error: null,
    candidatesChecked: 1,
  });
});

test('probe reports found but unreachable when the CLI exists and the app is not running', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const result = probeObsidian({
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'Error: could not connect to a running Obsidian app\nmore detail' }),
  });
  assert.equal(result.found, true);
  assert.equal(result.reachable, false);
  assert.equal(result.executable, bundled);
  assert.equal(result.vault, null);
  assert.match(result.error, /could not connect/);
  assert.ok(!result.error.includes('more detail'));
});

test('probe skips a broken PATH shim and succeeds through the next candidate', () => {
  const shim = '/usr/local/bin/obsidian';
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const result = probeObsidian({
    env: { PATH: '/usr/local/bin', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([shim, bundled]),
    spawnSync: (executable) => (executable === shim
      ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
      : { status: 0, stdout: 'name\tVault\npath\t/v\n', stderr: '' }),
  });
  assert.equal(result.reachable, true);
  assert.equal(result.executable, bundled);
  assert.equal(result.candidatesChecked, 2);
});

test('probe reports not found when no candidate exists anywhere', () => {
  const result = probeObsidian({
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/tester' },
    platform: 'linux',
    exists: () => false,
    spawnSync: () => { throw new Error('must not spawn'); },
  });
  assert.deepEqual(result, {
    found: false,
    reachable: false,
    executable: null,
    source: null,
    vault: null,
    error: null,
    candidatesChecked: 0,
  });
});

test('bridge search targets the configured vault and parses JSON output', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const calls = [];
  const result = runObsidian({
    subcommand: 'search',
    query: 'deep wiki philosophy',
    limit: 20,
    vaultName: 'Personal Vault',
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: (executable, argv, options) => {
      calls.push({ executable, argv, options });
      return { status: 0, stdout: '[{"path":"pages/llm-wiki.md","score":1}]', stderr: '' };
    },
  });
  assert.deepEqual(calls[0].argv, [
    'search', 'query=deep wiki philosophy', 'limit=20', 'format=json', 'vault=Personal Vault',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10000);
  assert.deepEqual(result, {
    ok: true,
    found: true,
    executable: bundled,
    source: 'well-known',
    format: 'json',
    data: [{ path: 'pages/llm-wiki.md', score: 1 }],
    error: null,
  });
});

test('bridge backlinks and tags build read-only argv without vault when unconfigured', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const argvSeen = [];
  const options = {
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: (executable, argv) => {
      argvSeen.push(argv);
      return { status: 0, stdout: '[]', stderr: '' };
    },
  };
  runObsidian({ ...options, subcommand: 'backlinks', targetPath: 'NOTES/2026-07-13 Daily.md' });
  runObsidian({ ...options, subcommand: 'tags' });
  assert.deepEqual(argvSeen[0], ['backlinks', 'path=NOTES/2026-07-13 Daily.md', 'format=json']);
  assert.deepEqual(argvSeen[1], ['tags', 'counts', 'format=json']);
});

test('bridge falls back to raw text when JSON output does not parse', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const result = runObsidian({
    subcommand: 'tags',
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: () => ({ status: 0, stdout: '#news\t12\n#daily\t9\n', stderr: '' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'text');
  assert.equal(result.data, '#news\t12\n#daily\t9');
});

test('bridge reports found-but-unreachable and not-found failures distinctly', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  const unreachable = runObsidian({
    subcommand: 'tags',
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'Error: no running Obsidian app\n' }),
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.found, true);
  assert.match(unreachable.error, /no running Obsidian app/);
  const missing = runObsidian({
    subcommand: 'tags',
    env: { PATH: '/usr/bin', HOME: '/Users/tester' },
    platform: 'linux',
    exists: () => false,
    spawnSync: () => { throw new Error('must not spawn'); },
  });
  assert.deepEqual(missing, {
    ok: false,
    found: false,
    executable: null,
    source: null,
    format: null,
    data: null,
    error: 'obsidian CLI not found',
  });
});

test('bridge retries a successful-but-empty reply and returns the late data', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  let spawns = 0;
  const result = runObsidian({
    subcommand: 'search',
    query: '경제 뉴스',
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: () => {
      spawns += 1;
      return spawns < 3
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 0, stdout: '["a.md"]', stderr: '' };
    },
  });
  assert.equal(spawns, 3);
  assert.equal(result.ok, true);
  assert.equal(result.format, 'json');
  assert.deepEqual(result.data, ['a.md']);
});

test('bridge stops after bounded retries when the reply stays empty', () => {
  const bundled = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  let spawns = 0;
  const result = runObsidian({
    subcommand: 'search',
    query: 'anything',
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: existsIn([bundled]),
    spawnSync: () => {
      spawns += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(spawns, 3);
  assert.equal(result.ok, true);
  assert.equal(result.format, 'text');
  assert.equal(result.data, '');
});

test('bridge rejects unsafe values, bad limits, and unknown subcommands as usage errors', () => {
  const base = {
    env: { PATH: '', HOME: '/Users/tester' },
    platform: 'darwin',
    exists: () => true,
    spawnSync: () => { throw new Error('must not spawn'); },
  };
  const usage = (callback) => assert.throws(callback, (error) => error.code === 'USAGE');
  usage(() => runObsidian({ ...base, subcommand: 'delete', targetPath: 'a.md' }));
  usage(() => runObsidian({ ...base, subcommand: 'search', query: 'line\nbreak' }));
  usage(() => runObsidian({ ...base, subcommand: 'search', query: 'x'.repeat(600) }));
  usage(() => runObsidian({ ...base, subcommand: 'search', query: 'ok', limit: 0 }));
  usage(() => runObsidian({ ...base, subcommand: 'search', query: 'ok', limit: 101 }));
  usage(() => runObsidian({ ...base, subcommand: 'backlinks' }));
  usage(() => runObsidian({ ...base, subcommand: 'search', query: 'ok', vaultName: 'bad\rname' }));
});

test('probe spawns at most three candidates', () => {
  const dirs = ['/a', '/b', '/c', '/d', '/e'];
  const binaries = dirs.map((dir) => path.posix.join(dir, 'obsidian'));
  let spawns = 0;
  const result = probeObsidian({
    env: { PATH: dirs.join(':'), HOME: '/home/tester' },
    platform: 'linux',
    exists: existsIn(binaries),
    spawnSync: () => {
      spawns += 1;
      return { status: 1, stdout: '', stderr: 'unreachable' };
    },
  });
  assert.equal(spawns, 3);
  assert.equal(result.found, true);
  assert.equal(result.reachable, false);
});
