'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const releaseFixture = require('./fixtures/codex-release-smoke.json');
const {
  buildResponsesEvents,
  startLoopbackResponsesServer,
} = require('./helpers/codex-loopback-responses.js');
const {
  buildChildEnvironment,
  buildExpectedDirectOutput,
  buildProviderArgv,
  createCandidateLayout,
  defaultRunProcess,
  assertPending,
  runCodexPluginHookSmoke,
  trustedJsonlReceipt,
} = require('../scripts/codex-plugin-hook-smoke.js');

const repositoryRoot = path.resolve(__dirname, '..');

test('local Responses helper emits the exact ordered nine-event stream', () => {
  const events = buildResponsesEvents(releaseFixture);
  assert.equal(events.length, 9);
  assert.deepEqual(events.map(({ event }) => event), releaseFixture.sse_events);
  assert.deepEqual(events.map(({ data }) => data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(events.at(-1).data.response.output[0].content[0].text, releaseFixture.response_text);
  assert.deepEqual(events.at(-1).data.response.usage, {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  });
  const serialized = events.map(({ event, data }) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join('');
  assert.equal(serialized.includes('\r'), false);
  assert.equal(serialized.includes('[DONE]'), false);
  assert.deepEqual(events.map(({ data }) => Object.keys(data).sort()), [
    ['response', 'sequence_number', 'type'],
    ['response', 'sequence_number', 'type'],
    ['item', 'output_index', 'sequence_number', 'type'],
    ['content_index', 'item_id', 'output_index', 'part', 'sequence_number', 'type'],
    ['content_index', 'delta', 'item_id', 'logprobs', 'output_index', 'sequence_number', 'type'],
    ['content_index', 'item_id', 'logprobs', 'output_index', 'sequence_number', 'text', 'type'],
    ['content_index', 'item_id', 'output_index', 'part', 'sequence_number', 'type'],
    ['item', 'output_index', 'sequence_number', 'type'],
    ['response', 'sequence_number', 'type'],
  ]);
  assert.deepEqual(Object.keys(events[0].data.response).sort(), [
    'background', 'created_at', 'error', 'id', 'incomplete_details', 'instructions',
    'max_output_tokens', 'max_tool_calls', 'metadata', 'model', 'object', 'output',
    'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key', 'reasoning',
    'safety_identifier', 'service_tier', 'status', 'store', 'temperature', 'text',
    'tool_choice', 'tools', 'top_logprobs', 'top_p', 'truncation', 'usage', 'user',
  ].sort());
});

test('local Responses server binds loopback, authenticates invariants, and closes', async () => {
  const server = await startLoopbackResponsesServer({ fixture: releaseFixture, expectedRequestCount: 1 });
  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${releaseFixture.public_bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: releaseFixture.model,
        stream: true,
        store: false,
        input: [{
          role: 'user',
          content: `fixture prompt is never retained: ${releaseFixture.expected_candidates.join(',')}`,
        }],
      }),
    });
    assert.equal(response.status, 200);
    const bytes = await response.text();
    assert.equal((bytes.match(/^event: /gm) || []).length, 9);
    assert.equal(bytes.includes('[DONE]'), false);
    assert.equal(server.requests.length, 1);
    assert.equal(Object.hasOwn(server.requests[0], 'rawBody'), false);
    assert.equal(server.requests[0].authorization_public, true);
  } finally { await server.close(); }
});

test('local Responses server rejects a wrong request and authenticates zero-request close', async () => {
  const rejecting = await startLoopbackResponsesServer({ fixture: releaseFixture, expectedRequestCount: 1 });
  const response = await fetch(`${rejecting.baseUrl}/responses`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${releaseFixture.public_bearer}`,
      'content-type': 'application/json',
    },
  });
  assert.equal(response.status, 400);
  await response.text();
  await assert.rejects(rejecting.close, /LOOPBACK_REQUEST_CONTRACT/);

  const zero = await startLoopbackResponsesServer({ fixture: releaseFixture, expectedRequestCount: 0 });
  await zero.close();
  assert.deepEqual(zero.requests, []);
});

test('shipped Windows hook models Codex commandWindows expansion through the outer command processor', () => {
  const hookDocument = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'hooks', 'hooks.json'), 'utf8'));
  const hook = hookDocument.hooks.SessionStart[0].hooks[0];
  const installedRoot = 'C:\\Users\\Example User\\.codex\\plugins\\deep-wiki';
  const expanded = hook.commandWindows.replaceAll('${CLAUDE_PLUGIN_ROOT}', installedRoot);
  assert.equal(hook.commandWindows, 'node "${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\scan-vault-changes.js"');
  assert.equal(expanded, 'node "C:\\Users\\Example User\\.codex\\plugins\\deep-wiki\\hooks\\scripts\\scan-vault-changes.js"');
  assert.doesNotMatch(expanded, /[|;&<>`\r\n]|\$\(/);
});

