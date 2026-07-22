#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  startLoopbackResponsesServer,
} = require('../tests/helpers/codex-loopback-responses.js');
const {
  formatSessionStartOutput,
} = require('../hooks/scripts/scan-vault-changes.js');

const EXPECTED_CODEX_VERSION = 'codex-cli 0.144.1';
const MARKETPLACE_NAME = 'deep-wiki-smoke';
const PLUGIN_ID = `deep-wiki@${MARKETPLACE_NAME}`;
const MAX_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_PHASE_TIMEOUT_MS = 30_000;
const SHA_RE = /^[0-9a-f]{40}$/;
const PENDING_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/;

class SmokeError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'SmokeError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePhysical(value, platform = process.platform) {
  const resolved = path.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertAbsoluteFile(file, code) {
  if (typeof file !== 'string' || !path.isAbsolute(file)
      || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new SmokeError(code);
}

function assertAbsoluteDirectory(directory, code) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
      || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new SmokeError(code);
  }
}

async function killProcessTree(child, platform, env) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (platform === 'win32') {
    const root = env.SYSTEMROOT || env.SystemRoot || env.WINDIR;
    if (typeof root !== 'string' || !path.win32.isAbsolute(root)) {
      throw new Error('SYSTEMROOT is unavailable for tree termination');
    }
    const taskkill = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), [
      '/PID', String(child.pid), '/T', '/F',
    ], { stdio: 'ignore', shell: false, windowsHide: true });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        taskkill.kill('SIGKILL');
        reject(new Error('taskkill deadline exceeded'));
      }, 5000);
      timer.unref?.();
      taskkill.once('error', (error) => { clearTimeout(timer); reject(error); });
      taskkill.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    if (status !== 0) throw new Error(`taskkill failed with status ${status}`);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('root process exit was not confirmed')), 2000);
        timer.unref?.();
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function defaultRunProcess(file, args, options = {}, context = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs || DEFAULT_PHASE_TIMEOUT_MS;
    const maxOutput = options.maxOutput || MAX_OUTPUT;
    let child;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let terminal = false;
    let aborting = false;
    let timeout;

    const finish = (result) => {
      if (terminal || aborting) return;
      terminal = true;
      clearTimeout(timeout);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        ...result,
        stdoutBuffer,
        stderrBuffer,
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
        phase: context.phase,
      });
    };

    const abort = async (signal, error) => {
      if (terminal || aborting) return;
      aborting = true;
      clearTimeout(timeout);
      let finalError = error;
      try { await killProcessTree(child, process.platform, options.env || process.env); }
      catch (cause) { finalError = new Error(error.message, { cause }); }
      aborting = false;
      finish({ status: null, signal, error: finalError });
    };

    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish({ status: null, signal: null, error });
      return;
    }
    timeout = setTimeout(() => {
      void abort('TIMEOUT', new Error('process deadline exceeded'));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) {
        void abort('OUTPUT_LIMIT', new Error('stdout limit exceeded'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutput) {
        void abort('OUTPUT_LIMIT', new Error('stderr limit exceeded'));
      } else stderr.push(chunk);
    });
    child.once('error', (error) => finish({ status: null, signal: null, error }));
    child.once('close', (status, signal) => finish({ status, signal, error: null }));
  });
}

function envValue(input, key) {
  const match = Object.keys(input || {}).find((candidate) => candidate.toUpperCase() === key);
  return match ? input[match] : undefined;
}

function buildBootstrapEnvironment(input) {
  const output = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = envValue(input, key);
    if (typeof value === 'string' && value) output[key] = value;
  }
  return output;
}

function buildChildEnvironment(input, directories, extra = {}) {
  const output = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = envValue(input, key);
    if (typeof value === 'string' && value) output[key] = value;
  }
  Object.assign(output, {
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    CODEX_HOME: directories.codexHome,
    DEEP_WIKI_LOOPBACK_AUTH: 'deep-wiki-loopback-public-v1',
  }, extra);
  return output;
}

