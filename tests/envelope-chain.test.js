'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ULID_RE } = require('../scripts/validate-envelope-emit.js');
const {
  parseSourceArtifactSpec,
  tryReadEnvelopeRunId,
  writeIndexEnvelope,
} = require('../hooks/scripts/wrap-index-envelope.js');
const { readIndexPayload } = require('../hooks/scripts/read-index-envelope.js');
const {
  wrapEnvelope,
  generateUlid,
  isEnvelope,
} = require('../hooks/scripts/envelope.js');

const WRAP_CLI = path.resolve(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'wrap-index-envelope.js',
);
const READ_CLI = path.resolve(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'read-index-envelope.js',
);
const VALIDATE_CLI = path.resolve(
  __dirname,
  '..',
  'scripts',
  'validate-envelope-emit.js',
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw-chain-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function runWrap(args) {
  return execFileSync('node', [WRAP_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runRead(file) {
  return execFileSync('node', [READ_CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runValidate(file) {
  return execFileSync('node', [VALIDATE_CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('envelope-chain — reusable index library', () => {
  it('readIndexPayload returns legacy and valid envelope payloads', () => {
    const dir = tmpDir();
    const legacyFile = path.join(dir, 'legacy.json');
    const envelopedFile = path.join(dir, 'enveloped.json');
    const payload = { pages: [], generated_at: '2026-07-11T00:00:00Z' };
    writeJson(legacyFile, payload);
    writeJson(envelopedFile, wrapEnvelope({
      artifactKind: 'index',
      payload,
      runId: '01JZ7P9Q6MD7S5PB8H4Y40HJ83',
      generatedAt: '2026-07-11T00:00:00Z',
      git: { head: '0000000', branch: 'HEAD', dirty: 'unknown' },
    }));
    assert.deepEqual(readIndexPayload(legacyFile), payload);
    assert.deepEqual(readIndexPayload(envelopedFile), payload);
  });

  it('writeIndexEnvelope atomically replaces index under a Unicode path', () => {
    const dir = tmpDir();
    const output = path.join(dir, '위키 Space', '.wiki-meta', 'index.json');
    const payload = { pages: [], generated_at: '2026-07-11T00:00:00Z' };
    const result = writeIndexEnvelope({
      outputPath: output,
      payload,
      now: new Date('2026-07-11T00:00:00Z'),
      runId: '01JZ7P9Q6MD7S5PB8H4Y40HJ83',
    });
    assert.equal(result.envelope.artifact_kind, 'index');
    assert.deepEqual(readIndexPayload(output), payload);
    assert.deepEqual(fs.readdirSync(path.dirname(output)).sort(), ['index.json']);
  });
});

describe('envelope-chain — index wrapped via wrap-index-envelope.js', () => {
  it('emits a valid envelope and survives the validator', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, {
      pages: [
        { file: 'react-hooks.md', title: 'React Hooks', tags: ['frontend'], aliases: [] },
      ],
      generated_at: '2026-05-11T10:00:00Z',
    });

    runWrap([
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.producer, 'deep-wiki');
    assert.equal(obj.envelope.artifact_kind, 'index');
    assert.equal(obj.envelope.schema.name, 'index');
    assert.match(obj.envelope.run_id, ULID_RE);
    assert.equal(obj.payload.pages.length, 1);
    assert.ok(
      !('parent_run_id' in obj.envelope),
      'CONTRACT (multi-source aggregator): parent_run_id absent by default',
    );
  });

  it('accepts explicit --artifact-kind index (default match)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });

    runWrap([
      '--artifact-kind', 'index',
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.artifact_kind, 'index');
  });

  it('rejects unknown --artifact-kind values', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'wrap.json');
    writeJson(payload, { pages: [] });
    let threw = false;
    try {
      execFileSync('node', [
        WRAP_CLI,
        '--artifact-kind', 'page-catalog',
        '--payload-file', payload,
        '--output', out,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', /--artifact-kind must be one of index/);
    }
    assert.ok(threw, 'CLI must reject unknown artifact-kind');
    assert.ok(!fs.existsSync(out), 'no output file must be written on rejection');
  });
});

describe('envelope-chain — multi-source aggregator (page paths in source_artifacts)', () => {
  it('CONTRACT: records --source-page entries path-only (markdown, no envelope detect)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, {
      pages: [
        { file: 'react-hooks.md', title: 'React Hooks', tags: [], aliases: [] },
        { file: 'postgres-indexing.md', title: 'Postgres Indexing', tags: [], aliases: [] },
      ],
      generated_at: '2026-05-11T10:00:00Z',
    });

    const p1 = 'pages/react-hooks.md';
    const p2 = 'pages/postgres-indexing.md';
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-page', p1,
      '--source-page', p2,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 2);
    assert.deepEqual(
      sa.map((s) => s.path).sort(),
      [p1, p2].sort(),
    );
    // Markdown paths can't be envelope-detected — no run_id (CONTRACT for
    // multi-source aggregator from markdown sources).
    sa.forEach((s) =>
      assert.ok(!('run_id' in s), `unexpected run_id on markdown source: ${s.path}`),
    );
    assert.ok(
      !('parent_run_id' in obj.envelope),
      'CONTRACT: multi-source aggregator must not synthesize parent_run_id',
    );
  });

  it('CONTRACT: parent_run_id absence is a default contract for multi-source aggregator', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });

    // 100 page sources: still no parent_run_id, only path entries.
    const pages = [];
    for (let i = 0; i < 100; i++) {
      pages.push(`pages/page-${i}.md`);
    }
    const args = ['--payload-file', payload, '--output', out];
    pages.forEach((p) => args.push('--source-page', p));
    runWrap(args);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!('parent_run_id' in obj.envelope), 'parent_run_id MUST stay absent');
    assert.equal(obj.envelope.provenance.source_artifacts.length, 100);
  });
});

describe('envelope-chain — explicit --parent-run-id (forward-compat single-source flow)', () => {
  it('honors explicit --parent-run-id when caller opts into chain', () => {
    const dir = tmpDir();
    const explicit = generateUlid();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--parent-run-id', explicit,
    ]);
    runValidate(out);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.parent_run_id, explicit);
  });

  it('CLI rejects non-ULID --parent-run-id at boundary (deep-evolve C3 defense)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [] });
    let threw = false;
    try {
      execFileSync(
        'node',
        [
          WRAP_CLI,
          '--payload-file', payload,
          '--output', out,
          '--parent-run-id', 'not-a-ulid',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2, 'expected exit code 2 (usage error)');
      assert.match(
        err.stderr || '',
        /--parent-run-id must be 26-char Crockford Base32 ULID/,
        'stderr must explain rejection',
      );
    }
    assert.ok(threw, 'CLI must reject non-ULID --parent-run-id');
    assert.ok(!fs.existsSync(out), 'no output file must be written on rejection');
  });
});

