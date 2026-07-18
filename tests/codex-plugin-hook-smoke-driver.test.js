'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SmokeError,
  runCodexPluginHookSmoke,
} = require('../scripts/codex-plugin-hook-smoke.js');

const repositoryRoot = path.resolve(__dirname, '..');

test('shipped Windows hook models Codex commandWindows expansion through the outer command processor', () => {
  const hookDocument = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'hooks', 'hooks.json'),
    'utf8',
  ));
  const hook = hookDocument.hooks.SessionStart[0].hooks[0];
  const installedRoot = 'C:\\Users\\Example User\\.codex\\plugins\\deep-wiki';
  const expanded = hook.commandWindows.replaceAll('%CLAUDE_PLUGIN_ROOT%', installedRoot);
  const hostLaunch = {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/D', '/S', '/C', expanded],
  };

  assert.equal(hook.commandWindows, 'node "%CLAUDE_PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js"');
  assert.deepEqual(hostLaunch.args.slice(0, 3), ['/D', '/S', '/C']);
  assert.equal(
    hostLaunch.args[3],
    'node "C:\\Users\\Example User\\.codex\\plugins\\deep-wiki\\hooks\\scripts\\scan-vault-changes.js"',
  );
  assert.match(hostLaunch.file, /cmd\.exe$/i);
  assert.doesNotMatch(hostLaunch.args[3], /[|;&<>`\r\n]|\$\(/);
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-smoke-test-'));
  const codexHome = path.join(root, 'Codex Home');
  const pluginRoot = path.join(root, 'Source Plugin');
  const binDir = path.join(root, 'bin');
  const codexBin = path.join(binDir, 'codex.exe');
  const installedPath = path.join(
    codexHome,
    'plugins',
    'cache',
    'deep-wiki-smoke',
    'deep-wiki',
    '1.7.1',
  );
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'skills'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(codexBin, 'fixture');
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'deep-wiki',
    version: '1.7.1',
    description: 'fixture',
    skills: './skills/',
  }));
  return { root, codexHome, pluginRoot, codexBin, installedPath };
}

test('portable seam pins exact 0.144.1 argv, copied root, trust boundary, and secret scrub', () => {
  const fixture = makeFixture();
  const calls = [];
  try {
    const result = runCodexPluginHookSmoke({
      codexBin: fixture.codexBin,
      codexHome: fixture.codexHome,
      model: 'gpt-smoke-model',
      pluginRoot: fixture.pluginRoot,
      workRoot: fixture.root,
      platform: 'win32',
      keepArtifacts: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: 'C:\\Windows',
        OPENAI_API_KEY: 'secret-openai-value',
        CODEX_WINDOWS_SMOKE_API_KEY: 'secret-windows-value',
        CUSTOM_SECRET: 'secret-custom-value',
        SAFE_VALUE: 'retained',
      },
      runProcess(file, args, options, context) {
        calls.push({
          file,
          args: [...args],
          env: { ...options.env },
          cwd: options.cwd,
          shell: options.shell,
          windowsHide: options.windowsHide,
          phase: context.phase,
        });
        if (context.phase === 'version') {
          return { status: 0, stdout: 'codex-cli 0.144.1\n', stderr: '' };
        }
        if (context.phase === 'plugin-add') {
          fs.cpSync(context.layout.marketplacePluginRoot, fixture.installedPath, { recursive: true });
          return {
            status: 0,
            stdout: `${JSON.stringify({
              pluginId: 'deep-wiki@deep-wiki-smoke',
              name: 'deep-wiki',
              marketplaceName: 'deep-wiki-smoke',
              version: '1.7.1',
              installedPath: fixture.installedPath,
            })}\n`,
            stderr: '',
          };
        }
        if (context.phase === 'trusted-exec') {
          fs.writeFileSync(context.layout.trustedMarker, JSON.stringify({
            process_platform: 'win32',
            selected_command_variant: 'commandWindows',
            PLUGIN_ROOT: context.installedPluginRoot,
            CLAUDE_PLUGIN_ROOT: context.installedPluginRoot,
            secret_leaks: [],
          }));
          return { status: 0, stdout: 'DEEP_WIKI_SMOKE_OK\n', stderr: '' };
        }
        if (context.phase === 'untrusted-exec') {
          return { status: 1, stdout: '', stderr: 'hook trust required; execution denied' };
        }
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });

    assert.equal(result.codexVersion, 'codex-cli 0.144.1');
    assert.equal(result.trustedHookObserved, true);
    assert.equal(result.untrustedHookDenied, true);
    assert.equal(result.pluginRoot, fs.realpathSync.native(fixture.installedPath));
    assert.notEqual(result.pluginRoot, result.marketplacePluginRoot);
    assert.equal(result.marker.PLUGIN_ROOT, result.pluginRoot);
    assert.equal(result.marker.CLAUDE_PLUGIN_ROOT, result.pluginRoot);
    assert.equal(result.marker.selected_command_variant, 'commandWindows');
    assert.equal(result.sourceManifestSha256, result.copiedManifestSha256);

    assert.deepEqual(calls.map(({ args }) => args), [
      ['--version'],
      ['plugin', 'marketplace', 'add', result.marketplaceRoot, '--json'],
      ['plugin', 'add', 'deep-wiki@deep-wiki-smoke', '--json'],
      [
        'exec', '--model', 'gpt-smoke-model', '--ephemeral', '--skip-git-repo-check',
        '--dangerously-bypass-hook-trust', '--cd', result.trustedProject,
        'Return exactly DEEP_WIKI_SMOKE_OK',
      ],
      [
        'exec', '--model', 'gpt-smoke-model', '--ephemeral', '--skip-git-repo-check',
        '--cd', result.untrustedProject, 'Return exactly DEEP_WIKI_SMOKE_UNTRUSTED',
      ],
    ]);
    assert.ok(calls.every((call) => call.file === fixture.codexBin));
    assert.ok(calls.every((call) => call.env.CODEX_HOME === fixture.codexHome));
    assert.ok(calls.every((call) => call.shell === false));
    assert.ok(calls.every((call) => call.windowsHide === true));
    assert.ok(calls.every((call) => path.isAbsolute(call.cwd)));
    assert.equal(calls.some((call) => call.args.includes('install')), false);
    assert.equal(calls.some((call) => call.args.includes('enable')), false);
    for (const call of calls) {
      const serialized = JSON.stringify(call.env);
      assert.doesNotMatch(serialized, /OPENAI_API_KEY|CODEX_WINDOWS_SMOKE_API_KEY|CUSTOM_SECRET/);
      assert.doesNotMatch(serialized, /secret-openai-value|secret-windows-value|secret-custom-value/);
    }

    const marketplace = JSON.parse(fs.readFileSync(
      path.join(result.marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ));
    const copiedManifest = JSON.parse(fs.readFileSync(
      path.join(result.pluginRoot, '.codex-plugin', 'plugin.json'),
      'utf8',
    ));
    assert.equal(marketplace.plugins[0].name, copiedManifest.name);
    assert.equal(marketplace.plugins[0].source.source, 'local');
    assert.equal(marketplace.plugins[0].source.path, './plugins/deep-wiki');
    assert.equal(fs.lstatSync(result.marketplacePluginRoot).isSymbolicLink(), false);

    const hookDocument = JSON.parse(fs.readFileSync(
      path.join(result.marketplacePluginRoot, 'hooks', 'hooks.json'),
      'utf8',
    ));
    const hook = hookDocument.hooks.SessionStart[0].hooks[0];
    assert.equal(
      hook.command,
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/smoke-marker.js" command',
    );
    assert.equal(
      hook.commandWindows,
      'node "%CLAUDE_PLUGIN_ROOT%\\hooks\\scripts\\smoke-marker.js" commandWindows',
    );

    const markerScript = fs.readFileSync(
      path.join(result.marketplacePluginRoot, 'hooks', 'scripts', 'smoke-marker.js'),
      'utf8',
    );
    assert.doesNotMatch(markerScript, /secret-openai-value|secret-windows-value|secret-custom-value/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('surface absence is a stable blocking classification', () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => runCodexPluginHookSmoke({
        codexBin: fixture.codexBin,
        codexHome: fixture.codexHome,
        model: 'gpt-smoke-model',
        pluginRoot: fixture.pluginRoot,
        workRoot: fixture.root,
        env: {},
        runProcess(file, args, options, context) {
          if (context.phase === 'version') {
            return { status: 0, stdout: 'codex-cli 0.144.1\n', stderr: '' };
          }
          return { status: 2, stdout: '', stderr: "unrecognized subcommand 'marketplace'" };
        },
      }),
      (error) => error instanceof SmokeError && error.code === 'CODEX_PLUGIN_SURFACE_UNAVAILABLE',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('layout construction failure removes only its disposable artifact directory', () => {
  const fixture = makeFixture();
  try {
    const manifestPath = path.join(fixture.pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.hooks = './hooks/hooks.json';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(
      () => runCodexPluginHookSmoke({
        codexBin: fixture.codexBin,
        codexHome: fixture.codexHome,
        model: 'gpt-smoke-model',
        pluginRoot: fixture.pluginRoot,
        workRoot: fixture.root,
        env: {},
        runProcess() {
          throw new Error('process seam must not run');
        },
      }),
      (error) => error instanceof SmokeError && error.code === 'CODEX_PLUGIN_MANIFEST_INVALID',
    );
    assert.deepEqual(
      fs.readdirSync(fixture.root).filter((name) => name.startsWith('deep-wiki-codex-smoke-')),
      [],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('version and model failures remain distinct release blockers', () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => runCodexPluginHookSmoke({
        codexBin: fixture.codexBin,
        codexHome: fixture.codexHome,
        model: 'gpt-smoke-model',
        pluginRoot: fixture.pluginRoot,
        workRoot: fixture.root,
        env: {},
        runProcess() {
          return { status: 0, stdout: 'codex-cli 0.143.0\n', stderr: '' };
        },
      }),
      (error) => error instanceof SmokeError && error.code === 'CODEX_VERSION_MISMATCH',
    );

    assert.throws(
      () => runCodexPluginHookSmoke({
        codexBin: fixture.codexBin,
        codexHome: fixture.codexHome,
        model: 'gpt-smoke-model',
        pluginRoot: fixture.pluginRoot,
        workRoot: fixture.root,
        env: {},
        runProcess(file, args, options, context) {
          if (context.phase === 'version') {
            return { status: 0, stdout: 'codex-cli 0.144.1\n', stderr: '' };
          }
          if (context.phase === 'plugin-add') {
            fs.cpSync(context.layout.marketplacePluginRoot, fixture.installedPath, { recursive: true });
            return {
              status: 0,
              stdout: `${JSON.stringify({
                pluginId: 'deep-wiki@deep-wiki-smoke',
                name: 'deep-wiki',
                marketplaceName: 'deep-wiki-smoke',
                version: '1.7.1',
                installedPath: fixture.installedPath,
              })}\n`,
              stderr: '',
            };
          }
          if (context.phase === 'trusted-exec') {
            return { status: 1, stdout: '', stderr: 'configured model is unavailable' };
          }
          return { status: 0, stdout: '{}\n', stderr: '' };
        },
      }),
      (error) => error instanceof SmokeError && error.code === 'CODEX_MODEL_UNAVAILABLE',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