function parseJsonResult(result, code) {
  if (!result || result.error || result.status !== 0) throw new SmokeError(code);
  try { return JSON.parse(result.stdout); } catch { throw new SmokeError(code); }
}

async function checked(runProcess, file, args, options, context, code) {
  const result = await runProcess(file, args, options, context);
  if (!result || result.error || result.status !== 0) throw new SmokeError(code);
  return result;
}

function trackedEntries(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match || match[3].includes('\0') || path.isAbsolute(match[3])
        || match[3].split('/').includes('..')) throw new SmokeError('CODEX_CANDIDATE_TREE_INVALID');
    return { mode: match[1], oid: match[2], relative: match[3] };
  });
}

async function resolveCandidateSha(options, runProcess) {
  const supplied = String(options.candidateSha || options.env?.GITHUB_SHA || '').trim().toLowerCase();
  if (supplied) {
    if (!SHA_RE.test(supplied)) throw new SmokeError('CODEX_CANDIDATE_SHA_INVALID');
    return supplied;
  }
  const result = await checked(
    runProcess,
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: options.pluginRoot, env: options.env, timeoutMs: 10_000 },
    { phase: 'git-rev-parse' },
    'CODEX_CANDIDATE_SHA_INVALID',
  );
  const sha = result.stdout.trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new SmokeError('CODEX_CANDIDATE_SHA_INVALID');
  return sha;
}

