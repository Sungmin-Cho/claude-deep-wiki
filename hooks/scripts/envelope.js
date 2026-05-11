'use strict';

/**
 * envelope.js — Shared utilities for the M3 cross-plugin envelope
 * (cf. claude-deep-suite/docs/envelope-migration.md §1).
 *
 * Zero-dep, CommonJS, runs from any cwd. All paths that reference plugin
 * assets (e.g. plugin.json) resolve relative to this module's __dirname,
 * NOT the caller's process.cwd() — see m3-phase2-handoff §4 "literal-cwd-resolve"
 * (deep-docs round-1 lesson). LLM-driven contexts may invoke this helper from
 * arbitrary working directories (user vault, wiki root, etc.).
 *
 * Exports:
 *   generateUlid(now?)              MSB-first Crockford Base32 26-char ULID
 *   detectGit(cwd?)                 git head/branch/dirty trio with safe fallback
 *   loadProducerVersion()           reads .claude-plugin/plugin.json relative to module
 *   wrapEnvelope(opts)              builds an envelope object (does not write)
 *   unwrapEnvelope(obj, kind)       returns payload (or input as-is for legacy);
 *                                   null if envelope-shaped but identity mismatches.
 *   isEnvelope(obj)                 boolean — loose M3 envelope shape detector
 *   isValidEnvelope(obj)            boolean — strict (also requires payload object)
 *
 * Identity contract: producer === 'deep-wiki', artifact_kind === 'index',
 * schema.name === artifact_kind. unwrapEnvelope() enforces all three (handoff §4
 * round-4 "envelope identity guards"). deep-wiki currently emits a single
 * artifact kind; ALLOWED_ARTIFACT_KINDS is parameterised for future expansion.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const PLUGIN_NAME = 'deep-wiki';
const ALLOWED_ARTIFACT_KINDS = Object.freeze(new Set(['index']));

// Crockford's Base32 alphabet (per ULID spec) — excludes I/L/O/U.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function generateUlid(now) {
  if (now === undefined) now = Date.now();
  // 48-bit timestamp ms (10 base32 chars) MSB-first + 80-bit randomness (16 base32 chars).
  let ts = now;
  const tsChars = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = CROCKFORD[ts % 32];
    ts = Math.floor(ts / 32);
  }
  const r = randomBytes(10);
  let rb = 0n;
  for (const b of r) rb = (rb << 8n) | BigInt(b);
  const randChars = new Array(16);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(rb & 31n)];
    rb >>= 5n;
  }
  return tsChars.join('') + randChars.join('');
}

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_err) {
    return null;
  }
}

function detectGit(cwd) {
  const repoCwd = cwd || process.cwd();
  const head = safeGit(['rev-parse', 'HEAD'], repoCwd);
  if (!head) {
    // Non-git directory or shallow CI clone failure. Wiki roots commonly live
    // in user-managed vaults that may not be git repos (Obsidian vault, plain
    // markdown folder). Emit envelope-schema-valid sentinel distinguishable
    // from a real SHA (7-zero hex + dirty:'unknown'); dashboard / chain
    // reconstruction can recognise this as 'producer git context unavailable'.
    return { head: '0000000', branch: 'HEAD', dirty: 'unknown' };
  }
  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoCwd);
  const status = safeGit(['status', '--porcelain'], repoCwd);
  return {
    head,
    branch: branch && branch !== 'HEAD' ? branch : 'HEAD',
    dirty: status == null ? 'unknown' : status.length > 0,
  };
}

function loadProducerVersion() {
  // Resolve relative to this module file, NOT the caller's cwd. Wiki commands
  // run from the user's wiki_root (arbitrary path), so cwd-relative reads
  // would fail or read unrelated files (handoff §4 literal-cwd-resolve lesson,
  // deep-docs round-1).
  const pluginJsonPath = path.resolve(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
  const raw = fs.readFileSync(pluginJsonPath, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj.version !== 'string' || obj.version.length === 0) {
    throw new Error(`plugin.json missing string "version" at ${pluginJsonPath}`);
  }
  return obj.version;
}

/**
 * Build an envelope object (does not write).
 *
 * opts:
 *   artifactKind     'index' (required, future: additional kinds)
 *   payload          plain object (required, non-null, non-array)
 *   parentRunId      optional ULID — deep-wiki is a multi-source aggregator so
 *                    parent_run_id is normally omitted; supported here for
 *                    forward compatibility (e.g. future single-source emit
 *                    derived from an envelope-wrapped artifact import).
 *   sessionId        optional higher-level session marker
 *   sourceArtifacts  optional array of { path, run_id? } — page filesystem
 *                    paths recorded path-only (markdown, no envelope detect).
 *   toolVersions     optional object — defaults to { node: process.version }
 *   schemaVersion    optional payload schema MAJOR.MINOR — defaults to '1.0'
 *   git              optional override (otherwise detectGit())
 *   runId            optional ULID override (otherwise generateUlid())
 *   producerVersion  optional override (otherwise loadProducerVersion())
 *   generatedAt      optional RFC 3339 timestamp (otherwise new Date().toISOString())
 */