describe('envelope-chain — parseSourceArtifactSpec', () => {
  it('parses path-only spec', () => {
    assert.deepEqual(
      parseSourceArtifactSpec('pages/react-hooks.md'),
      { path: 'pages/react-hooks.md' },
    );
  });

  it('parses path:run_id spec when run_id is a valid ULID', () => {
    const ulid = '01JTKGZQ7NABCDEFGHJKMNPQRS';
    assert.deepEqual(
      parseSourceArtifactSpec(`some/path.json:${ulid}`),
      { path: 'some/path.json', run_id: ulid },
    );
  });

  it('treats trailing colon segment that is not a ULID as part of the path', () => {
    assert.deepEqual(
      parseSourceArtifactSpec('https://example.com/x.json:not-a-ulid'),
      { path: 'https://example.com/x.json:not-a-ulid' },
    );
  });

  it('returns null on empty', () => {
    assert.equal(parseSourceArtifactSpec(''), null);
    assert.equal(parseSourceArtifactSpec(null), null);
  });
});

describe('envelope-chain — tryReadEnvelopeRunId identity gate (C2 mirror)', () => {
  const SELF = { selfConsistent: true };
  const STRICT_WIKI = { producer: 'deep-wiki', artifactKind: 'index' };

  it('returns null for envelope with payload: null (W4 corrupt-payload defense)', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: null,
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, STRICT_WIKI), null);
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, SELF), null);
  });

  it('returns null for envelope with payload: array', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: { run_id: '01JTKEV0NHABCDEFGHJKMNPQRS' },
      payload: [1, 2, 3],
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, SELF), null);
  });

  it('returns the run_id for valid envelope under self-consistency mode', () => {
    const dir = tmpDir();
    const valid = path.join(dir, 'valid.json');
    writeJson(valid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });
    assert.strictEqual(
      tryReadEnvelopeRunId(valid, SELF),
      '01JTKEV0NHABCDEFGHJKMNPQRS',
    );
    assert.strictEqual(
      tryReadEnvelopeRunId(valid, STRICT_WIKI),
      '01JTKEV0NHABCDEFGHJKMNPQRS',
    );
  });

  it('rejects foreign-producer envelope under STRICT mode (C2)', () => {
    const dir = tmpDir();
    const foreign = path.join(dir, 'index.json');
    writeJson(foreign, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        artifact_kind: 'index',
        run_id: '01JTKZZZZZZZZZZZZZZZZZZZZZ',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });
    assert.strictEqual(tryReadEnvelopeRunId(foreign, STRICT_WIKI), null);
    // Self-consistency mode passes (envelope itself is internally consistent).
    assert.strictEqual(
      tryReadEnvelopeRunId(foreign, SELF),
      '01JTKZZZZZZZZZZZZZZZZZZZZZ',
    );
  });

  it('rejects schema.name vs artifact_kind drift under self-consistency mode', () => {
    const dir = tmpDir();
    const drift = path.join(dir, 'drift.json');
    writeJson(drift, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'page-catalog', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });
    assert.strictEqual(tryReadEnvelopeRunId(drift, SELF), null);
    assert.strictEqual(tryReadEnvelopeRunId(drift, STRICT_WIKI), null);
  });

  it('rejects non-ULID run_id under both modes', () => {
    const dir = tmpDir();
    const badUlid = path.join(dir, 'bad-ulid.json');
    writeJson(badUlid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: 'not-a-ulid',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });
    assert.strictEqual(tryReadEnvelopeRunId(badUlid, STRICT_WIKI), null);
    assert.strictEqual(tryReadEnvelopeRunId(badUlid, SELF), null);
  });

  it('refuses extraction when no identity gate is provided (regression guard)', () => {
    const dir = tmpDir();
    const valid = path.join(dir, 'valid.json');
    writeJson(valid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });
    // No options at all → null. Forces caller intent.
    assert.strictEqual(tryReadEnvelopeRunId(valid), null);
    // Empty options → null.
    assert.strictEqual(tryReadEnvelopeRunId(valid, {}), null);
  });

  it('returns null for non-existent file', () => {
    assert.strictEqual(tryReadEnvelopeRunId('/non-existent/foo.json', { selfConsistent: true }), null);
  });

  it('returns null for invalid JSON file', () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not valid json');
    assert.strictEqual(tryReadEnvelopeRunId(bad, { selfConsistent: true }), null);
  });
});