async function createCandidateLayout(options, runProcess, candidateSha) {
  const workRoot = path.resolve(options.workRoot || os.tmpdir());
  assertAbsoluteDirectory(workRoot, 'CODEX_SMOKE_WORK_ROOT_INVALID');
  const artifactRoot = fs.mkdtempSync(path.join(workRoot, 'deep-wiki-codex-smoke-'));
  try {
    const marketplaceRoot = path.join(artifactRoot, 'marketplace');
    const candidateRoot = path.join(marketplaceRoot, 'plugins', 'deep-wiki');
    fs.mkdirSync(candidateRoot, { recursive: true });
    const list = await checked(
      runProcess,
      'git',
      ['ls-tree', '-r', '-z', '--full-tree', candidateSha],
      { cwd: options.pluginRoot, env: options.env, timeoutMs: 10_000 },
      { phase: 'git-ls-tree' },
      'CODEX_CANDIDATE_TREE_INVALID',
    );
    const entries = trackedEntries(list.stdoutBuffer || Buffer.from(list.stdout));
    if (entries.length === 0) throw new SmokeError('CODEX_CANDIDATE_TREE_INVALID');
    const manifest = {};
    for (const entry of entries) {
      const blob = await checked(
        runProcess,
        'git',
        ['cat-file', 'blob', entry.oid],
        { cwd: options.pluginRoot, env: options.env, timeoutMs: 10_000, maxOutput: 16 * 1024 * 1024 },
        { phase: 'git-cat-file', entry },
        'CODEX_CANDIDATE_TREE_INVALID',
      );
      const bytes = blob.stdoutBuffer || Buffer.from(blob.stdout, 'utf8');
      const destination = path.join(candidateRoot, ...entry.relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      manifest[entry.relative] = sha256(bytes);
    }
    const marketplaceDir = path.join(marketplaceRoot, '.agents', 'plugins');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(path.join(marketplaceDir, 'marketplace.json'), `${JSON.stringify({
      name: MARKETPLACE_NAME,
      interface: {
        displayName: 'Deep Wiki Smoke',
        shortDescription: 'Exact candidate installed-Codex authority',
      },
      plugins: [{
        name: 'deep-wiki',
        description: 'Exact candidate installed-Codex authority',
        source: { source: 'local', path: './plugins/deep-wiki' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Productivity',
      }],
    }, null, 2)}\n`);
    return { artifactRoot, marketplaceRoot, candidateRoot, candidateSha, trackedManifest: manifest };
  } catch (error) {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    throw error;
  }
}

function prepareHome(root, label) {
  const home = path.join(root, label, 'home');
  const codexHome = path.join(home, '.codex');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  for (const directory of [codexHome, appData, localAppData]) fs.mkdirSync(directory, { recursive: true });
  return { home, codexHome, appData, localAppData };
}

function prepareVault(root, label, fixture, directories) {
  const phaseRoot = path.join(root, label);
  const markdown = path.join(phaseRoot, ...fixture.markdown_path.split('/'));
  const vaultRoot = path.join(phaseRoot, 'Vault With Spaces');
  const wikiRoot = path.join(vaultRoot, '.deep-wiki');
  const metaRoot = path.join(wikiRoot, '.wiki-meta');
  fs.mkdirSync(path.dirname(markdown), { recursive: true });
  fs.mkdirSync(metaRoot, { recursive: true });
  fs.writeFileSync(markdown, Buffer.from(fixture.markdown_crlf_base64, 'base64'));
  const now = new Date();
  fs.utimesSync(markdown, now, now);
  const config = path.join(directories.codexHome, 'deep-wiki-config.yaml');
  fs.writeFileSync(config, `wiki_root: "${wikiRoot.replaceAll('\\', '\\\\')}"\nauto_ingest:\n  ignore_globs: []\n`);
  return {
    phaseRoot,
    vaultRoot,
    physicalVaultRoot: fs.realpathSync.native(vaultRoot),
    wikiRoot,
    metaRoot,
    markdown,
    config,
    pending: path.join(metaRoot, '.pending-scan'),
    transactionRoot: path.join(metaRoot, '.transactions'),
  };
}

function buildExpectedDirectOutput(vault, fixture) {
  const candidates = fixture?.expected_candidates;
  if (!vault || typeof vault.physicalVaultRoot !== 'string'
      || !path.isAbsolute(vault.physicalVaultRoot)
      || !Array.isArray(candidates) || candidates.length === 0
      || candidates.some((candidate) => typeof candidate !== 'string' || candidate.length === 0)) {
    throw new SmokeError('CODEX_DIRECT_SUPERVISOR_FAILED');
  }
  const lines = candidates.map((candidate) => `  - ${candidate}`);
  const additionalContext = [
    `[deep-wiki] ${candidates.length}개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.`,
    '',
    '자동 ingest 대상:',
    '',
    ...lines,
    '',
    '이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. '
      + `vault 경로: ${vault.physicalVaultRoot}`,
    '',
  ].join('\n');
  return formatSessionStartOutput(additionalContext);
}

function assertPending(vault, fixture, code, nowMs = Date.now()) {
  if (!fs.existsSync(vault.pending)) throw new SmokeError(code);
  const bytes = fs.readFileSync(vault.pending);
  const text = bytes.toString('utf8');
  const maxAgeMs = fixture?.pending_scan?.max_age_ms;
  if (!PENDING_RE.test(text) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new SmokeError(code);
  }
  const timestamp = text.slice(0, -1);
  const parsedMs = Date.parse(timestamp);
  const canonical = Number.isFinite(parsedMs)
    && new Date(parsedMs).toISOString().replace('.000Z', 'Z') === timestamp;
  const ageMs = nowMs - parsedMs;
  if (!canonical || !Number.isFinite(nowMs) || ageMs < 0 || ageMs > maxAgeMs) {
    throw new SmokeError(code);
  }
  return { bytes: text, sha256: sha256(bytes), ageMs };
}

function assertNoAuthorityFiles(home) {
  const forbidden = /(?:auth|credential|access.?token|api.?key)/i;
  for (const entry of fs.readdirSync(home.codexHome, { withFileTypes: true })) {
    if (forbidden.test(entry.name)) throw new SmokeError('CODEX_AUTH_STORE_CREATED');
  }
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory, relativeDirectory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        visit(absolute, relative);
      } else if (child.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: relative, type: 'file', size: bytes.length, sha256: sha256(bytes) });
      } else {
        entries.push({ path: relative, type: 'other' });
      }
    }
  }
  visit(root, '');
  return JSON.stringify(entries);
}

