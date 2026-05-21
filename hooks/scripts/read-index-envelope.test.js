'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');

const env = require('./envelope');

test('read-index-envelope handles large envelopes without stdout truncation', () => {
  const pages = [];
  for (let i = 0; i < 500; i++) {
    pages.push({
      file: `page-${String(i).padStart(4, '0')}.md`,
      title: `Page ${i} — ${'lorem '.repeat(20)}`,
      tags: ['tag-a', 'tag-b', 'tag-c', 'tag-d', 'tag-e'],
      aliases: ['alias-1', 'alias-2', 'alias-3'],
    });
  }
  const envelope = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-wiki',
      producer_version: '1.7.0',
      artifact_kind: 'index',
      run_id: env.generateUlid(),
      generated_at: '2026-05-21T00:00:00Z',
      schema: { name: 'index', version: '1.0' },
      provenance: { source_artifacts: [] },
    },
    payload: { pages, generated_at: '2026-05-21T00:00:00Z' },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-index-test-'));
  const indexPath = path.join(tmp, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(envelope, null, 2));
  try {
    const script = path.resolve(__dirname, 'read-index-envelope.js');
    const result = spawnSync('node', [script, indexPath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `non-zero exit: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.pages.length, 500, 'all 500 pages must round-trip');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