describe('envelope-chain — --source-artifact auto-harvest with self-consistency', () => {
  it('auto-harvests envelope run_id from path-only --source-artifact (envelope file)', () => {
    const dir = tmpDir();
    // Simulate an envelope-wrapped artifact at the source path.
    const otherRunId = generateUlid();
    const otherPath = path.join(dir, 'other-artifact.json');
    writeJson(otherPath, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        producer_version: '3.2.0',
        artifact_kind: 'evolve-receipt',
        run_id: otherRunId,
        generated_at: new Date().toISOString(),
        schema: { name: 'evolve-receipt', version: '1.0' },
        git: { head: 'aaa1111', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: { node: process.version } },
      },
      payload: { ok: true },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', otherPath,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    // CONTRACT: generic --source-artifact never sets parent_run_id.
    assert.ok(
      !('parent_run_id' in obj.envelope),
      'generic --source-artifact must not set parent_run_id (multi-source aggregator)',
    );
    const sa = obj.envelope.provenance.source_artifacts;
    const otherSa = sa.find((s) => s.path === otherPath);
    assert.ok(otherSa, 'envelope path must be in source_artifacts');
    assert.equal(
      otherSa.run_id,
      otherRunId,
      'run_id must be auto-harvested via self-consistency check',
    );
  });

  it('CONTRACT: markdown page paths recorded path-only (no envelope detect)', () => {
    const dir = tmpDir();
    const pageA = path.join(dir, 'react-hooks.md');
    fs.writeFileSync(pageA, '---\ntitle: React Hooks\ntags: [frontend]\naliases: []\n---\n\n# React Hooks\n');
    const pageB = path.join(dir, 'postgres-indexing.md');
    fs.writeFileSync(pageB, '---\ntitle: Postgres Indexing\ntags: [database]\naliases: []\n---\n\n# Postgres Indexing\n');

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', pageA,
      '--source-artifact', pageB,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    [pageA, pageB].forEach((p) => {
      const found = sa.find((s) => s.path === p);
      assert.ok(found, `markdown page ${p} must be recorded`);
      assert.ok(!('run_id' in found), `markdown page must not carry run_id: ${p}`);
    });
  });

  it('records path-only when source is foreign envelope without self-consistency (drift)', () => {
    const dir = tmpDir();
    const inconsistent = path.join(dir, 'inconsistent.json');
    writeJson(inconsistent, {
      schema_version: '1.0',
      envelope: {
        producer: 'some-plugin',
        artifact_kind: 'kind-a',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'kind-b', version: '1.0' }, // drift!
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { x: 1 },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', inconsistent,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    const incSa = sa.find((s) => s.path === inconsistent);
    assert.ok(incSa);
    assert.ok(!('run_id' in incSa), 'self-consistency check must reject drift');
  });

  it('respects explicit --source-artifact path:run_id over auto-harvest', () => {
    const dir = tmpDir();
    const explicitUlid = '01JTKR9CD3EFGHJKMNPQRSTVWX';
    const someFile = path.join(dir, 'some-file.json');
    fs.writeFileSync(someFile, '{}');

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', `${someFile}:${explicitUlid}`,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    const found = sa.find((s) => s.path === someFile);
    assert.equal(found.run_id, explicitUlid);
  });
});

describe('envelope-chain — CLI boundary validation (W3 mirror + Q6 repeatable)', () => {
  function expectRejection(args, regex) {
    let threw = false;
    try {
      execFileSync('node', [WRAP_CLI, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', regex);
    }
    assert.ok(threw, 'expected CLI rejection');
  }

  it('rejects empty --session-id', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--session-id=',
      ],
      /--session-id value must be non-empty/,
    );
  });

  it('rejects empty --output', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output=',
      ],
      /--output value must be non-empty/,
    );
  });

  it('rejects empty --payload-file', () => {
    expectRejection(
      [
        '--payload-file=',
        '--output', '/tmp/y.json',
      ],
      /--payload-file value must be non-empty/,
    );
  });

  it('rejects missing required --payload-file', () => {
    expectRejection(
      ['--output', '/tmp/y.json'],
      /missing required flag --payload-file/,
    );
  });

  it('rejects missing required --output', () => {
    expectRejection(
      ['--payload-file', '/tmp/x.json'],
      /missing required flag --output/,
    );
  });

  it('rejects empty --artifact-kind', () => {
    expectRejection(
      [
        '--artifact-kind=',
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
      ],
      /--artifact-kind value must be non-empty/,
    );
  });

  it('rejects empty --source-page (repeatable flag boundary — deep-review Q6 lesson)', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-page=',
      ],
      /--source-page value must be non-empty/,
    );
  });

  it('rejects empty --source-page even alongside valid entries', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-page', 'valid/path.md',
        '--source-page=',
      ],
      /--source-page value must be non-empty/,
    );
  });

  it('rejects empty --source-artifact (repeatable flag boundary)', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-artifact=',
      ],
      /--source-artifact value must be non-empty/,
    );
  });
});