test('provider argv is exact, secret-free, non-retrying, and trust differs by one flag', () => {
  const trusted = buildProviderArgv(43123, 'C:\\Project Space', true, releaseFixture);
  const untrusted = buildProviderArgv(43124, 'C:\\Other Project', false, releaseFixture);
  assert.deepEqual(trusted, [
    'exec',
    '-c', 'model_provider="deep-wiki-loopback"',
    '-c', 'model_providers.deep-wiki-loopback={ name = "Deep Wiki Loopback", base_url = "http://127.0.0.1:43123/v1", env_key = "DEEP_WIKI_LOOPBACK_AUTH", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, stream_idle_timeout_ms = 10000, websocket_connect_timeout_ms = 1000, requires_openai_auth = false, supports_websockets = false }',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
    '--json', '--model', 'gpt-5.4-mini', '--ephemeral', '--skip-git-repo-check',
    '--dangerously-bypass-hook-trust', '--cd', 'C:\\Project Space',
    'Return exactly DEEP_WIKI_SMOKE_OK',
  ]);
  assert.equal(trusted.filter((value) => value === '--dangerously-bypass-hook-trust').length, 1);
  assert.equal(untrusted.includes('--dangerously-bypass-hook-trust'), false);
  const normalize = (argv, project) => argv
    .filter((value) => value !== '--dangerously-bypass-hook-trust')
    .map((value) => value === project
      ? '<project>'
      : value.replace(/http:\/\/127\.0\.0\.1:\d+\/v1/, 'http://127.0.0.1:<port>/v1'));
  assert.deepEqual(normalize(trusted, 'C:\\Project Space'), normalize(untrusted, 'C:\\Other Project'));
  assert.doesNotMatch(JSON.stringify([trusted, untrusted]), /login|with-api-key|OPENAI_API_KEY|CODEX_ACCESS_TOKEN|"--websocket"|https:\/\/|request_max_retries = [1-9]|stream_max_retries = [1-9]/i);
});

test('child environment is a closed allowlist with a committed public routing fixture', () => {
  const root = path.resolve(os.tmpdir(), 'deep wiki env');
  const directories = {
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'home', '.codex'),
    appData: path.join(root, 'home', 'AppData', 'Roaming'),
    localAppData: path.join(root, 'home', 'AppData', 'Local'),
  };
  const env = buildChildEnvironment({
    PATH: '/safe', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
    HTTPS_PROXY: 'http://proxy.invalid', RANDOM_AMBIENT: 'ambient',
  }, directories);
  assert.deepEqual(Object.keys(env).sort(), [
    'APPDATA', 'CODEX_HOME', 'DEEP_WIKI_LOOPBACK_AUTH', 'HOME', 'LOCALAPPDATA',
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'USERPROFILE',
  ]);
  assert.equal(env.DEEP_WIKI_LOOPBACK_AUTH, releaseFixture.public_bearer);
  assert.doesNotMatch(JSON.stringify(env), /secret|proxy\.invalid|RANDOM_AMBIENT/);
});

test('candidate marketplace reconstructs every tracked blob from one exact commit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-candidate-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rev = await defaultRunProcess('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, env: process.env, timeoutMs: 10_000,
  }, { phase: 'test-rev' });
  const candidateSha = rev.stdout.trim();
  const layout = await createCandidateLayout({
    pluginRoot: repositoryRoot, workRoot: root, env: process.env,
  }, defaultRunProcess, candidateSha);
  assert.equal(layout.candidateSha, candidateSha);
  assert.ok(Object.keys(layout.trackedManifest).length > 50);
  assert.equal(layout.trackedManifest['hooks/hooks.json'], shaFile(path.join(repositoryRoot, 'hooks', 'hooks.json')));
  assert.equal(fs.lstatSync(layout.candidateRoot).isSymbolicLink(), false);
});

function shaFile(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

test('pending receipt requires a canonical valid timestamp inside the fixture freshness window', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-pending-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pending = path.join(root, '.pending-scan');
  const vault = { pending };
  const nowMs = Date.parse('2026-07-18T12:00:30Z');

  fs.writeFileSync(pending, '2026-07-18T12:00:00Z\n');
  assert.equal(assertPending(vault, releaseFixture, 'PENDING_INVALID', nowMs).bytes,
    '2026-07-18T12:00:00Z\n');

  for (const value of [
    '2026-99-99T12:00:00Z\n',
    '2026-07-18T11:59:29Z\n',
    '2026-07-18T12:00:31Z\n',
  ]) {
    fs.writeFileSync(pending, value);
    assert.throws(() => assertPending(vault, releaseFixture, 'PENDING_INVALID', nowMs),
      { code: 'PENDING_INVALID' });
  }
});