function wrapEnvelope(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('wrapEnvelope: opts must be an object');
  }
  const artifactKind = opts.artifactKind;
  if (!ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    throw new Error(
      `wrapEnvelope: artifactKind must be one of ${[...ALLOWED_ARTIFACT_KINDS].join(', ')}, got ${JSON.stringify(artifactKind)}`,
    );
  }
  if (
    opts.payload === null ||
    typeof opts.payload !== 'object' ||
    Array.isArray(opts.payload)
  ) {
    throw new Error('wrapEnvelope: payload must be a non-null, non-array object');
  }

  const runId = opts.runId || generateUlid();
  if (!ULID_RE.test(runId)) {
    throw new Error(`wrapEnvelope: runId must be 26-char Crockford Base32 ULID, got ${JSON.stringify(runId)}`);
  }
  const producerVersion = opts.producerVersion || loadProducerVersion();
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const git = opts.git || detectGit();
  const schemaVersion = opts.schemaVersion || '1.0';

  // Array.isArray() guard at container + per-value (handoff §4 round-3 JS gotcha).
  const sourceArtifacts = Array.isArray(opts.sourceArtifacts)
    ? opts.sourceArtifacts
        .filter((sa) => sa && typeof sa === 'object' && !Array.isArray(sa))
        .map((sa) => {
          const item = { path: String(sa.path || '') };
          if (typeof sa.run_id === 'string' && sa.run_id.length > 0) {
            item.run_id = sa.run_id;
          }
          return item;
        })
        .filter((sa) => sa.path.length > 0)
    : [];

  const toolVersions =
    opts.toolVersions && typeof opts.toolVersions === 'object' && !Array.isArray(opts.toolVersions)
      ? opts.toolVersions
      : { node: process.version };

  const envelope = {
    producer: PLUGIN_NAME,
    producer_version: producerVersion,
    artifact_kind: artifactKind,
    run_id: runId,
    generated_at: generatedAt,
    schema: { name: artifactKind, version: schemaVersion },
    git: {
      head: git.head,
      branch: git.branch,
      dirty: git.dirty,
    },
    provenance: {
      source_artifacts: sourceArtifacts,
      tool_versions: toolVersions,
    },
  };
  if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
    envelope.session_id = opts.sessionId;
  }
  if (typeof opts.parentRunId === 'string' && opts.parentRunId.length > 0) {
    // deep-evolve round-1 C3 (defense-in-depth lesson, mirrored): wrapEnvelope
    // must reject non-ULID parentRunId at the boundary, not defer to downstream
    // validation. Even though deep-wiki is a multi-source aggregator with
    // parent_run_id normally omitted, the helper supports future single-source
    // flows so the validation is wired up symmetrically.
    if (!ULID_RE.test(opts.parentRunId)) {
      throw new Error(
        `wrapEnvelope: parentRunId must be 26-char Crockford Base32 ULID, got ${JSON.stringify(opts.parentRunId)}`,
      );
    }
    envelope.parent_run_id = opts.parentRunId;
  }

  return {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope,
    payload: opts.payload,
  };
}