describe('envelope-chain — atomic write (C1 mirror)', () => {
  it('does not leave a .tmp file after successful write', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    runWrap([
      '--payload-file', payload,
      '--output', out,
    ]);
    assert.ok(fs.existsSync(out), 'final output must exist');
    const tmpResidue = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(tmpResidue, [], `tmp residue left behind: ${JSON.stringify(tmpResidue)}`);
  });

  it('creates missing output directory (wiki-meta scaffold)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, '.wiki-meta', 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    runWrap([
      '--payload-file', payload,
      '--output', out,
    ]);
    assert.ok(fs.existsSync(out), 'final output must exist under created dir');
  });
});

describe('envelope-chain — read-index-envelope.js (envelope-aware reader)', () => {
  it('unwraps envelope-wrapped index.json to payload only', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, {
      pages: [
        { file: 'a.md', title: 'A', tags: [], aliases: [] },
      ],
      generated_at: '2026-05-11T10:00:00Z',
    });
    runWrap(['--payload-file', payload, '--output', out]);

    const stdout = runRead(out);
    const unwrapped = JSON.parse(stdout);
    // Reader emits payload-only — consumers see legacy-shaped { pages, generated_at }.
    assert.deepEqual(unwrapped, {
      pages: [{ file: 'a.md', title: 'A', tags: [], aliases: [] }],
      generated_at: '2026-05-11T10:00:00Z',
    });
    assert.ok(!('envelope' in unwrapped), 'envelope must be stripped from reader output');
  });

  it('passes through legacy (non-envelope) index.json unchanged', () => {
    const dir = tmpDir();
    const legacy = path.join(dir, 'index.json');
    const legacyObj = {
      pages: [
        { file: 'old.md', title: 'Old', tags: ['legacy'], aliases: [] },
      ],
      generated_at: '2026-04-06T15:00:00Z',
    };
    writeJson(legacy, legacyObj);

    const stdout = runRead(legacy);
    assert.deepEqual(JSON.parse(stdout), legacyObj);
  });

  it('rejects envelope with foreign producer (identity guard)', () => {
    const dir = tmpDir();
    const foreign = path.join(dir, 'index.json');
    writeJson(foreign, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        producer_version: '3.0.0',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        generated_at: '2026-05-11T10:00:00Z',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { pages: [] },
    });

    let threw = false;
    try {
      runRead(foreign);
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'expected exit code 1 (identity mismatch)');
      assert.match(err.stderr || '', /identity mismatch|envelope-shaped but failed identity/);
    }
    assert.ok(threw, 'reader must reject foreign-producer envelope');
  });

  it('rejects envelope with corrupt payload', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'index.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        producer_version: '1.5.0',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        generated_at: '2026-05-11T10:00:00Z',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: null,
    });

    let threw = false;
    try {
      runRead(corrupt);
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'expected exit code 1 (corrupt payload)');
    }
    assert.ok(threw, 'reader must reject corrupt payload envelope');
  });

  it('rejects envelope MISSING payload key entirely (round-1 P2#1 fix)', () => {
    // Round-1 Codex review P2#1: previously this slipped through legacy
    // pass-through because isEnvelope returned false on absent payload.
    // The fix routes it through unwrapEnvelope's corrupt-payload guard.
    const dir = tmpDir();
    const malformed = path.join(dir, 'index.json');
    writeJson(malformed, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        producer_version: '1.5.0',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        generated_at: '2026-05-11T10:00:00Z',
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      // payload key absent entirely — must NOT fall through legacy
    });

    let threw = false;
    let stderr = '';
    try {
      runRead(malformed);
    } catch (err) {
      threw = true;
      stderr = (err.stderr || '').toString();
      assert.equal(err.status, 1, 'expected exit code 1 (missing payload)');
    }
    assert.ok(threw, 'reader must reject envelope with absent payload key');
    assert.match(stderr, /corrupt payload|envelope-shaped but failed identity/, 'stderr should mention corrupt payload');
  });

  it('exits 2 on missing argument', () => {
    let threw = false;
    try {
      execFileSync('node', [READ_CLI], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', /usage: read-index-envelope\.js/);
    }
    assert.ok(threw, 'reader must reject empty argv');
  });

  it('exits 2 on missing file', () => {
    let threw = false;
    try {
      runRead('/nonexistent/path/index.json');
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
    }
    assert.ok(threw, 'reader must exit 2 on IO error');
  });
});