function verifyInstalledTree(installedRoot, layout, platform) {
  const physical = fs.realpathSync.native(installedRoot);
  const physicalHome = fs.realpathSync.native(path.dirname(path.dirname(path.dirname(path.dirname(physical)))));
  if (!normalizePhysical(physical, platform).startsWith(`${normalizePhysical(physicalHome, platform)}${path.sep}`)) {
    throw new SmokeError('CODEX_PLUGIN_ROOT_MISMATCH');
  }
  const actual = {};
  for (const [relative, expectedHash] of Object.entries(layout.trackedManifest)) {
    const file = path.join(physical, ...relative.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new SmokeError('CODEX_INSTALLED_TREE_MISMATCH');
    const hash = sha256(fs.readFileSync(file));
    if (hash !== expectedHash) throw new SmokeError('CODEX_INSTALLED_TREE_MISMATCH');
    actual[relative] = hash;
  }
  for (const required of [
    'hooks/hooks.json',
    'hooks/scripts/scan-vault-changes.js',
    'hooks/scripts/scan-vault-worker.js',
  ]) {
    if (!Object.hasOwn(actual, required)) throw new SmokeError('CODEX_INSTALLED_TREE_MISMATCH');
  }
  const runtimeFiles = Object.keys(actual).filter((name) => name.startsWith('hooks/scripts/runtime/'));
  if (runtimeFiles.length === 0) throw new SmokeError('CODEX_INSTALLED_TREE_MISMATCH');
  return { root: physical, manifestSha256: sha256(JSON.stringify(actual)), fileCount: Object.keys(actual).length };
}

async function installCandidate(runProcess, codexBin, layout, home, env, platform, phase) {
  const processOptions = { cwd: layout.artifactRoot, env, timeoutMs: 30_000 };
  const addMarketplace = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'marketplace', 'add', layout.marketplaceRoot, '--json'],
    processOptions,
    { phase: `${phase}-marketplace-add`, layout },
  ), 'CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  if (addMarketplace.marketplaceName !== MARKETPLACE_NAME) throw new SmokeError('CODEX_MARKETPLACE_MISMATCH');
  const marketplaces = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'marketplace', 'list', '--json'],
    processOptions,
    { phase: `${phase}-marketplace-list`, layout },
  ), 'CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  if (!Array.isArray(marketplaces.marketplaces)
      || !marketplaces.marketplaces.some((entry) => entry.name === MARKETPLACE_NAME)) {
    throw new SmokeError('CODEX_MARKETPLACE_MISMATCH');
  }
  const installed = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'add', PLUGIN_ID, '--json'],
    processOptions,
    { phase: `${phase}-plugin-add`, layout },
  ), 'CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  if (installed.pluginId !== PLUGIN_ID || installed.marketplaceName !== MARKETPLACE_NAME
      || typeof installed.installedPath !== 'string' || !path.isAbsolute(installed.installedPath)) {
    throw new SmokeError('CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  }
  const plugins = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'list', '--marketplace', MARKETPLACE_NAME, '--json'],
    processOptions,
    { phase: `${phase}-plugin-list`, layout },
  ), 'CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  if (!Array.isArray(plugins.installed)
      || !plugins.installed.some((entry) => entry.pluginId === PLUGIN_ID && entry.installed === true)) {
    throw new SmokeError('CODEX_PLUGIN_SURFACE_UNAVAILABLE');
  }
  const tree = verifyInstalledTree(installed.installedPath, layout, platform);
  const physicalCodexHome = fs.realpathSync.native(home.codexHome);
  if (!normalizePhysical(tree.root, platform).startsWith(`${normalizePhysical(physicalCodexHome, platform)}${path.sep}`)) {
    throw new SmokeError('CODEX_PLUGIN_ROOT_MISMATCH');
  }
  return tree;
}

function buildProviderArgv(port, project, trusted, fixture) {
  const provider = `model_providers.${fixture.provider_id}={ name = "${fixture.provider_name}", base_url = "http://127.0.0.1:${port}/v1", env_key = "DEEP_WIKI_LOOPBACK_AUTH", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, stream_idle_timeout_ms = 10000, websocket_connect_timeout_ms = 1000, requires_openai_auth = false, supports_websockets = false }`;
  return [
    'exec',
    '-c', `model_provider="${fixture.provider_id}"`,
    '-c', provider,
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
    '--json',
    '--model', fixture.model,
    '--ephemeral',
    '--skip-git-repo-check',
    ...(trusted ? ['--dangerously-bypass-hook-trust'] : []),
    '--cd', project,
    `Return exactly ${fixture.response_text}`,
  ];
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(
      /\b((?:[A-Za-z][A-Za-z0-9_]*_)?(?:API_KEY|ACCESS_TOKEN))\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
      '$1=<redacted>',
    );
}

