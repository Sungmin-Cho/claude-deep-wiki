'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('Codex manifest uses default hook discovery and has no MCP surface', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.equal(manifest.skills, './skills/');
});

test('all package versions remain exactly aligned', () => {
  const versions = [
    readJson('.codex-plugin/plugin.json').version,
    readJson('.claude-plugin/plugin.json').version,
    readJson('package.json').version,
  ];
  assert.equal(new Set(versions).size, 1, `version drift: ${versions.join(', ')}`);
});

test('default SessionStart hook has one supported command entry', () => {
  const config = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(config).sort(), ['description', 'hooks']);
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart']);
  assert.equal(config.hooks.SessionStart.length, 1);

  const registration = config.hooks.SessionStart[0];
  assert.equal(registration.matcher, '*');
  assert.equal(registration.hooks.length, 1);

  const command = registration.hooks[0];
  const allowed = new Set(['type', 'command', 'commandWindows', 'timeout', 'statusMessage']);
  assert.deepEqual(
    Object.keys(command).filter((key) => !allowed.has(key)),
    [],
  );
  assert.equal(command.type, 'command');
  assert.equal(command.timeout, 15);
  assert.equal(command.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js"');
  assert.equal(command.commandWindows, 'node "${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\scan-vault-changes.js"');
  for (const value of [command.command, command.commandWindows]) {
    assert.doesNotMatch(value, /[|;&<>`\r\n]|\$\(/);
    assert.doesNotMatch(value, /\.(?:sh|cmd|bat|ps1)(?:"|\s|$)/i);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'hooks', 'scripts', 'scan-vault-changes.sh')), false);
});

test('portable npm test cannot discover the native installed-Codex release smoke', () => {
  const pkg = readJson('package.json');
  const portable = pkg.scripts.test;
  const driver = path.join(ROOT, 'tests', 'codex-plugin-hook-smoke-driver.test.js');
  const release = path.join(ROOT, 'tests', 'release', 'codex-plugin-hook-smoke.release.js');

  assert.equal(fs.existsSync(driver), true);
  assert.equal(fs.existsSync(release), true);
  assert.match(driver, /\.test\.js$/);
  assert.doesNotMatch(release, /\.test\.js$/);
  assert.doesNotMatch(portable, /codex-plugin-hook-smoke\.release|test:codex-windows-release/);
  assert.match(portable, /^node --test --test-concurrency=1$/);

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'codex-plugin-hook-smoke.js'), 'utf8');
  const releaseSource = fs.readFileSync(release, 'utf8');
  const helper = path.join(ROOT, 'tests', 'helpers', 'codex-loopback-responses.js');
  const fixture = path.join(ROOT, 'tests', 'fixtures', 'codex-release-smoke.json');
  assert.equal(fs.existsSync(helper), true);
  assert.equal(fs.existsSync(fixture), true);
  for (const label of ['ubuntu-24.04', 'macos-15', 'macos-15-intel', 'windows-2025']) {
    assert.match(workflow, new RegExp(`- os: ${label.replaceAll('.', '\\.')}(?:\\r?\\n|$)`));
  }
  assert.doesNotMatch(workflow, /ubuntu-latest|macos-latest|windows-latest|workflow_dispatch/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /EXPECTED_SHA:.*pull_request\.head\.sha/);
  assert.match(workflow, /ref:.*EXPECTED_SHA/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /git'.*'rev-parse'.*'HEAD'/s);
  for (const command of [
    'npm test', 'npm run validate-fixture', 'npm run lint:commands',
    'npm run lint:agents', 'npm run validate-plugin',
  ]) assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  assert.match(workflow, /@openai\/codex@0\.144\.1/);
  assert.match(workflow, /@openai\/codex-win32-x64\/vendor\/x86_64-pc-windows-msvc\/bin\/codex\.exe/);
  assert.match(workflow, /--ignore-scripts/);
  assert.match(workflow, /codex-cli 0\.144\.1/);
  assert.match(workflow, /vendorVersion -ne '0\.144\.1-win32-x64'/);
  assert.match(workflow, /test:codex-windows-release/);
  assert.match(releaseSource, /CANDIDATE_SHA/);
  assert.match(releaseSource, /CODEX_BINARY_SHA256/);
  assert.match(releaseSource, /await runCodexPluginHookSmoke/);
  assert.doesNotMatch(`${workflow}\n${smoke}\n${releaseSource}`, /process\.env\.(?:OPENAI_API_KEY|CODEX_ACCESS_TOKEN)|secrets\.|vars\.|environment:/);
  assert.doesNotMatch(workflow, /https?:\/\/(?!github\.com\/actions|registry\.npmjs)/);
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'windows-codex-release.yml')), false);

  const helperSource = fs.readFileSync(helper, 'utf8');
  const fixtureValue = readJson('tests/fixtures/codex-release-smoke.json');
  assert.match(helperSource, /1024 \* 1024/);
  assert.match(helperSource, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.match(helperSource, /body_sha256/);
  assert.doesNotMatch(helperSource, /rawBody|raw_prompt|prompt_text/);
  assert.equal(fixtureValue.request.method, 'POST');
  assert.equal(fixtureValue.request.path, '/v1/responses');
  assert.deepEqual(fixtureValue.sse_events, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.equal(fixtureValue.public_bearer, 'deep-wiki-loopback-public-v1');
  assert.equal(fixtureValue.model, 'gpt-5.4-mini');

  assert.match(smoke, /git',\s*\['ls-tree', '-r', '-z', '--full-tree'/);
  assert.match(smoke, /git',\s*\['cat-file', 'blob'/);
  assert.doesNotMatch(smoke, /stableTrustDenial|UNTRUSTED_HOOK_DENIAL|denied:\s*true/);
  assert.match(smoke, /deep_wiki_effect:\s*false/);
  assert.match(smoke, /model_continued:\s*true/);
  assert.match(smoke, /direct_installed_supervisor/);
  assert.match(smoke, /direct\.stdout !== expectedDirectOutput/);
  assert.doesNotMatch(smoke, /DIRECT_SUPERVISOR_PARITY|expectedInputText/);
  assert.match(smoke, /record\?\.item\?\.type === 'agent_message'/);
  assert.match(smoke, /ageMs > maxAgeMs/);
  assert.match(smoke, /diagnostic-exec/);
  assert.ok(smoke.lastIndexOf('untrusted-exec') < smoke.lastIndexOf('const diagnostic = await runDiagnosticPhase'));
  assert.match(smoke, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(smoke, /shell: false/);
  assert.match(smoke, /windowsHide: true/);
});