describe('envelope-chain — round-trip wrap → read', () => {
  it('payload survives wrap+read unchanged', () => {
    const dir = tmpDir();
    const original = {
      pages: [
        { file: 'a.md', title: 'A', tags: ['x'], aliases: ['aa'] },
        { file: 'b.md', title: 'B', tags: [], aliases: [] },
      ],
      generated_at: '2026-05-11T10:00:00Z',
    };
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, original);
    runWrap(['--payload-file', payload, '--output', out]);
    const read = JSON.parse(runRead(out));
    assert.deepEqual(read, original);
  });
});

describe('envelope-chain — markdown bash snippet portability (BSD/GNU find — round-1 C1 fix)', () => {
  // Round-1 Opus C1 / Codex review P2#2 / Codex adversarial #3: the previous
  // markdown snippets used `find ... -printf 'pages/%f\n'` which is GNU-only.
  // On macOS BSD `find`, the `-printf` operator is unknown; under
  // `set -euo pipefail` + `2>/dev/null` + process substitution `< <(...)`,
  // the failure was silently swallowed, leaving SOURCE_PAGE_ARGS empty.
  // The fix is `cd ${WIKI_ROOT} && find pages ... -type f` (portable).
  // This test directly exercises the bash form (not the JS wrapper) so a
  // regression to `-printf` would fail here even though the JS unit tests
  // continue to pass.

  it('portable find expression yields all .md page paths', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'pages'));
    const want = ['alpha.md', 'beta.md', 'gamma.md'];
    want.forEach((f) => fs.writeFileSync(path.join(dir, 'pages', f), `# ${f}\n`));
    // Mirror skills/wiki-rebuild/SKILL.md Step 3.b find form exactly.
    const out = execFileSync('bash', ['-c', `cd "${dir}" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort`], {
      encoding: 'utf8',
    });
    const got = out.trim().split('\n').sort();
    assert.deepEqual(got, want.map((f) => `pages/${f}`).sort());
  });

  it('portable find expression for wiki-lint Step 10 yields basenames', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'a.md'), '# a\n');
    fs.writeFileSync(path.join(dir, 'pages', 'b.md'), '# b\n');
    // Mirror skills/wiki-lint/SKILL.md Step 10 find form exactly.
    const out = execFileSync(
      'bash',
      ['-c', `cd "${dir}/pages" 2>/dev/null && find . -maxdepth 1 -name '*.md' -type f 2>/dev/null | sed 's|^\\./||' | sort`],
      { encoding: 'utf8' },
    );
    const got = out.trim().split('\n').sort();
    assert.deepEqual(got, ['a.md', 'b.md']);
  });

  it('end-to-end: wrap-index-envelope.js invoked with --source-page from portable find produces non-empty source_artifacts', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'pages'));
    ['x.md', 'y.md'].forEach((f) =>
      fs.writeFileSync(path.join(dir, 'pages', f), `---\ntitle: "${f}"\ntags: []\naliases: []\n---\n`),
    );
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, '.wiki-meta', 'index.json');
    writeJson(payload, {
      pages: [
        { file: 'x.md', title: 'x.md', tags: [], aliases: [] },
        { file: 'y.md', title: 'y.md', tags: [], aliases: [] },
      ],
      generated_at: '2026-05-11T10:00:00Z',
    });
    // Reproduce the wiki-rebuild Step 3.b loop end-to-end.
    const bashScript = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      SOURCE_PAGE_ARGS=()
      while IFS= read -r REL; do
        [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
      done < <(cd "$WIKI_ROOT" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)
      node "${WRAP_CLI}" --payload-file "${payload}" --output "${out}" "\${SOURCE_PAGE_ARGS[@]}"
    `;
    execFileSync('bash', ['-c', bashScript], { encoding: 'utf8' });

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 2, 'multi-source aggregator contract: page paths must populate source_artifacts');
    assert.deepEqual(sa.map((s) => s.path).sort(), ['pages/x.md', 'pages/y.md']);
    sa.forEach((s) => assert.ok(!('run_id' in s), 'markdown page paths must not carry run_id'));
  });
});

describe('envelope-chain — index payload shape gate (round-2 Codex adv HIGH-B PARTIAL ACCEPT)', () => {
  // Defense-in-depth at the writer boundary for the `index` artifact kind:
  // require `pages` to be an array before wrapping. Authoritative payload
  // schema replacement lives in Phase 3 (claude-deep-suite payload-registry).
  it('rejects payload missing pages array', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { generated_at: '2026-05-11T10:00:00Z' }); // no `pages`
    let threw = false;
    try {
      runWrap(['--payload-file', payload, '--output', out]);
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', /does not match deep-wiki\/index domain shape.*pages/);
    }
    assert.ok(threw, 'writer must reject payload without pages array');
    assert.ok(!fs.existsSync(out), 'no output file written on rejection');
  });

  it('rejects payload with pages as non-array', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: 'not-an-array', generated_at: '2026-05-11T10:00:00Z' });
    let threw = false;
    try {
      runWrap(['--payload-file', payload, '--output', out]);
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', /does not match.*pages.*string/);
    }
    assert.ok(threw);
    assert.ok(!fs.existsSync(out));
  });

  it('accepts payload with empty pages array (new wiki scenario)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    runWrap(['--payload-file', payload, '--output', out]);
    assert.ok(fs.existsSync(out), 'empty pages array is valid (fresh wiki / /wiki-setup case)');
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(obj.payload.pages, []);
  });
});

describe('envelope-chain — bash 3.2 empty-array safety (round-2 Opus W2-2 fix)', () => {
  // Round-2 Opus W2-2: empty pages directory caused `"${SOURCE_PAGE_ARGS[@]}"`
  // expansion to abort under bash 3.2 + set -u, leaving wiki-query stuck-locked.
  // Fix: use `${ARR[@]+"${ARR[@]}"}` expansion (POSIX-compatible empty-array
  // fallback). This test verifies the actual bash snippet form from the
  // markdown commands.
  it('SOURCE_PAGE_ARGS expansion under set -u with empty array does not abort', () => {
    const script = `
      set -euo pipefail
      SOURCE_PAGE_ARGS=()
      echo "BEFORE_EXPAND"
      echo "ARGS=" \${SOURCE_PAGE_ARGS[@]+"\${SOURCE_PAGE_ARGS[@]}"}
      echo "AFTER_EXPAND"
    `;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.match(out, /BEFORE_EXPAND/);
    assert.match(out, /AFTER_EXPAND/, 'script must reach AFTER_EXPAND (not abort on empty array)');
  });

  it('SOURCE_PAGE_ARGS expansion under set -u with two entries passes args', () => {
    // Use single-quoted heredoc-style to avoid JS template-string escape collisions.
    const script = [
      'set -euo pipefail',
      'SOURCE_PAGE_ARGS=(--source-page "pages/a.md" --source-page "pages/b.md")',
      'for arg in "${SOURCE_PAGE_ARGS[@]+"${SOURCE_PAGE_ARGS[@]}"}"; do echo "$arg"; done',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    assert.deepEqual(lines, ['--source-page', 'pages/a.md', '--source-page', 'pages/b.md']);
  });

  it('end-to-end: empty wiki pages/ does not crash wrap helper invocation', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'pages'));
    // empty pages/ — no .md files
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, '.wiki-meta', 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    const bashScript = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      SOURCE_PAGE_ARGS=()
      while IFS= read -r REL; do
        [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
      done < <(cd "$WIKI_ROOT" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)
      node "${WRAP_CLI}" --payload-file "${payload}" --output "${out}" \${SOURCE_PAGE_ARGS[@]+"\${SOURCE_PAGE_ARGS[@]}"}
    `;
    execFileSync('bash', ['-c', bashScript], { encoding: 'utf8' });
    assert.ok(fs.existsSync(out), 'wrap succeeds with empty pages/');
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(obj.envelope.provenance.source_artifacts, []);
  });
});