function trustedFailureMessage(result, reason, records = []) {
  const terminalErrors = records.flatMap((record) => {
    if (record?.type === 'error' && typeof record.message === 'string') return [record.message];
    if (record?.type === 'turn.failed' && typeof record?.error?.message === 'string') {
      return [record.error.message];
    }
    if (record?.type === 'item.completed' && record?.item?.type === 'error'
        && typeof record.item.message === 'string') return [record.item.message];
    return [];
  }).slice(0, 8).map((message) => redactDiagnosticText(message).slice(0, 1024));
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  return `CODEX_TRUSTED_EXEC_FAILED ${JSON.stringify({
    reason,
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    spawn_error_code: result?.error?.code || null,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    terminal_errors: terminalErrors,
    stderr_tail: redactDiagnosticText(stderr).slice(-4096),
  })}`;
}

function trustedJsonlReceipt(result, fixture) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch {
      if (!result || result.error || result.status !== 0) continue;
      throw new SmokeError('CODEX_TRUSTED_JSONL_INVALID');
    }
  }
  if (!result || result.error || result.status !== 0) {
    throw new SmokeError(
      'CODEX_TRUSTED_EXEC_FAILED',
      trustedFailureMessage(result, 'process-failed', records),
    );
  }
  const serialized = JSON.stringify(records);
  const exactAssistantResponse = records.some((record) => (
    record?.type === 'item.completed'
      && record?.item?.type === 'agent_message'
      && record.item.text === fixture.response_text
  ));
  if (!exactAssistantResponse || /hook[^\n]{0,40}error/i.test(serialized)) {
    throw new SmokeError(
      'CODEX_TRUSTED_EXEC_FAILED',
      trustedFailureMessage(
        result,
        exactAssistantResponse ? 'hook-error-recorded' : 'exact-assistant-response-missing',
        records,
      ),
    );
  }
  return { lineCount: records.length, sha256: sha256(result.stdout) };
}