test('direct installed supervisor witness requires one exact parent-formatted message', (t) => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-output-root-'));
  t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));
  const physicalVaultRoot = fs.realpathSync.native(vaultRoot);
  const additionalContext = [
    '[deep-wiki] 1개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.',
    '',
    '자동 ingest 대상:',
    '',
    '  - 노트/Windows 검증.md',
    '',
    `이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. vault 경로: ${physicalVaultRoot}`,
    '',
  ].join('\n');
  assert.deepEqual(JSON.parse(buildExpectedDirectOutput({ physicalVaultRoot }, releaseFixture)), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
});

test('default process runner launches the observed executable with shell disabled', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => true;
  process.nextTick(() => child.emit('close', 0, null));

  const result = await defaultRunProcess('/nonexistent/deep-wiki-node', ['script.js'], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH || '' },
    timeoutMs: 1_000,
    spawn(file, args, options) {
      calls.push({ file, args, options });
      return child;
    },
  }, { phase: 'spawn-observation' });

  assert.equal(result.status, 0);
  assert.deepEqual(calls.map(({ file, args, options }) => ({
    file,
    args,
    shell: options.shell,
    stdio: options.stdio,
    detached: options.detached,
    windowsHide: options.windowsHide,
  })), [{
    file: '/nonexistent/deep-wiki-node',
    args: ['script.js'],
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  }]);
});