describe('envelope-chain — lock lifetime semantics (round-3 Codex 2-way fix)', () => {
  // Round-3 Codex review #1 + Codex adv #1: wiki-query Step 5d trap was
  // releasing the lock on EVERY exit including success, which freed the
  // lock before the log.jsonl append step. The R3 fix releases the lock
  // ONLY on failure; success path keeps the lock for Step 5e to release
  // after log append.
  //
  // These tests mirror the cleanup() function shape from wiki-query.md
  // Step 5d to verify the lock-lifetime invariant.

  it('cleanup keeps lock on success path (rc=0)', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      PAYLOAD_TMP="\${WIKI_ROOT}/.wiki-meta/payload.tmp.test"
      touch "\$PAYLOAD_TMP"
      cleanup() {
        local rc=\$?
        rm -f "\$PAYLOAD_TMP" 2>/dev/null || true
        if [ "\$rc" -ne 0 ]; then
          rmdir "\${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
        fi
        return \$rc
      }
      trap cleanup EXIT
      # Normal success — no failure command, snippet ends successfully.
      echo "OK"
    `;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.match(out, /OK/);
    // Lock MUST still be held after success exit (Step 5e will release it).
    assert.ok(
      fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'lock must be retained on success path (Step 5e responsibility)',
    );
    // Payload tmp file removed.
    assert.ok(!fs.existsSync(path.join(dir, '.wiki-meta', 'payload.tmp.test')));
  });

  it('cleanup releases lock on failure path (rc!=0)', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      PAYLOAD_TMP="\${WIKI_ROOT}/.wiki-meta/payload.tmp.test"
      touch "\$PAYLOAD_TMP"
      cleanup() {
        local rc=\$?
        rm -f "\$PAYLOAD_TMP" 2>/dev/null || true
        if [ "\$rc" -ne 0 ]; then
          rmdir "\${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
          echo "ERROR rc=\$rc" >&2
        fi
        return \$rc
      }
      trap cleanup EXIT
      # Simulate failure (false → set -e → exit 1)
      false
    `;
    let exitCode = 0;
    try {
      execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 1, 'failure path must exit non-zero');
    // Lock MUST be released on failure (defensive cleanup).
    assert.ok(
      !fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'lock must be released on failure path',
    );
  });

  it('wiki-rebuild Step 1 cleanup_lock trap releases lock on helper failure', () => {
    // Round-3 Codex adv #2: wiki-rebuild was missing a cleanup trap. The
    // R3 fix adds `cleanup_lock` trap after `mkdir LOCK_DIR` so envelope
    // helper failure releases the lock. Mirror the wiki-rebuild.md Step 1
    // shape.
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta'), { recursive: true });
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      LOCK_DIR="\${WIKI_ROOT}/.wiki-meta/.wiki-lock"
      mkdir "\$LOCK_DIR" 2>/dev/null
      cleanup_lock() {
        rmdir "\$LOCK_DIR" 2>/dev/null || true
      }
      trap cleanup_lock EXIT
      # Simulate envelope helper failure
      false
    `;
    let exitCode = 0;
    try {
      execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 1);
    // Lock MUST be released — trap fires on EXIT for failure path.
    assert.ok(
      !fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'wiki-rebuild lock cleanup trap must release on failure',
    );
  });

  it('wiki-rebuild single-block payload + wrap (round-3 Codex review #2 fix)', () => {
    // Round-3 Codex review #2: payload construction and envelope wrap MUST
    // happen in a single Bash tool invocation so PAYLOAD_TMP survives.
    // Mirror the combined Step 3 from wiki-rebuild.md.
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'a.md'), `# A\n`);
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      # Single block: payload + wrap. Verifies PAYLOAD_TMP is local-only
      # and reaches the helper invocation in the same shell.
      PAYLOAD_TMP="\${WIKI_ROOT}/.wiki-meta/index.payload.tmp.\$\$.test.json"
      cat > "\$PAYLOAD_TMP" <<JSON
      {"pages": [{"file": "a.md", "title": "A", "tags": [], "aliases": []}], "generated_at": "2026-05-11T10:00:00Z"}
JSON
      SOURCE_PAGE_ARGS=()
      while IFS= read -r REL; do
        [ -n "\$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "\$REL")
      done < <(cd "\$WIKI_ROOT" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)
      node "${WRAP_CLI}" --payload-file "\$PAYLOAD_TMP" --output "\${WIKI_ROOT}/.wiki-meta/index.json" \${SOURCE_PAGE_ARGS[@]+"\${SOURCE_PAGE_ARGS[@]}"}
      rm -f "\$PAYLOAD_TMP"
    `;
    execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(dir, '.wiki-meta', 'index.json')));
    const obj = JSON.parse(fs.readFileSync(path.join(dir, '.wiki-meta', 'index.json'), 'utf8'));
    assert.equal(obj.envelope.producer, 'deep-wiki');
    assert.equal(obj.payload.pages.length, 1);
    assert.equal(obj.envelope.provenance.source_artifacts.length, 1);
    // Verify PAYLOAD_TMP was cleaned up
    const tmpResidue = fs.readdirSync(path.join(dir, '.wiki-meta')).filter((f) => f.includes('payload.tmp'));
    assert.deepEqual(tmpResidue, [], 'PAYLOAD_TMP must be cleaned after success');
  });
});

describe('envelope-chain — git context derived from output path (round-4 Codex 2-way fix)', () => {
  // Round-4 Codex review #2 + Codex adv #2 (2-way): wrap-index-envelope.js
  // previously let wrapEnvelope() default to detectGit(process.cwd()),
  // recording whatever repo the agent happened to be in. The R4 fix
  // derives the git context from the --output path (wiki_root, two levels
  // above index.json) so envelope.git describes the wiki's revision
  // state, not the caller's unrelated repo.

  it('records wiki_root git state, NOT process.cwd state', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages'));
    // Run the CLI from /tmp (a non-git dir) with --output pointing into
    // a non-git wiki dir. The previous behavior would detect the
    // /tmp cwd's git context (or 0000000 sentinel if /tmp isn't git);
    // the fix should always use wiki_root's git context (sentinel here).
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, '.wiki-meta', 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    execFileSync('node', [WRAP_CLI, '--payload-file', payload, '--output', out], {
      encoding: 'utf8',
      cwd: os.tmpdir(), // Run from somewhere unrelated to wiki + plugin
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    // Non-git wiki_root → sentinel 0000000 head, dirty=unknown.
    assert.equal(obj.envelope.git.head, '0000000', 'non-git wiki must emit sentinel head');
    assert.equal(obj.envelope.git.dirty, 'unknown');
    assert.equal(obj.envelope.git.branch, 'HEAD');
  });

  it('uses wiki_root git context when wiki_root IS a git repo', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages'));
    // Initialize wiki_root as a git repo.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
    const wikiHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, '.wiki-meta', 'index.json');
    writeJson(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
    execFileSync('node', [WRAP_CLI, '--payload-file', payload, '--output', out], {
      encoding: 'utf8',
      cwd: os.tmpdir(), // Run from /tmp; must NOT pick /tmp's git context (if any).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.git.head, wikiHead, 'envelope.git.head must come from wiki_root, not cwd');
  });
});

describe('envelope-chain — wiki-rebuild Step 1 + Step 3 trap pattern (round-4 Codex review #1 fix)', () => {
  // Round-4 Codex review #1: R3-2 put `trap cleanup_lock EXIT` in Step 1
  // (a standalone bash block). On the Claude Code Bash tool, that block
  // exits as soon as Step 1 finishes — releasing the lock BEFORE Steps
  // 2-5 run. The R4 fix removes the trap from Step 1 and adds a
  // failure-only cleanup trap inside Step 3 (the mutation block).
  //
  // These tests verify the new pattern at the bash level.

  it('Step 1 alone (no trap) keeps the lock for subsequent invocations', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta'), { recursive: true });
    const step1 = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      LOCK_DIR="\${WIKI_ROOT}/.wiki-meta/.wiki-lock"
      mkdir "\$LOCK_DIR"
      # No trap here — must persist after this bash block exits.
    `;
    execFileSync('bash', ['-c', step1], { encoding: 'utf8' });
    assert.ok(
      fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'lock must persist after Step 1 block exit',
    );
  });

  it('Step 3 failure trap releases lock on helper-failure', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      PAYLOAD_TMP="\${WIKI_ROOT}/.wiki-meta/payload.tmp.fail-test"
      cleanup_step3() {
        local rc=\$?
        if [ "\$rc" -ne 0 ]; then
          rmdir "\${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
        fi
        return \$rc
      }
      trap cleanup_step3 EXIT
      touch "\$PAYLOAD_TMP"
      # Simulate envelope-wrap failure
      false
    `;
    let rc = 0;
    try {
      execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      rc = err.status;
    }
    assert.equal(rc, 1, 'failure path must exit non-zero');
    assert.ok(
      !fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'lock must be released by Step 3 cleanup on failure',
    );
    // Payload temp preserved for retry.
    assert.ok(
      fs.existsSync(path.join(dir, '.wiki-meta', 'payload.tmp.fail-test')),
      'payload temp must survive Step 3 failure for retry',
    );
  });

  it('Step 3 success trap keeps lock for Step 6', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const script = `
      set -euo pipefail
      WIKI_ROOT="${dir}"
      cleanup_step3() {
        local rc=\$?
        if [ "\$rc" -ne 0 ]; then
          rmdir "\${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
        fi
        return \$rc
      }
      trap cleanup_step3 EXIT
      # Simulate successful wrap
      echo "ok"
    `;
    execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.ok(
      fs.existsSync(path.join(dir, '.wiki-meta', '.wiki-lock')),
      'lock must persist after successful Step 3 (Step 6 will release)',
    );
  });
});

describe('envelope-chain — wrapEnvelope intra-plugin chain via lib', () => {
  it('builds index envelope with multiple source pages (multi-source aggregator)', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: {
        pages: [{ file: 'a.md', title: 'A', tags: [], aliases: [] }],
        generated_at: '2026-05-11T10:00:00Z',
      },
      sourceArtifacts: [
        { path: 'pages/a.md' },
        { path: 'pages/b.md' },
        { path: 'pages/c.md' },
      ],
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.ok(!('parent_run_id' in env.envelope), 'multi-source: no parent_run_id by default');
    const sa = env.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 3);
    sa.forEach((s) => assert.ok(!('run_id' in s), 'markdown sources have no run_id'));
  });
});