async function runDiagnosticPhase(options) {
  const { root, runProcess, codexBin, fixture, baseInputEnv, platform } = options;
  const marketplaceRoot = path.join(root, 'diagnostic-marketplace');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'deep-wiki-diagnostic');
  const scripts = path.join(pluginRoot, 'hooks', 'scripts');
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'smoke'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), `${JSON.stringify({
    name: 'deep-wiki-diagnostic', version: '1.0.0', description: 'diagnostic', skills: './skills/',
  })}\n`);
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'smoke', 'SKILL.md'), '---\nname: smoke\ndescription: diagnostic\n---\n');
  fs.writeFileSync(path.join(scripts, 'diagnostic.js'), `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const result = { variant: process.argv[2], plugin_root: process.env.PLUGIN_ROOT, claude_plugin_root: process.env.CLAUDE_PLUGIN_ROOT };
result.equal = Boolean(result.plugin_root && (!result.claude_plugin_root || normalize(result.plugin_root) === normalize(result.claude_plugin_root)));
fs.writeFileSync(process.env.DEEP_WIKI_DIAGNOSTIC_MARKER, JSON.stringify(result));
if (!result.equal) process.exitCode = 42;
`);
  fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), `${JSON.stringify({
    description: 'diagnostic',
    hooks: { SessionStart: [{ matcher: '*', hooks: [{
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/diagnostic.js" command',
      commandWindows: 'node "${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\diagnostic.js" commandWindows',
      timeout: 15,
    }] }] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    name: 'deep-wiki-diagnostic',
    interface: { displayName: 'Diagnostic', shortDescription: 'Diagnostic' },
    plugins: [{
      name: 'deep-wiki-diagnostic', description: 'Diagnostic',
      source: { source: 'local', path: './plugins/deep-wiki-diagnostic' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity',
    }],
  }, null, 2)}\n`);
  const home = prepareHome(root, 'diagnostic');
  const project = path.join(root, 'diagnostic', 'project');
  const marker = path.join(root, 'diagnostic', 'marker.json');
  fs.mkdirSync(project, { recursive: true });
  const env = buildChildEnvironment(baseInputEnv, home, { DEEP_WIKI_DIAGNOSTIC_MARKER: marker });
  const processOptions = { cwd: project, env, timeoutMs: 30_000 };
  await checked(runProcess, codexBin, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], processOptions, { phase: 'diagnostic-marketplace-add' }, 'CODEX_DIAGNOSTIC_INSTALL_FAILED');
  const marketplaces = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'marketplace', 'list', '--json'],
    processOptions,
    { phase: 'diagnostic-marketplace-list' },
  ), 'CODEX_DIAGNOSTIC_INSTALL_FAILED');
  if (!marketplaces.marketplaces?.some((entry) => entry.name === 'deep-wiki-diagnostic')) {
    throw new SmokeError('CODEX_DIAGNOSTIC_INSTALL_FAILED');
  }
  const installed = parseJsonResult(await runProcess(codexBin, ['plugin', 'add', 'deep-wiki-diagnostic@deep-wiki-diagnostic', '--json'], processOptions, { phase: 'diagnostic-plugin-add' }), 'CODEX_DIAGNOSTIC_INSTALL_FAILED');
  const plugins = parseJsonResult(await runProcess(
    codexBin,
    ['plugin', 'list', '--marketplace', 'deep-wiki-diagnostic', '--json'],
    processOptions,
    { phase: 'diagnostic-plugin-list' },
  ), 'CODEX_DIAGNOSTIC_INSTALL_FAILED');
  if (!plugins.installed?.some((entry) => (
    entry.pluginId === 'deep-wiki-diagnostic@deep-wiki-diagnostic' && entry.installed === true
  ))) throw new SmokeError('CODEX_DIAGNOSTIC_INSTALL_FAILED');
  const server = await startLoopbackResponsesServer({
    fixture,
    expectedRequestCount: 1,
    beforeResponse() {
      if (!fs.existsSync(marker)) throw new SmokeError('CODEX_DIAGNOSTIC_HOOK_NOT_OBSERVED');
    },
  });
  let primaryError;
  try {
    const result = await runProcess(codexBin, buildProviderArgv(server.port, project, true, fixture), processOptions, { phase: 'diagnostic-exec', server });
    trustedJsonlReceipt(result, fixture);
  } catch (error) {
    primaryError = error;
  } finally {
    try { await server.close(); } catch (error) { primaryError ||= error; }
  }
  if (primaryError) throw primaryError;
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const expectedVariant = platform === 'win32' ? 'commandWindows' : 'command';
  const claudeAliasValid = value.claude_plugin_root === undefined
    || normalizePhysical(value.claude_plugin_root, platform) === normalizePhysical(installed.installedPath, platform);
  if (!value.equal || value.variant !== expectedVariant
      || normalizePhysical(value.plugin_root, platform) !== normalizePhysical(installed.installedPath, platform)
      || !claudeAliasValid) {
    throw new SmokeError('CODEX_DIAGNOSTIC_HOOK_NOT_OBSERVED');
  }
  assertNoAuthorityFiles(home);
  return { variant: value.variant, rootEqual: value.equal, requestCount: server.requests.length };
}

