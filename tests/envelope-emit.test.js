'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  validate,
  ULID_RE,
  SEMVER_RE,
  RFC3339_RE,
} = require('../scripts/validate-envelope-emit.js');
const {
  generateUlid,
  wrapEnvelope,
  isEnvelope,
  isValidEnvelope,
  unwrapEnvelope,
  loadProducerVersion,
} = require('../hooks/scripts/envelope.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-env-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('envelope.js — generateUlid', () => {
  it('produces a 26-char Crockford Base32 string', () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUlid();
      assert.equal(u.length, 26, `expected 26 chars, got ${u.length}: ${u}`);
      assert.match(u, ULID_RE, `not a valid ULID: ${u}`);
    }
  });

  it('is lex-monotonic across timestamps (MSB-first)', () => {
    const earlier = generateUlid(1700000000000);
    const later = generateUlid(1800000000000);
    assert.ok(earlier < later, `expected ${earlier} < ${later}`);
  });

  it('excludes I/L/O/U from the alphabet (Crockford Base32 spec)', () => {
    for (let i = 0; i < 200; i++) {
      const u = generateUlid();
      assert.ok(!/[ILOU]/.test(u), `forbidden Crockford char in ${u}`);
    }
  });
});

describe('envelope.js — wrapEnvelope identity', () => {
  it('rejects unknown artifactKind', () => {
    assert.throws(
      () => wrapEnvelope({ artifactKind: 'session-receipt', payload: { x: 1 } }),
      /artifactKind must be one of index/,
    );
  });

  it('rejects null payload', () => {
    assert.throws(
      () => wrapEnvelope({ artifactKind: 'index', payload: null }),
      /payload must be a non-null, non-array object/,
    );
  });

  it('rejects array payload (handoff §4 corrupt-payload defense)', () => {
    assert.throws(
      () => wrapEnvelope({ artifactKind: 'index', payload: [{ a: 1 }] }),
      /payload must be a non-null, non-array object/,
    );
  });

  it('rejects string payload', () => {
    assert.throws(
      () => wrapEnvelope({ artifactKind: 'index', payload: 'not an object' }),
      /payload must be a non-null, non-array object/,
    );
  });

  it('emits identity-matched envelope for index', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: {
        pages: [{ file: 'react-hooks.md', title: 'React Hooks', tags: ['frontend'], aliases: [] }],
        generated_at: '2026-05-11T10:00:00Z',
      },
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.equal(env.envelope.producer, 'deep-wiki');
    assert.equal(env.envelope.artifact_kind, 'index');
    assert.equal(env.envelope.schema.name, 'index');
    assert.equal(env.envelope.schema.version, '1.0');
    assert.match(env.envelope.run_id, ULID_RE);
    assert.match(env.envelope.producer_version, SEMVER_RE);
    assert.match(env.envelope.generated_at, RFC3339_RE);
    assert.equal(env.schema_version, '1.0');
    // Multi-source aggregator default: no parent_run_id.
    assert.ok(!('parent_run_id' in env.envelope), 'parent_run_id absent by default');
  });

  it('preserves caller-provided parent_run_id (forward compat for future single-source flow)', () => {
    const parent = generateUlid();
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [], generated_at: '2026-05-11T10:00:00Z' },
      parentRunId: parent,
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.equal(env.envelope.parent_run_id, parent);
  });

  it('rejects non-ULID parentRunId at library boundary (deep-evolve C3 defense-in-depth)', () => {
    assert.throws(
      () => wrapEnvelope({
        artifactKind: 'index',
        payload: { pages: [] },
        parentRunId: 'not-a-ulid',
        git: { head: 'abc1234', branch: 'main', dirty: false },
      }),
      /parentRunId must be 26-char Crockford Base32 ULID/,
    );
  });

  it('omits parent_run_id when parentRunId is empty string', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [] },
      parentRunId: '',
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.ok(!('parent_run_id' in env.envelope), 'empty parentRunId must be ignored');
  });

  it('records source_artifacts path-only (multi-source aggregator contract)', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [] },
      sourceArtifacts: [
        { path: 'pages/react-hooks.md' },
        { path: 'pages/postgres-indexing.md' },
        { path: 'pages/llm-wiki-philosophy.md' },
      ],
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    const sa = env.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 3);
    sa.forEach((s) => {
      assert.ok(!('run_id' in s), `markdown page must not carry run_id: ${s.path}`);
    });
  });

  it('rejects array sourceArtifacts entries (handoff §4 round-3 JS gotcha)', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [] },
      sourceArtifacts: [[{ path: 'nested-array.md' }], { path: 'valid.md' }],
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    const sa = env.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 1);
    assert.equal(sa[0].path, 'valid.md');
  });

  it('uses producer_version from plugin.json', () => {
    const pv = loadProducerVersion();
    assert.match(pv, SEMVER_RE);
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [] },
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.equal(env.envelope.producer_version, pv);
  });

  it('preserves caller-provided session_id', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [] },
      sessionId: 'rebuild-2026-05-11',
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.equal(env.envelope.session_id, 'rebuild-2026-05-11');
  });
});