/**
 * M3 envelope shape detector (loose).
 *
 * Returns true for {schema_version: "1.0", envelope: {...}} — structural
 * detection only. Payload key MAY be absent (the corrupt-payload guard in
 * `unwrapEnvelope()` rejects undefined/null/array/non-object payloads). This
 * is the deliberate fix for Codex review round-1 P2#1: a malformed envelope
 * missing `payload` must be detected as envelope-shaped so that downstream
 * reader path can reject it on identity-or-payload grounds, instead of
 * silently falling through the legacy pass-through and feeding the corrupt
 * top-level object to consumers (whose `.pages // []` would yield an empty
 * catalog and trigger a silent rebuild from zero).
 *
 * Use `unwrapEnvelope()` for full identity + corrupt-payload checks, or use
 * the stricter `isValidEnvelope()` when consumers also need payload to be a
 * non-null/non-array object.
 *
 * Defends against legacy index.json files whose top-level numeric
 * `schema_version` (none currently; reserved) or absent envelope key collide
 * with envelope's `schema_version: "1.0"`.
 */
function isEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.schema_version !== '1.0') return false;
  if (!obj.envelope || typeof obj.envelope !== 'object' || Array.isArray(obj.envelope)) return false;
  // Payload key may be absent — unwrapEnvelope's corrupt-payload guard rejects it.
  // Round-1 P2#1 lesson: requiring payload here would route corrupt envelopes
  // through the legacy pass-through and feed consumers garbage.
  return true;
}

/**
 * Strict M3 envelope detector — adds the payload-shape gate on top of
 * `isEnvelope`. Returns true only when payload is itself a non-null,
 * non-array object (deep-work round-1 W4 lesson). Use this when extracting
 * sub-fields like `envelope.run_id` from a chain-source artifact, where a
 * corrupt envelope must not contribute trace data downstream.
 */
function isValidEnvelope(obj) {
  if (!isEnvelope(obj)) return false;
  return obj.payload !== null && typeof obj.payload === 'object' && !Array.isArray(obj.payload);
}

/**
 * Unwrap envelope and verify identity. Four outcomes:
 *
 *   - Legacy (non-envelope) input → returns input unchanged. Caller must handle
 *     the legacy shape (pre-1.5.0 index.json: { pages: [...], generated_at }).
 *   - Envelope with identity match → returns payload (object).
 *   - Envelope with identity mismatch → returns null + stderr warning.
 *   - Envelope with corrupt payload (null/array/non-object) → returns null + warn.
 *
 * Identity is checked on producer === 'deep-wiki', artifact_kind === expectedKind,
 * schema.name === expectedKind. handoff §4 round-4 lesson.
 */
function unwrapEnvelope(obj, expectedKind) {
  if (!isEnvelope(obj)) return obj;
  if (!ALLOWED_ARTIFACT_KINDS.has(expectedKind)) {
    throw new Error(
      `unwrapEnvelope: expectedKind must be one of ${[...ALLOWED_ARTIFACT_KINDS].join(', ')}, got ${JSON.stringify(expectedKind)}`,
    );
  }
  const env = obj.envelope;
  const id = {
    producer: env && env.producer,
    artifact_kind: env && env.artifact_kind,
    schema_name: env && env.schema && env.schema.name,
  };
  if (
    id.producer !== PLUGIN_NAME ||
    id.artifact_kind !== expectedKind ||
    id.schema_name !== expectedKind
  ) {
    process.stderr.write(
      `[deep-wiki/envelope] identity mismatch: expected producer=${PLUGIN_NAME} kind=${expectedKind}, got ${JSON.stringify(id)}\n`,
    );
    return null;
  }
  const payload = obj.payload;
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    // Round-5/7 lesson: corrupt-payload defense — non-object payload must not
    // pass through silently. Round-1 P2#1 extension: `undefined` (key absent)
    // is treated the same as `null` so envelopes missing the payload field
    // are rejected here rather than misclassified as legacy upstream.
    process.stderr.write(
      `[deep-wiki/envelope] corrupt payload: expected object, got ${
        payload === undefined ? 'undefined' : Array.isArray(payload) ? 'array' : typeof payload
      }\n`,
    );
    return null;
  }
  return payload;
}

module.exports = {
  PLUGIN_NAME,
  ALLOWED_ARTIFACT_KINDS,
  ULID_RE,
  generateUlid,
  detectGit,
  loadProducerVersion,
  wrapEnvelope,
  isEnvelope,
  isValidEnvelope,
  unwrapEnvelope,
};
