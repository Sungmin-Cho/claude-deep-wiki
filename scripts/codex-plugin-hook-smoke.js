#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_CODEX_VERSION = 'codex-cli 0.144.1';
const MARKETPLACE_NAME = 'deep-wiki-smoke';
const PLUGIN_ID = `deep-wiki@${MARKETPLACE_NAME}`;
const MAX_OUTPUT = 4 * 1024 * 1024;

class SmokeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SmokeError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isSecretKey(key) {
  return /(?:^|_)(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(?:_|$)/i.test(key);
}

function scrubEnvironment(input) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (typeof value !== 'string' || isSecretKey(key)) continue;
    output[key] = value;
  }
  return output;
}

function defaultRunProcess(file, args, options) {
  const result = spawnSync(file, args, {
    ...options,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function assertExistingAbsoluteFile(file, code) {
  if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new SmokeError(code);
  }
}

function assertExistingAbsoluteDirectory(directory, code) {
  if (!path.isAbsolute(directory) || !fs.existsSync(directory)
      || !fs.statSync(directory).isDirectory()) {
    throw new SmokeError(code);
  }
}

function markerSource(secretHashes) {
  return `'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const secretHashes = ${JSON.stringify(secretHashes)};
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalize = (value) => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const pluginRoot = process.env.PLUGIN_ROOT || '';
const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
const expectedRoot = process.env.DEEP_WIKI_EXPECTED_PLUGIN_ROOT || '';
const secretLeaks = [];
for (const [key, value] of Object.entries(process.env)) {
  if (/(?:^|_)(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(?:_|$)/i.test(key)
      || secretHashes.includes(hash(value))) secretLeaks.push(key);
}
const result = {
  process_platform: process.platform,
  selected_command_variant: process.argv[2] || '',
  PLUGIN_ROOT: pluginRoot,
  CLAUDE_PLUGIN_ROOT: claudePluginRoot,
  root_equal: Boolean(pluginRoot && claudePluginRoot && normalize(pluginRoot) === normalize(claudePluginRoot)),
  expected_root_equal: Boolean(expectedRoot && normalize(pluginRoot) === normalize(expectedRoot)),
  secret_leaks: secretLeaks.sort(),
};
const marker = process.env.DEEP_WIKI_SMOKE_MARKER;
if (marker) fs.writeFileSync(marker, JSON.stringify(result));
if (!result.root_equal || !result.expected_root_equal || result.secret_leaks.length > 0) process.exitCode = 42;
`;
}

function createSmokeLayout(options) {
  const workRoot = options.workRoot || os.tmpdir();
  assertExistingAbsoluteDirectory(path.resolve(workRoot), 'CODEX_SMOKE_WORK_ROOT_INVALID');
  const artifactRoot = fs.mkdtempSync(path.join(path.resolve(workRoot), 'deep-wiki-codex-smoke-'));
  try {
  const marketplaceRoot = path.join(artifactRoot, 'marketplace');
  const copiedPluginRoot = path.join(marketplaceRoot, 'plugins', 'deep-wiki');
  const hooksDir = path.join(copiedPluginRoot, 'hooks', 'scripts');
  const skillDir = path.join(copiedPluginRoot, 'skills', 'smoke');
  const marketplaceMetadataDir = path.join(marketplaceRoot, '.agents', 'plugins');
  const trustedProject = path.join(artifactRoot, 'trusted project');
  const untrustedProject = path.join(artifactRoot, 'untrusted project');
  const trustedMarker = path.join(artifactRoot, 'trusted-marker.json');
  const untrustedMarker = path.join(artifactRoot, 'untrusted-marker.json');

  fs.mkdirSync(path.join(copiedPluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(marketplaceMetadataDir, { recursive: true });
  fs.mkdirSync(trustedProject, { recursive: true });
  fs.mkdirSync(untrustedProject, { recursive: true });

  const sourceManifest = path.join(options.pluginRoot, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(sourceManifest)) throw new SmokeError('CODEX_PLUGIN_MANIFEST_MISSING');
  const manifestBytes = fs.readFileSync(sourceManifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (Object.hasOwn(manifest, 'hooks') || Object.hasOwn(manifest, 'mcpServers')) {
    throw new SmokeError('CODEX_PLUGIN_MANIFEST_INVALID');
  }
  fs.writeFileSync(path.join(copiedPluginRoot, '.codex-plugin', 'plugin.json'), manifestBytes);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: smoke',
    'description: Disposable installed-plugin hook smoke skill.',
    'user-invocable: true',
    '---',
    '',
    '# Smoke',
    '',
    'Return the requested marker text.',
    '',
  ].join('\n'));

  const secretHashes = Object.entries(options.env || {})
    .filter(([key, value]) => isSecretKey(key) && typeof value === 'string' && value !== '')
    .map(([, value]) => sha256(value))
    .sort();
  fs.writeFileSync(path.join(hooksDir, 'smoke-marker.js'), markerSource(secretHashes));

  const posixCommand = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/smoke-marker.js" command';
  const windowsCommand = 'node "%CLAUDE_PLUGIN_ROOT%\\hooks\\scripts\\smoke-marker.js" commandWindows';
  const hook = {
    type: 'command',
    command: posixCommand,
    timeout: 15,
  };
  if (options.hookVariant === 'both') hook.commandWindows = windowsCommand;
  fs.writeFileSync(path.join(copiedPluginRoot, 'hooks', 'hooks.json'), `${JSON.stringify({
    description: 'deep-wiki disposable Codex hook smoke',
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [hook] }],
    },
  }, null, 2)}\n`);

  const marketplace = {
    name: MARKETPLACE_NAME,
    interface: {
      displayName: 'Deep Wiki Smoke',
      shortDescription: 'Disposable local hook smoke marketplace',
    },
    plugins: [{
      name: 'deep-wiki',
      description: 'Disposable installed-copy hook fixture',
      source: { source: 'local', path: './plugins/deep-wiki' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Productivity',
    }],
  };
  fs.writeFileSync(
    path.join(marketplaceMetadataDir, 'marketplace.json'),
    `${JSON.stringify(marketplace, null, 2)}\n`,
  );

  return {
    artifactRoot,
    marketplaceRoot,
    marketplacePluginRoot: copiedPluginRoot,
    trustedProject,
    untrustedProject,
    trustedMarker,
    untrustedMarker,
    sourceManifestSha256: sha256(manifestBytes),
    copiedManifestSha256: sha256(fs.readFileSync(
      path.join(copiedPluginRoot, '.codex-plugin', 'plugin.json'),
    )),
  };
  } catch (error) {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    throw error;
  }
}

function runChecked(runProcess, codexBin, args, options, context, errorCode) {
  const result = runProcess(codexBin, args, options, context) || {};
  if (result.error || result.status !== 0) throw new SmokeError(errorCode);
  return result;
}

function parseInstalledPlugin(result, codexHome, layout) {
  let payload;
  try {
    payload = JSON.parse(String(result.stdout || ''));
  } catch {
    throw new SmokeError('CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  }
  if (!payload
      || payload.pluginId !== PLUGIN_ID
      || payload.name !== 'deep-wiki'
      || payload.marketplaceName !== MARKETPLACE_NAME
      || typeof payload.installedPath !== 'string'
      || !path.isAbsolute(payload.installedPath)
      || !fs.existsSync(payload.installedPath)
      || !fs.statSync(payload.installedPath).isDirectory()) {
    throw new SmokeError('CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  }

  const physicalHome = fs.realpathSync.native(codexHome);
  const physicalInstalled = fs.realpathSync.native(payload.installedPath);
  const relative = path.relative(physicalHome, physicalInstalled);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new SmokeError('CODEX_PLUGIN_ROOT_MISMATCH');
  }
  const installedManifest = path.join(physicalInstalled, '.codex-plugin', 'plugin.json');
  const installedHook = path.join(physicalInstalled, 'hooks', 'hooks.json');
  if (!fs.existsSync(installedManifest) || !fs.existsSync(installedHook)
      || sha256(fs.readFileSync(installedManifest)) !== layout.copiedManifestSha256) {
    throw new SmokeError('CODEX_PLUGIN_ROOT_MISMATCH');
  }
  return physicalInstalled;
}

function parseMarker(file, expectedPluginRoot, expectedPlatform, hookVariant) {
  if (!fs.existsSync(file)) throw new SmokeError('CODEX_TRUSTED_HOOK_NOT_OBSERVED');
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0 || bytes.length > 64 * 1024) {
    throw new SmokeError('CODEX_TRUSTED_HOOK_NOT_OBSERVED');
  }
  let marker;
  try {
    marker = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new SmokeError('CODEX_TRUSTED_HOOK_NOT_OBSERVED');
  }
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ''));
    return expectedPlatform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const expectedVariant = expectedPlatform === 'win32' && hookVariant === 'both'
    ? 'commandWindows'
    : 'command';
  if (marker.process_platform !== expectedPlatform
      || marker.selected_command_variant !== expectedVariant
      || !marker.PLUGIN_ROOT
      || !marker.CLAUDE_PLUGIN_ROOT
      || normalize(marker.PLUGIN_ROOT) !== normalize(expectedPluginRoot)
      || normalize(marker.CLAUDE_PLUGIN_ROOT) !== normalize(expectedPluginRoot)) {
    throw new SmokeError('CODEX_PLUGIN_ROOT_MISMATCH');
  }
  if (!Array.isArray(marker.secret_leaks) || marker.secret_leaks.length !== 0) {
    throw new SmokeError('CODEX_HOOK_SECRET_LEAK');
  }
  return marker;
}

function trustedFailureCode(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  if (/model/.test(output) && /(unavailable|not found|unsupported|invalid)/.test(output)) {
    return 'CODEX_MODEL_UNAVAILABLE';
  }
  if (/(auth|login|credential|unauthorized|401)/.test(output)) return 'CODEX_AUTH_FAILED';
  return 'CODEX_TRUSTED_HOOK_NOT_OBSERVED';
}

function runCodexPluginHookSmoke(options) {
  const codexBin = options.codexBin || '';
  const codexHome = options.codexHome || '';
  const model = String(options.model || '').trim();
  const pluginRoot = path.resolve(options.pluginRoot || '');
  const hookVariant = options.hookVariant || 'both';
  const platform = options.platform || process.platform;
  const runProcess = options.runProcess || defaultRunProcess;

  assertExistingAbsoluteFile(codexBin, 'CODEX_BIN_INVALID');
  assertExistingAbsoluteDirectory(codexHome, 'CODEX_HOME_INVALID');
  assertExistingAbsoluteDirectory(pluginRoot, 'CODEX_PLUGIN_ROOT_INVALID');
  if (!model) throw new SmokeError('CODEX_MODEL_UNAVAILABLE');
  if (!['both', 'single'].includes(hookVariant)) throw new SmokeError('CODEX_HOOK_VARIANT_INVALID');

  let layout;
  try {
    layout = createSmokeLayout({ ...options, pluginRoot, hookVariant });
    const baseEnv = {
      ...scrubEnvironment(options.env || process.env),
      CODEX_HOME: codexHome,
    };
    const baseProcessOptions = {
      cwd: layout.artifactRoot,
      env: baseEnv,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    };

    const versionResult = runProcess(
      codexBin,
      ['--version'],
      baseProcessOptions,
      { phase: 'version', layout },
    ) || {};
    if (versionResult.error || versionResult.status !== 0
        || String(versionResult.stdout || '').trim() !== EXPECTED_CODEX_VERSION) {
      throw new SmokeError('CODEX_VERSION_MISMATCH');
    }

    runChecked(
      runProcess,
      codexBin,
      ['plugin', 'marketplace', 'add', layout.marketplaceRoot, '--json'],
      baseProcessOptions,
      { phase: 'marketplace-add', layout },
      'CODEX_PLUGIN_SURFACE_UNAVAILABLE',
    );
    const pluginAddResult = runChecked(
      runProcess,
      codexBin,
      ['plugin', 'add', PLUGIN_ID, '--json'],
      baseProcessOptions,
      { phase: 'plugin-add', layout },
      'CODEX_PLUGIN_SURFACE_UNAVAILABLE',
    );
    const installedPluginRoot = parseInstalledPlugin(pluginAddResult, codexHome, layout);
    const runtimeEnv = {
      ...baseEnv,
      DEEP_WIKI_EXPECTED_PLUGIN_ROOT: installedPluginRoot,
    };

    const trustedArgs = [
      'exec', '--model', model, '--ephemeral', '--skip-git-repo-check',
      '--dangerously-bypass-hook-trust', '--cd', layout.trustedProject,
      'Return exactly DEEP_WIKI_SMOKE_OK',
    ];
    const trustedResult = runProcess(
      codexBin,
      trustedArgs,
      {
        ...baseProcessOptions,
        cwd: layout.trustedProject,
        env: { ...runtimeEnv, DEEP_WIKI_SMOKE_MARKER: layout.trustedMarker },
      },
      { phase: 'trusted-exec', layout, installedPluginRoot },
    ) || {};
    if (trustedResult.error || trustedResult.status !== 0) {
      throw new SmokeError(trustedFailureCode(trustedResult));
    }
    const marker = parseMarker(
      layout.trustedMarker,
      installedPluginRoot,
      platform,
      hookVariant,
    );

    const untrustedArgs = [
      'exec', '--model', model, '--ephemeral', '--skip-git-repo-check',
      '--cd', layout.untrustedProject, 'Return exactly DEEP_WIKI_SMOKE_UNTRUSTED',
    ];
    const untrustedResult = runProcess(
      codexBin,
      untrustedArgs,
      {
        ...baseProcessOptions,
        cwd: layout.untrustedProject,
        env: { ...runtimeEnv, DEEP_WIKI_SMOKE_MARKER: layout.untrustedMarker },
      },
      { phase: 'untrusted-exec', layout, installedPluginRoot },
    ) || {};
    const untrustedOutput = `${untrustedResult.stdout || ''}\n${untrustedResult.stderr || ''}`;
    const untrustedHookDenied = !fs.existsSync(layout.untrustedMarker)
      && /(?:hook.*(?:trust|denied|approval)|(?:trust|denied).*hook)/i.test(untrustedOutput);
    if (!untrustedHookDenied) {
      throw new SmokeError('CODEX_UNTRUSTED_HOOK_DENIAL_NOT_OBSERVED');
    }

    const result = {
      codexVersion: EXPECTED_CODEX_VERSION,
      selectedHookVariant: marker.selected_command_variant,
      marketplaceArgv: ['plugin', 'marketplace', 'add', layout.marketplaceRoot, '--json'],
      pluginArgv: ['plugin', 'add', PLUGIN_ID, '--json'],
      trustedArgv: trustedArgs,
      untrustedArgv: untrustedArgs,
      trustedHookObserved: true,
      untrustedHookDenied,
      marker,
      ...layout,
      pluginRoot: installedPluginRoot,
    };
    if (!options.keepArtifacts) fs.rmSync(layout.artifactRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (layout && !options.keepArtifacts) {
      fs.rmSync(layout.artifactRoot, { recursive: true, force: true });
    }
    if (error instanceof SmokeError) throw error;
    throw new SmokeError('CODEX_SMOKE_INTERNAL_ERROR');
  }
}

module.exports = {
  EXPECTED_CODEX_VERSION,
  SmokeError,
  scrubEnvironment,
  createSmokeLayout,
  runCodexPluginHookSmoke,
};

if (require.main === module) {
  try {
    const result = runCodexPluginHookSmoke({
      codexBin: process.env.CODEX_BIN,
      codexHome: process.env.CODEX_HOME,
      model: process.env.CODEX_SMOKE_MODEL,
      pluginRoot: path.resolve(__dirname, '..'),
      hookVariant: process.env.CODEX_SMOKE_HOOK_VARIANT || 'both',
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'CODEX_SMOKE_INTERNAL_ERROR'}\n`);
    process.exitCode = 1;
  }
}
