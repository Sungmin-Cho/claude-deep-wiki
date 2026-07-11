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
      `skills/${fixture.name}/SKILL.md`,
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
    tokenizeWindowsCommand('node "%CLAUDE_PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js"'),
    ['node', '%CLAUDE_PLUGIN_ROOT%\\hooks\\scripts\\scan-vault-changes.js'],
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
