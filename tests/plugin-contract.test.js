'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
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

test('1.9.4 release keeps package identity and bilingual changelogs exact', () => {
  const packageFiles = [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'package.json',
  ];
  for (const file of packageFiles) assert.equal(readJson(file).version, '1.9.4', file);

  const releaseSection = (text, heading) => {
    const start = text.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const next = text.indexOf('\n## [', start + heading.length);
    return text.slice(start, next === -1 ? undefined : next);
  };
  const changelog = readText('CHANGELOG.md');
  const changelogKo = readText('CHANGELOG.ko.md');
  assert.equal(releaseSection(changelog, '## [Unreleased]').trim(), '## [Unreleased]');
  assert.equal(releaseSection(changelogKo, '## [Unreleased]').trim(), '## [Unreleased]');

  const english = releaseSection(
    changelog,
    '## [1.9.4] — 2026-07-31 (lint repair reclamation)',
  );
  assert.match(english, /Completed scan-window `ensure` journals/);
  assert.match(english, /self-healing reclamation/);
  assert.match(english, /Fractional-clock `lint fix` operations/);
  assert.match(english, /MANIFEST_INVALID/);
  assert.match(english, /distinct 1\.9\.4 installation identity/);

  const korean = releaseSection(
    changelogKo,
    '## [1.9.4] — 2026-07-31 (lint repair 회수)',
  );
  assert.match(korean, /완료된 scan-window `ensure` journal/);
  assert.match(korean, /자체 복구 회수/);
  assert.match(korean, /Fractional-clock `lint fix` 작업/);
  assert.match(korean, /MANIFEST_INVALID/);
  assert.match(korean, /별도 1\.9\.4 설치 식별자/);

  assert.match(
    releaseSection(changelog, '## [1.9.3] — 2026-07-30'),
    /wiki-runtime snapshot/,
  );
  assert.match(
    releaseSection(changelogKo, '## [1.9.3] — 2026-07-30'),
    /wiki-runtime snapshot/,
  );
});

test('1.8.0 release documents the reviewed runtime and evidence boundary', () => {
  // CLAUDE.md is excluded: AGENTS.md is the single source for shared runtime rules
  // and CLAUDE.md reaches it through `@AGENTS.md`. Asserting the boundary in both
  // would require the duplication the AGENTS-first restructure removed. That import
  // is what makes the exclusion sound, so it is asserted rather than assumed.
  // Pinned to line 1: a multiline-anchored match would accept the import anywhere
  // in the file, which is not the AGENTS-first standard.
  assert.equal(readText('CLAUDE.md').split('\n')[0].trim(), '@AGENTS.md');
  const englishRuntimeDocs = [
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md',
  ];
  const englishBoundary = [
    /cooperative current writer/i,
    /post-seizure owner and directory checks/i,
    /stopped-host intervention/i,
    /concurrent old version/i,
    /mounted-filesystem and process-termination durability/i,
    /%COMSPEC%\s+\/C/,
    /no shipped shell-script runtime/i,
    /Windows Server 2025/,
    /macOS arm64 and Intel/,
    /no Windows 11 claim/i,
    /no plugin MCP server or native binary/i,
    /backup-only downgrade/i,
    /unauthenticated local Responses fixture/i,
    /not production OpenAI API, login, model-quality, Windows 11, arbitrary-user-machine, or OS-level no-egress certification/i,
  ];
  for (const file of englishRuntimeDocs) {
    const text = readText(file).replace(/\s+/g, ' ');
    for (const pattern of englishBoundary) assert.match(text, pattern, `${file}: ${pattern}`);
  }

  const koreanRuntimeDocs = ['README.ko.md'];
  const koreanBoundary = [
    /협력적 현재 writer/,
    /탈취 후 owner와 directory 검사/,
    /host를 중지한 상태의 개입/,
    /구버전 동시 실행 금지/,
    /마운트된 파일시스템과 프로세스 종료 내구성/,
    /%COMSPEC%\s+\/C/,
    /배포 shell-script runtime 없음/,
    /Windows Server 2025/,
    /macOS arm64와 Intel/,
    /Windows 11 주장 없음/,
    /플러그인 MCP 서버나 native binary 없음/,
    /백업 전용 downgrade/,
    /인증 없는 로컬 Responses fixture/,
    /프로덕션 OpenAI API, login, model 품질, Windows 11, 임의 사용자 머신, OS 수준 no-egress 인증이 아니다/,
  ];
  for (const file of koreanRuntimeDocs) {
    const text = readText(file).replace(/\s+/g, ' ');
    for (const pattern of koreanBoundary) assert.match(text, pattern, `${file}: ${pattern}`);
  }

  assert.match(readText('CHANGELOG.md'), /## \[1\.8\.0\] — 2026-07-19/);
  assert.match(readText('CHANGELOG.md'), /unauthenticated local Responses fixture/i);
  assert.match(readText('CHANGELOG.ko.md'), /## \[1\.8\.0\] — 2026-07-19/);
  assert.match(readText('CHANGELOG.ko.md'), /인증 없는 로컬 Responses fixture/);
});

test('1.8.0 ships no MCP, native binary, runtime dependency, or shell entrypoint', () => {
  const codexManifest = readJson('.codex-plugin/plugin.json');
  const claudeManifest = readJson('.claude-plugin/plugin.json');
  const pkg = readJson('package.json');
  assert.equal(Object.hasOwn(codexManifest, 'mcpServers'), false);
  assert.equal(Object.hasOwn(claudeManifest, 'mcpServers'), false);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(Object.hasOwn(pkg, field), false, field);
  }

  const tracked = childProcess.execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  assert.deepEqual(tracked.filter((file) => /(^|\/)\.mcp\.json$/.test(file)), []);
  assert.deepEqual(tracked.filter((file) => file.startsWith('native/')), []);

  const shellEntrypoints = tracked.filter((file) => /\.(?:sh|cmd|bat|ps1)$/i.test(file));
  assert.deepEqual(shellEntrypoints.sort(), [
    'scripts/v0-probe/v0-record.sh',
    'scripts/v0-probe/v1-record.sh',
    'scripts/v0-probe/v2-v3-record.sh',
  ]);
});