describe('envelope.js — isEnvelope / isValidEnvelope / unwrapEnvelope', () => {
  it('isEnvelope detects M3 envelope shape', () => {
    assert.equal(isEnvelope({ schema_version: '1.0', envelope: {}, payload: {} }), true);
    assert.equal(isEnvelope({ pages: [], generated_at: '2026-05-11T10:00:00Z' }), false); // legacy
    assert.equal(isEnvelope(null), false);
    assert.equal(isEnvelope([]), false);
    assert.equal(isEnvelope({ schema_version: '2.0', envelope: {}, payload: {} }), false);
    assert.equal(isEnvelope({ schema_version: '1.0', envelope: null, payload: {} }), false);
  });

  it('isValidEnvelope rejects corrupt payloads (handoff §4 W4 lesson)', () => {
    const base = {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki', artifact_kind: 'index', run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
      },
    };
    assert.equal(isValidEnvelope({ ...base, payload: { ok: 1 } }), true);
    assert.equal(isValidEnvelope({ ...base, payload: null }), false);
    assert.equal(isValidEnvelope({ ...base, payload: [1, 2] }), false);
    assert.equal(isValidEnvelope({ ...base, payload: 'string' }), false);
  });

  it('unwrapEnvelope returns input unchanged for legacy index.json', () => {
    const legacy = { pages: [{ file: 'a.md', title: 'A', tags: [], aliases: [] }], generated_at: '2026-05-11T10:00:00Z' };
    assert.deepEqual(unwrapEnvelope(legacy, 'index'), legacy);
  });

  it('unwrapEnvelope returns payload for identity-matched envelope', () => {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [], generated_at: '2026-05-11T10:00:00Z' },
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    const payload = unwrapEnvelope(env, 'index');
    assert.deepEqual(payload, { pages: [], generated_at: '2026-05-11T10:00:00Z' });
  });

  it('unwrapEnvelope rejects foreign producer (round-4 identity guard)', () => {
    const foreign = {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
      },
      payload: { pages: [] },
    };
    assert.equal(unwrapEnvelope(foreign, 'index'), null);
  });

  it('unwrapEnvelope rejects schema.name vs artifact_kind drift', () => {
    const drift = {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'something-else', version: '1.0' },
      },
      payload: { pages: [] },
    };
    assert.equal(unwrapEnvelope(drift, 'index'), null);
  });

  it('unwrapEnvelope rejects corrupt payload (null/array)', () => {
    const corrupt = {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        artifact_kind: 'index',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'index', version: '1.0' },
      },
      payload: null,
    };
    assert.equal(unwrapEnvelope(corrupt, 'index'), null);
    corrupt.payload = [1, 2, 3];
    assert.equal(unwrapEnvelope(corrupt, 'index'), null);
  });

  it('unwrapEnvelope throws on invalid expectedKind (catches typos)', () => {
    assert.throws(
      () => unwrapEnvelope({ schema_version: '1.0', envelope: {}, payload: {} }, 'wiki-index'),
      /expectedKind must be one of index/,
    );
  });
});

describe('validate-envelope-emit.js — fixture is valid', () => {
  it('sample-index.json passes the validator', () => {
    const r = validate(path.join(FIXTURES, 'sample-index.json'));
    assert.deepEqual(r.errors, [], r.errors.join('\n'));
    assert.equal(r.ok, true);
  });
});