async function runCodexPluginHookSmoke(options = {}) {
  const codexBin = options.codexBin || '';
  const pluginRoot = path.resolve(options.pluginRoot || '');
  const platform = options.platform || process.platform;
  const runProcess = options.runProcess || defaultRunProcess;
  const inputEnv = options.env || process.env;
  assertAbsoluteFile(codexBin, 'CODEX_BIN_INVALID');
  assertAbsoluteDirectory(pluginRoot, 'CODEX_PLUGIN_ROOT_INVALID');
  const fixturePath = path.join(pluginRoot, 'tests', 'fixtures', 'codex-release-smoke.json');
  assertAbsoluteFile(fixturePath, 'CODEX_FIXTURE_INVALID');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  let layout;
  try {
    const bootstrapEnv = buildBootstrapEnvironment(inputEnv);
    const candidateSha = await resolveCandidateSha({ ...options, pluginRoot, env: bootstrapEnv }, runProcess);
    layout = await createCandidateLayout({ ...options, pluginRoot, env: bootstrapEnv }, runProcess, candidateSha);
    const versionHome = prepareHome(layout.artifactRoot, 'version');
    const versionEnv = buildChildEnvironment(inputEnv, versionHome);
    const version = await runProcess(codexBin, ['--version'], {
      cwd: pluginRoot, env: versionEnv, timeoutMs: 10_000,
    }, { phase: 'version' });
    if (!version || version.error || version.status !== 0
        || version.stdout.trim() !== EXPECTED_CODEX_VERSION) throw new SmokeError('CODEX_VERSION_MISMATCH');
    assertNoAuthorityFiles(versionHome);

    const trustedHome = prepareHome(layout.artifactRoot, 'trusted');
    const trustedVault = prepareVault(layout.artifactRoot, 'trusted', fixture, trustedHome);
    const trustedEnv = buildChildEnvironment(inputEnv, trustedHome);
    const trustedTree = await installCandidate(runProcess, codexBin, layout, trustedHome, trustedEnv, platform, 'trusted');

    if (fs.existsSync(trustedVault.pending)) throw new SmokeError('CODEX_PREMODEL_STATE_INVALID');
    let trustedPending;
    const trustedServer = await startLoopbackResponsesServer({
      fixture,
      expectedRequestCount: 1,
      beforeResponse(receipt) {
        trustedPending = assertPending(trustedVault, fixture, 'CODEX_PREMODEL_STATE_INVALID');
        receipt.pending_sha256 = trustedPending.sha256;
      },
    });
    let trustedResult;
    let trustedError;
    try {
      trustedResult = await runProcess(
        codexBin,
        buildProviderArgv(trustedServer.port, trustedVault.phaseRoot, true, fixture),
        { cwd: trustedVault.phaseRoot, env: trustedEnv, timeoutMs: 30_000 },
        { phase: 'trusted-exec', layout, installedPluginRoot: trustedTree.root, server: trustedServer },
      );
      trustedJsonlReceipt(trustedResult, fixture);
    } catch (error) {
      trustedError = error;
    } finally {
      try { await trustedServer.close(); } catch (error) { trustedError ||= error; }
    }
    if (trustedError) throw trustedError;
    trustedPending ||= assertPending(trustedVault, fixture, 'CODEX_PREMODEL_STATE_INVALID');
    assertNoAuthorityFiles(trustedHome);

    const directHome = prepareHome(layout.artifactRoot, 'direct');
    const directVault = prepareVault(layout.artifactRoot, 'direct', fixture, directHome);
    const directEnv = buildChildEnvironment(inputEnv, directHome);
    const directScript = path.join(trustedTree.root, 'hooks', 'scripts', 'scan-vault-changes.js');
    const direct = await runProcess(process.execPath, [directScript], {
      cwd: directVault.phaseRoot, env: directEnv, timeoutMs: 15_000,
    }, { phase: 'direct-supervisor', layout, installedPluginRoot: trustedTree.root });
    const expectedDirectOutput = buildExpectedDirectOutput(directVault, fixture);
    if (!direct || direct.error || direct.status !== 0 || direct.stderr !== ''
        || direct.stdout !== expectedDirectOutput) {
      throw new SmokeError('CODEX_DIRECT_SUPERVISOR_FAILED');
    }
    const directPending = assertPending(
      directVault, fixture, 'CODEX_DIRECT_SUPERVISOR_FAILED',
    );

    const untrustedHome = prepareHome(layout.artifactRoot, 'untrusted');
    const untrustedVault = prepareVault(layout.artifactRoot, 'untrusted', fixture, untrustedHome);
    const untrustedEnv = buildChildEnvironment(inputEnv, untrustedHome);
    await installCandidate(runProcess, codexBin, layout, untrustedHome, untrustedEnv, platform, 'untrusted');
    const untrustedBefore = snapshotTree(untrustedVault.wikiRoot);
    const assertUntrustedNoEffect = () => {
      if (fs.existsSync(untrustedVault.pending)
          || fs.existsSync(untrustedVault.transactionRoot)
          || snapshotTree(untrustedVault.wikiRoot) !== untrustedBefore) {
        throw new SmokeError('CODEX_UNTRUSTED_STATE_EFFECT');
      }
    };
    const untrustedServer = await startLoopbackResponsesServer({
      fixture,
      expectedRequestCount: 1,
      beforeResponse: assertUntrustedNoEffect,
    });
    let untrusted;
    let untrustedError;
    try {
      untrusted = await runProcess(
        codexBin,
        buildProviderArgv(untrustedServer.port, untrustedVault.phaseRoot, false, fixture),
        { cwd: untrustedVault.phaseRoot, env: untrustedEnv, timeoutMs: 30_000 },
        { phase: 'untrusted-exec', layout, server: untrustedServer },
      );
      trustedJsonlReceipt(untrusted, fixture);
      assertUntrustedNoEffect();
    } catch (error) {
      untrustedError = error;
    } finally {
      try { await untrustedServer.close(); } catch (error) { untrustedError ||= error; }
    }
    if (untrustedError) throw untrustedError;
    assertNoAuthorityFiles(untrustedHome);

    const diagnostic = await runDiagnosticPhase({
      root: layout.artifactRoot,
      runProcess,
      codexBin,
      fixture,
      baseInputEnv: inputEnv,
      platform,
    });
    const receipt = {
      candidate_sha: candidateSha,
      candidate_manifest_sha256: sha256(JSON.stringify(layout.trackedManifest)),
      installed_manifest_sha256: trustedTree.manifestSha256,
      installed_file_count: trustedTree.fileCount,
      codex_version: EXPECTED_CODEX_VERSION,
      codex_binary_sha256: sha256(fs.readFileSync(codexBin)),
      provider_id: fixture.provider_id,
      provider_config_sha256: sha256(buildProviderArgv(0, '<project>', true, fixture).slice(0, 10).join('\0')),
      fixture_sha256: sha256(fs.readFileSync(fixturePath)),
      trusted: {
        request_count: trustedServer.requests.length,
        request: trustedServer.requests[0],
        pending_sha256: trustedPending.sha256,
        jsonl_sha256: sha256(trustedResult.stdout),
      },
      direct_installed_supervisor: {
        stderr_empty: direct.stderr === '',
        stdout_sha256: sha256(direct.stdout),
        pending_sha256: directPending.sha256,
      },
      untrusted: {
        deep_wiki_effect: false,
        model_continued: true,
        request_count: untrustedServer.requests.length,
        mutated: false,
      },
      diagnostic,
      public_bearer_classification: 'committed-local-routing-fixture',
    };
    return receipt;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError('CODEX_SMOKE_INTERNAL_ERROR', 'CODEX_SMOKE_INTERNAL_ERROR', { cause: error });
  } finally {
    if (layout && !options.keepArtifacts) fs.rmSync(layout.artifactRoot, { recursive: true, force: true });
  }
}

module.exports = {
  EXPECTED_CODEX_VERSION,
  SmokeError,
  assertPending,
  buildChildEnvironment,
  buildExpectedDirectOutput,
  buildProviderArgv,
  createCandidateLayout,
  defaultRunProcess,
  runCodexPluginHookSmoke,
  trustedJsonlReceipt,
};

if (require.main === module) {
  runCodexPluginHookSmoke({
    codexBin: process.env.CODEX_BIN,
    candidateSha: process.env.GITHUB_SHA,
    pluginRoot: path.resolve(__dirname, '..'),
    platform: process.platform,
    env: process.env,
  }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.code || 'CODEX_SMOKE_INTERNAL_ERROR'}\n`);
      process.exitCode = 1;
    },
  );
}