test('release smoke fixture pins local policy bytes', () => {
  assert.equal(releaseFixture.local_config_json, [
    '{',
    '  "auto_ingest": {',
    '    "ignore_globs": []',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(JSON.parse(releaseFixture.local_config_json), {
    auto_ingest: { ignore_globs: [] },
  });
});

test('Codex JSONL receipt requires the exact completed assistant message', () => {
  const exact = `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: releaseFixture.response_text },
  })}\n`;
  assert.doesNotThrow(() => trustedJsonlReceipt(result(0, exact), releaseFixture));

  const substringOnly = `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', text: `diagnostic=${releaseFixture.response_text}` },
  })}\n`;
  assert.throws(() => trustedJsonlReceipt(result(0, substringOnly), releaseFixture),
    { code: 'CODEX_TRUSTED_EXEC_FAILED' });
});

test('Codex trusted failure reports bounded structured evidence without secrets', () => {
  const failed = result(
    7,
    `${JSON.stringify({
      type: 'turn.failed',
      error: {
        message: 'hook command failed CODEX_ACCESS_TOKEN="codex-private" CUSTOM_API_KEY=custom-private',
      },
    })}\n`,
    "Authorization: Bearer private-value OPENAI_API_KEY=sk-private-value ACCESS_TOKEN='access-private'",
  );
  assert.throws(
    () => trustedJsonlReceipt(failed, releaseFixture),
    (error) => {
      assert.equal(error.code, 'CODEX_TRUSTED_EXEC_FAILED');
      assert.match(error.message, /"status":7/);
      assert.match(error.message, /hook command failed/);
      assert.match(error.message, /<redacted>/);
      assert.doesNotMatch(
        error.message,
        /private-value|sk-private|codex-private|custom-private|access-private/,
      );
      return true;
    },
  );
});

test('portable full-phase seam proves trusted pre-model effect, independent direct supervisor, untrusted no-state-effect, and diagnostic-last', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-full-seam-'));
  const codexBin = path.join(root, 'codex.exe');
  fs.writeFileSync(codexBin, 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const phases = [];
  const directLaunches = [];
  let diagnosticMarketplace;

  async function fakeRun(file, args, options, context = {}) {
    phases.push(context.phase || 'unknown');
    if (context.phase === 'direct-supervisor') {
      directLaunches.push({ file, args, cwd: options.cwd });
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [path.join(context.installedPluginRoot, 'hooks', 'scripts', 'scan-vault-changes.js')]);
      return defaultRunProcess(file, args, options, context);
    }
    if (file === 'git' || file === process.execPath) {
      return defaultRunProcess(file, args, options, context);
    }
    if (context.phase === 'version') return result(0, 'codex-cli 0.144.1\n');
    if (context.phase?.endsWith('marketplace-add')) {
      if (context.phase === 'diagnostic-marketplace-add') diagnosticMarketplace = args[3];
      return result(0, JSON.stringify({
        marketplaceName: context.phase === 'diagnostic-marketplace-add' ? 'deep-wiki-diagnostic' : 'deep-wiki-smoke',
        installedRoot: args[3], alreadyAdded: false,
      }));
    }
    if (context.phase?.endsWith('marketplace-list')) {
      const diagnostic = context.phase === 'diagnostic-marketplace-list';
      return result(0, JSON.stringify({ marketplaces: [{
        name: diagnostic ? 'deep-wiki-diagnostic' : 'deep-wiki-smoke',
        root: diagnostic ? diagnosticMarketplace : context.layout.marketplaceRoot,
      }] }));
    }
    if (context.phase?.endsWith('plugin-add')) {
      const diagnostic = context.phase === 'diagnostic-plugin-add';
      const name = diagnostic ? 'deep-wiki-diagnostic' : 'deep-wiki';
      const market = diagnostic ? 'deep-wiki-diagnostic' : 'deep-wiki-smoke';
      const source = diagnostic
        ? path.join(diagnosticMarketplace, 'plugins', 'deep-wiki-diagnostic')
        : context.layout.candidateRoot;
      const installedPath = path.join(options.env.CODEX_HOME, 'plugins', 'cache', market, name, diagnostic ? '1.0.0' : '1.7.1');
      fs.cpSync(source, installedPath, { recursive: true });
      return result(0, JSON.stringify({
        pluginId: `${name}@${market}`, name, marketplaceName: market,
        version: diagnostic ? '1.0.0' : '1.7.1', installedPath,
      }));
    }
    if (context.phase?.endsWith('plugin-list')) {
      const diagnostic = context.phase === 'diagnostic-plugin-list';
      return result(0, JSON.stringify({ installed: [{
        pluginId: diagnostic
          ? 'deep-wiki-diagnostic@deep-wiki-diagnostic'
          : 'deep-wiki@deep-wiki-smoke',
        installed: true,
      }] }));
    }
    if (context.phase === 'trusted-exec') {
      const scanner = path.join(context.installedPluginRoot, 'hooks', 'scripts', 'scan-vault-changes.js');
      const hook = await defaultRunProcess(process.execPath, [scanner], options, { phase: 'fake-trusted-hook' });
      assert.equal(hook.status, 0);
      assert.equal(hook.stderr, '');
      await requestLoopback(context.server, hook.stdout);
      return result(0, `${JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: releaseFixture.response_text },
      })}\n`);
    }
    if (context.phase === 'untrusted-exec') {
      await requestLoopback(context.server, releaseFixture.expected_candidates.join(','));
      return result(0, `${JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: releaseFixture.response_text },
      })}\n`);
    }
    if (context.phase === 'diagnostic-exec') {
      const installed = path.join(options.env.CODEX_HOME, 'plugins', 'cache', 'deep-wiki-diagnostic', 'deep-wiki-diagnostic', '1.0.0');
      const hook = await defaultRunProcess(process.execPath, [
        path.join(installed, 'hooks', 'scripts', 'diagnostic.js'), 'commandWindows',
      ], {
        ...options,
        env: {
          ...options.env,
          PLUGIN_ROOT: installed,
        },
      }, { phase: 'fake-diagnostic-hook' });
      assert.equal(hook.status, 0);
      await requestLoopback(context.server, releaseFixture.expected_candidates.join(','));
      return result(0, `${JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: releaseFixture.response_text },
      })}\n`);
    }
    throw new Error(`unexpected fake phase: ${context.phase}`);
  }

  const receipt = await runCodexPluginHookSmoke({
    codexBin,
    candidateSha: (await defaultRunProcess('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot, env: process.env,
    })).stdout.trim(),
    pluginRoot: repositoryRoot,
    platform: 'win32',
    workRoot: root,
    env: { PATH: process.env.PATH || '', SystemRoot: 'C:\\Windows' },
    runProcess: fakeRun,
  });
  assert.equal(receipt.codex_version, 'codex-cli 0.144.1');
  assert.equal(receipt.trusted.request_count, 1);
  assert.equal(receipt.trusted.local_config_sha256, sha256Text(releaseFixture.local_config_json));
  assert.equal(receipt.direct_installed_supervisor.stderr_empty, true);
  assert.equal(receipt.direct_installed_supervisor.local_config_sha256, sha256Text(releaseFixture.local_config_json));
  assert.deepEqual(receipt.untrusted, {
    deep_wiki_effect: false,
    model_continued: true,
    request_count: 1,
    mutated: false,
  });
  assert.deepEqual(receipt.diagnostic, { variant: 'commandWindows', rootEqual: true, requestCount: 1 });
  assert.equal(directLaunches.length, 1);
  assert.ok(phases.indexOf('trusted-exec') < phases.indexOf('direct-supervisor'));
  assert.ok(phases.indexOf('untrusted-exec') < phases.indexOf('diagnostic-exec'));
});

function result(status, stdout = '', stderr = '') {
  const stdoutBuffer = Buffer.from(stdout);
  const stderrBuffer = Buffer.from(stderr);
  return { status, signal: null, error: null, stdout, stderr, stdoutBuffer, stderrBuffer };
}

async function requestLoopback(server, hookText) {
  const response = await fetch(`${server.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${releaseFixture.public_bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: releaseFixture.model,
      stream: true,
      store: false,
      input: [{ role: 'user', content: hookText }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
}