describe('validate-envelope-emit.js — schema enforcement', () => {
  function makeValid() {
    const env = wrapEnvelope({
      artifactKind: 'index',
      payload: { pages: [], generated_at: '2026-05-11T10:00:00Z' },
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    return env;
  }

  function validateObj(obj) {
    const p = tmpFile('emit.json', JSON.stringify(obj));
    return validate(p);
  }

  it('flags wrong producer', () => {
    const env = makeValid();
    env.envelope.producer = 'deep-evolve';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /envelope\.producer/.test(e)), r.errors.join('\n'));
  });

  it('flags schema.name vs artifact_kind drift', () => {
    const env = makeValid();
    env.envelope.schema.name = 'something-else';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /schema\.name.*must equal envelope\.artifact_kind/.test(e)), r.errors.join('\n'));
  });

  it('flags non-ULID run_id', () => {
    const env = makeValid();
    env.envelope.run_id = 'not-a-ulid';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /run_id.*ULID/.test(e)));
  });

  it('flags non-RFC3339 generated_at', () => {
    const env = makeValid();
    env.envelope.generated_at = '2026/05/11 10:00';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /generated_at.*RFC 3339/.test(e)));
  });

  it('flags non-SemVer producer_version', () => {
    const env = makeValid();
    env.envelope.producer_version = '01.5.0'; // leading zero rejected
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /producer_version.*SemVer/.test(e)));
  });

  it('flags unknown root keys (additionalProperties:false)', () => {
    const env = makeValid();
    env.unexpected_root = true;
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /root: unknown key "unexpected_root"/.test(e)));
  });

  it('accepts x-* extension at root and envelope', () => {
    const env = makeValid();
    env['x-experimental'] = { foo: 'bar' };
    env.envelope['x-trace-id'] = 'abc';
    const r = validateObj(env);
    assert.deepEqual(r.errors, [], r.errors.join('\n'));
  });

  it('flags unknown envelope keys', () => {
    const env = makeValid();
    env.envelope.unknown_key = 1;
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /envelope: unknown key "unknown_key"/.test(e)));
  });

  it('flags unknown git keys', () => {
    const env = makeValid();
    env.envelope.git.commits_ahead = 5; // not part of suite schema
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /envelope\.git: unknown key "commits_ahead"/.test(e)));
  });

  it('flags non-array source_artifacts', () => {
    const env = makeValid();
    env.envelope.provenance.source_artifacts = { 'pages/a.md': true };
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /source_artifacts.*array/.test(e)));
  });

  it('flags array tool_versions (JS typeof gotcha — round-3 lesson)', () => {
    const env = makeValid();
    env.envelope.provenance.tool_versions = ['v20.11.0']; // array, not object
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /tool_versions.*object \(not array\)/.test(e)));
  });

  it('flags array value inside tool_versions', () => {
    const env = makeValid();
    env.envelope.provenance.tool_versions = { node: ['v20.11.0'] };
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /tool_versions.*node.*string or object.*array/.test(e)));
  });

  it('flags non-hex git.head', () => {
    const env = makeValid();
    env.envelope.git.head = 'NOTHEXCH';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /git\.head/.test(e)));
  });

  it('accepts "unknown" git.dirty (non-git directory case)', () => {
    const env = makeValid();
    env.envelope.git = { head: '0000000', branch: 'HEAD', dirty: 'unknown' };
    const r = validateObj(env);
    assert.deepEqual(r.errors, [], r.errors.join('\n'));
  });

  it('flags arbitrary string for git.dirty', () => {
    const env = makeValid();
    env.envelope.git.dirty = 'yes';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /git\.dirty.*boolean.*unknown/.test(e)));
  });

  it('flags non-object payload (array)', () => {
    const env = makeValid();
    env.payload = [1, 2, 3];
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /payload.*non-null.*non-array object/.test(e)));
  });

  it('flags null payload', () => {
    const env = makeValid();
    env.payload = null;
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /payload.*non-null.*non-array object/.test(e)));
  });

  it('flags missing required envelope fields', () => {
    const env = makeValid();
    delete env.envelope.run_id;
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /envelope: missing required key "run_id"/.test(e)));
  });

  it('flags wrong schema_version', () => {
    const env = makeValid();
    env.schema_version = '2.0';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /schema_version.*1\.0/.test(e)));
  });

  it('flags non-ULID parent_run_id when present', () => {
    const env = makeValid();
    env.envelope.parent_run_id = 'not-a-ulid';
    const r = validateObj(env);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /parent_run_id.*ULID/.test(e)));
  });
});
