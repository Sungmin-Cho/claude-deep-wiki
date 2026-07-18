'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateSkillCommands,
  SKILL_COMMAND_CONTRACTS,
} = require('../scripts/lib/executable-contract.js');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match);
  return match[1];
}

function dataObjects(text) {
  return [...text.matchAll(/<!-- deep-wiki:data -->\s*```json\s*([\s\S]*?)\s*```/g)]
    .map((match) => JSON.parse(match[1]));
}

function executeCodexRoute(policy, plans) {
  assert.equal(policy.mode, 'main-caller-sequential');
  assert.equal(policy.child_agents, false);
  assert.equal(policy.input_order, 'stable');
  const trace = [];
  for (const plan of plans) {
    for (const phase of policy.per_plan_phases) trace.push(`${phase}:${plan}`);
  }
  return trace;
}

test('Claude uses only qualified active Deep Wiki agents and inline remains dormant', () => {
  const ingest = read('skills/wiki-ingest/SKILL.md');
  for (const role of ['wiki-synthesizer-analysis', 'wiki-synthesizer-worker', 'wiki-page-writer']) {
    assert.match(ingest, new RegExp(`deep-wiki:${role}`));
  }
  assert.doesNotMatch(ingest, /dispatch[^\n]*wiki-synthesizer-inline/i);
  assert.match(ingest, /named-agent resolution error[^\n]*fail/i);
  assert.match(frontmatter(read('agents/wiki-synthesizer-inline.md')), /status:\s*dormant/);
});

test('Codex route is unconditional single-caller sequential processing with exact trace', () => {
  const ingest = read('skills/wiki-ingest/SKILL.md');
  const policy = dataObjects(ingest).find((value) => value.codex_route)?.codex_route;
  assert.ok(policy);
  assert.match(ingest, /codex_agent_fanout:\s*disabled_for_1\.8\.0/);
  assert.equal(executeCodexRoute(policy, ['p1', 'p2', 'p3']).join(','),
    'analyze:p1,write:p1,validate:p1,analyze:p2,write:p2,validate:p2,analyze:p3,write:p3,validate:p3');
  assert.match(ingest, /main caller/i);
  assert.match(ingest, /stable input order/i);
  for (const forbidden of [
    'codex-agent-preflight.js', 'codex-deny-tool.js', 'CAPABILITY_UNAVAILABLE',
    'codex exec', 'Promise.all', 'temporary agent', 'generic subagent',
  ]) assert.doesNotMatch(ingest, new RegExp(forbidden.replace('.', '\\.'), 'i'));

  const codexSection = ingest.slice(ingest.indexOf('For Codex'), ingest.indexOf('## 3.'));
  for (const forbidden of [
    /\bparallel\b/i, /subagent_type/i, /general-purpose/i, /spawn_agent/i,
    /Task\s*\(/, /dispatch[^\n]*(?:agent|worker)/i, /invoke[^\n]*(?:agent|worker)/i,
  ]) assert.doesNotMatch(codexSection, forbidden);
});

test('all five skills expose one exact deterministic route to both hosts', () => {
  const matrix = {};
  for (const [skill, contract] of Object.entries(SKILL_COMMAND_CONTRACTS)) {
    const relative = `skills/${skill}/SKILL.md`;
    const text = read(relative);
    assert.match(frontmatter(text), /runtime_hosts:\s*\[claude, codex\]/);
    const result = validateSkillCommands(relative, text, contract);
    assert.deepEqual(result.violations, [], relative);
    const route = result.commands.map((command) => ({
      executable: command.executable,
      argv: command.argv,
      timeout_ms: command.timeout_ms,
    }));
    matrix[skill] = { claude: route, codex: structuredClone(route) };
  }
  for (const routes of Object.values(matrix)) assert.deepEqual(routes.claude, routes.codex);
});

test('active agent frontmatter preserves exact tools and excludes mutation tools', () => {
  const expected = {
    'wiki-synthesizer-analysis': '[Read, Glob, Grep, WebFetch]',
    'wiki-synthesizer-worker': '[Read, Glob, Grep, WebFetch]',
    'wiki-page-writer': '[]',
  };
  for (const [name, tools] of Object.entries(expected)) {
    const fm = frontmatter(read(`agents/${name}.md`));
    assert.match(fm, new RegExp(`name:\\s*${name}`));
    assert.match(fm, new RegExp(`tools:\\s*${tools.replace(/[\[\]]/g, '\\$&')}`));
    assert.doesNotMatch(fm, /tools:[^\n]*(?:Write|Edit|Bash|shell)/i);
  }
});

test('page writer preserves the established wrapped input and terminal output shapes', () => {
  const objects = dataObjects(read('agents/wiki-page-writer.md'));
  const input = objects.find((value) => Object.hasOwn(value, 'wiki_root'));
  assert.ok(input);
  assert.deepEqual(Object.keys(input).sort(), ['page_plan_entry', 'wiki_root']);
  assert.deepEqual(Object.keys(input.page_plan_entry).sort(), [
    'action', 'existing_body_hash', 'existing_page_body', 'file',
    'frontmatter_meta', 'intent_summary', 'merge_against', 'novel_facts',
    'preserve_sections', 'source_excerpts',
  ]);
  const outputs = objects.filter((value) => Object.hasOwn(value, 'worker_status'));
  assert.deepEqual(outputs.map((value) => value.worker_status), ['ok', 'failed']);
  for (const output of outputs) assert.deepEqual(Object.keys(output).sort(), [
    'fail_reason', 'file', 'frontmatter_meta', 'page_content', 'worker_status',
  ]);
  assert.equal(outputs[0].fail_reason, null);
  assert.equal(outputs[1].page_content, null);
  assert.equal(outputs[1].frontmatter_meta, null);
});
