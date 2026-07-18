'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseMarkdownCommands,
  validateSkillCommands,
  validateHookCommands,
  tokenizePosixCommand,
  tokenizeWindowsCommand,
  modelHookInvocation,
  SKILL_COMMAND_CONTRACTS,
} = require('../scripts/lib/executable-contract.js');

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'executable-contract-cases.json'),
  'utf8',
));

test('parseMarkdownCommands preserves executable argv and source coordinates', () => {
  const fixture = FIXTURES.markdown.find((entry) => entry.name === 'node-windows-unicode-path');
  const parsed = parseMarkdownCommands(fixture.source);
  assert.deepEqual(parsed.violations, []);
  assert.equal(parsed.commands.length, 1);
  assert.deepEqual(parsed.commands[0], fixture.expectedCommand);
});

for (const fixture of FIXTURES.markdown) {
  test(`Markdown executable contract: ${fixture.name}`, () => {
    const result = validateSkillCommands(
      fixture.file || `skills/${fixture.name}/SKILL.md`,
      fixture.source,
      fixture.allowlist || [],
    );
    const reasons = result.violations.map((violation) => violation.reason);
    if (fixture.valid) {
      assert.deepEqual(result.violations, []);
      assert.equal(result.commands.length, fixture.commandCount);
    } else {
      assert.ok(
        reasons.includes(fixture.expectedReason),
        `expected ${fixture.expectedReason}; got ${JSON.stringify(result.violations)}`,
      );
    }
  });
}

for (const fixture of FIXTURES.hooks) {
  test(`Hook executable contract: ${fixture.name}`, () => {
    const result = validateHookCommands(fixture.document);
    const reasons = result.violations.map((violation) => violation.reason);
    if (fixture.valid) {
      assert.deepEqual(result.violations, []);
      assert.deepEqual(
        result.commands.map(({ executable, argv, variant }) => ({ executable, argv, variant })),
        fixture.expectedCommands,
      );
    } else {
      assert.ok(
        reasons.includes(fixture.expectedReason),
        `expected ${fixture.expectedReason}; got ${JSON.stringify(result.violations)}`,
      );
    }
  });
}

test('quote-aware tokenizers preserve one path argument on both hosts', () => {
  assert.deepEqual(
    tokenizePosixCommand('node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js"'),
    ['node', '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js'],
  );
  assert.deepEqual(
    tokenizeWindowsCommand('node "%PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js"'),
    ['node', '%PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js'],
  );
});

test('tokenizers reject unquoted shell operators rather than reinterpreting them', () => {
  assert.throws(
    () => tokenizePosixCommand('node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js" > marker'),
    (error) => error && error.code === 'COMMAND_OPERATOR',
  );
  assert.throws(
    () => tokenizeWindowsCommand('cmd.exe /c node marker.js & echo bad'),
    (error) => error && error.code === 'COMMAND_OPERATOR',
  );
});

test('hook host model expands each native variable form and preserves the Windows command processor boundary', () => {
  const posix = modelHookInvocation(
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js"',
    'command',
    { pluginRoot: '/tmp/Deep Wiki' },
  );
  assert.deepEqual(posix.argv, ['node', '/tmp/Deep Wiki/hooks/scripts/scan-vault-changes.js']);
  assert.equal(posix.outerExecutable, null);

  const windows = modelHookInvocation(
    'node "%PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js"',
    'commandWindows',
    { pluginRoot: 'C:\\Users\\민수\\Deep Wiki', comspec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert.deepEqual(windows.argv, ['node', 'C:\\Users\\민수\\Deep Wiki\\hooks\\scripts\\scan-vault-changes.js']);
  assert.equal(windows.outerExecutable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(windows.outerArgv.slice(0, 3), ['/D', '/S', '/C']);
  assert.equal(windows.outerArgv[3], windows.command);
});

test('shipped command policies reject malformed subcommands and misplaced probes', () => {
  const malformed = '# Procedure\n<!-- deep-wiki:exec -->\n```deep-wiki-exec\n'
    + '{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","delete","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}\n```\n';
  assert.ok(validateSkillCommands(
    'skills/wiki-ingest/SKILL.md', malformed, SKILL_COMMAND_CONTRACTS['wiki-ingest'],
  ).violations.some((item) => item.reason === 'COMMAND_ARGV_NOT_ALLOWED'));

  const probe = '# Procedure\n<!-- deep-wiki:exec -->\n```deep-wiki-exec\n'
    + '{"executable":"obsidian","argv":["vault"],"timeout_ms":3000}\n```\n';
  assert.ok(validateSkillCommands(
    'skills/wiki-query/SKILL.md', probe, SKILL_COMMAND_CONTRACTS['wiki-query'],
  ).violations.some((item) => item.reason === 'OBSIDIAN_PROBE_NOT_ALLOWED'));
});
