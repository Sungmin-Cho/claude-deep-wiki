#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const agentRoot = path.join(root, 'agents');
const expected = new Map([
  ['wiki-page-writer.md', { name: 'wiki-page-writer', tools: [], status: null, sourceContract: false }],
  ['wiki-synthesizer-analysis.md', {
    name: 'wiki-synthesizer-analysis', tools: ['Read', 'Glob', 'Grep', 'WebFetch'], status: null, sourceContract: true,
  }],
  ['wiki-synthesizer-inline.md', {
    name: 'wiki-synthesizer-inline', tools: [], status: 'dormant', sourceContract: true,
  }],
  ['wiki-synthesizer-worker.md', {
    name: 'wiki-synthesizer-worker', tools: ['Read', 'Glob', 'Grep', 'WebFetch'], status: null, sourceContract: true,
  }],
]);

function frontmatter(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (scalar && !values.has(scalar[1])) values.set(scalar[1], scalar[2]);
  }
  return values;
}

function inlineList(value, file) {
  if (!/^\[.*\]$/.test(value || '')) throw new Error(`${file}: tools must be an inline YAML list`);
  const body = value.slice(1, -1).trim();
  return body === '' ? [] : body.split(',').map((item) => item.trim());
}

function equalArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function main() {
  const failures = [];
  const files = fs.readdirSync(agentRoot)
    .filter((file) => file.endsWith('.md'))
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (!equalArray(files, expectedFiles)) {
    failures.push(`agents: expected exactly ${expectedFiles.join(', ')}; found ${files.join(', ')}`);
  }

  for (const [file, contract] of expected) {
    const absolute = path.join(agentRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    try {
      const fields = frontmatter(text, file);
      if (fields.get('name') !== contract.name) failures.push(`${file}: name must match filename`);
      const tools = inlineList(fields.get('tools'), file);
      if (!equalArray(tools, contract.tools)) {
        failures.push(`${file}: tools must be [${contract.tools.join(', ')}]`);
      }
      if (tools.some((tool) => /^(Write|Edit|Bash|shell)$/i.test(tool))) {
        failures.push(`${file}: mutating or shell tool is forbidden`);
      }
      if (contract.status && fields.get('status') !== contract.status) {
        failures.push(`${file}: status must be ${contract.status}`);
      }
      if (contract.sourceContract) {
        if (!/WebFetch URL allowlist/.test(text) || !/sources?(?:\[\])?\.origin/.test(text)) {
          failures.push(`${file}: source-origin prompt contract is missing`);
        }
        if (!/prompt[- ]contract/.test(text)
            || !/not (?:a\s+claim of|as) runtime capability enforcement/is.test(text)) {
          failures.push(`${file}: prompt-contract limitation is missing`);
        }
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  const activeSkills = ['wiki-setup', 'wiki-ingest', 'wiki-query', 'wiki-lint', 'wiki-rebuild']
    .map((name) => fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8'))
    .join('\n');
  if (/deep-wiki:wiki-synthesizer-inline/.test(activeSkills)
      || /dispatch[^\n]*wiki-synthesizer-inline/i.test(activeSkills)) {
    failures.push('active skills must not dispatch wiki-synthesizer-inline');
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
    return 1;
  }
  process.stdout.write('OK: agent files, tools, dormant route, and prompt contracts are valid.\n');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { frontmatter, inlineList, main };
