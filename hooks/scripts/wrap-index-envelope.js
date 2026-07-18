#!/usr/bin/env node
'use strict';

/**
 * wrap-index-envelope.js — CLI to wrap a deep-wiki index payload in the M3
 * cross-plugin envelope (cf. claude-deep-suite/docs/envelope-migration.md §1).
 *
 * Designed to be called from markdown command prompts (skills/wiki-rebuild/SKILL.md,
 * skills/wiki-ingest/SKILL.md, skills/wiki-setup/SKILL.md) via the Bash tool. The
 * command writes the domain payload (pages catalog) to a temp file, then
 * invokes this helper to produce the final envelope-wrapped artifact at
 * <wiki_root>/.wiki-meta/index.json.
 *
 * deep-wiki is a multi-source aggregator (index.json is built by scanning
 * frontmatter of every page under <wiki_root>/pages/). parent_run_id is
 * normally omitted; --source-page repeatable flag records page paths in
 * provenance.source_artifacts (path-only — markdown, no envelope detect).
 *
 * Usage:
 *   node wrap-index-envelope.js \
 *     --payload-file <path-to-payload.json> \
 *     --output <wiki_root>/.wiki-meta/index.json \
 *     [--artifact-kind index]                     (default: index) \
 *     [--parent-run-id <ULID>]                    (forward-compat; usually omit) \
 *     [--session-id <id>] \
 *     [--source-page <wiki-relative or absolute path>]  (repeatable) \
 *     [--source-artifact <path[:run_id]>]               (repeatable — generic)
 *
 * Cross-plugin chain semantics (handoff §3.3):
 *   - deep-wiki index is a multi-source aggregator (page frontmatter scan
 *     result). parent_run_id is omitted by default; consumers reconstruct
 *     traces from provenance.source_artifacts[] entries. Page paths land
 *     in source_artifacts path-only — markdown pages do not carry envelope
 *     metadata. If an explicit --parent-run-id is provided (e.g. future
 *     single-source flow), it is validated as ULID at the CLI boundary
 *     (defense-in-depth, deep-evolve round-1 C3 lesson).
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped artifact
 *   2 — usage / IO / argv error
 *
 * Self-contained: no external deps. The envelope shape is enforced by the
 * companion validator (scripts/validate-envelope-emit.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');
const { atomicWriteFile } = require('./runtime/fs-safe.js');

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: wrap-index-envelope.js --payload-file <payload.json>\n' +
      '                              --output <wiki_root>/.wiki-meta/index.json\n' +
      '                              [--artifact-kind index]\n' +
      '                              [--parent-run-id <ULID>]\n' +
      '                              [--session-id <id>]\n' +
      '                              [--source-page <path>] (repeatable)\n' +
      '                              [--source-artifact <path[:run_id]>] (repeatable)\n',
  );
  process.exit(2);
}

const SINGLE_VALUE_FLAGS = new Set([
  'artifact-kind',
  'payload-file',
  'output',
  'parent-run-id',
  'session-id',
]);
const REPEATABLE_FLAGS = new Set(['source-page', 'source-artifact']);
const KNOWN_FLAGS = new Set([...SINGLE_VALUE_FLAGS, ...REPEATABLE_FLAGS]);

function parseArgs(argv) {
  const args = {};
  const repeats = {};
  for (const f of REPEATABLE_FLAGS) repeats[f] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      usage(`unexpected positional argument: ${a}`);
    }
    let key;
    let value;
    if (a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        usage(`flag --${key} expects a value`);
      }
      value = next;
      i++;
    }
    if (!KNOWN_FLAGS.has(key)) {
      usage(`unknown flag --${key}`);
    }

    // Boundary validation (deep-evolve round-1 W3 + deep-review round-1 Q6).
    // Reject empty values at the CLI layer for ALL required + repeatable flags.
    // Helpers that receive empty strings would otherwise silently drop them
    // via `!value` falsy checks or parseSourceArtifactSpec returning null.
    if (key === 'parent-run-id' && !env.ULID_RE.test(value)) {
      usage(
        `--parent-run-id must be 26-char Crockford Base32 ULID, got "${value}"`,
      );
    }
    if (
      (key === 'session-id' ||
        key === 'payload-file' ||
        key === 'output' ||
        key === 'artifact-kind' ||
        key === 'source-page' ||
        key === 'source-artifact') &&
      value.length === 0
    ) {
      usage(`--${key} value must be non-empty`);
    }

    if (REPEATABLE_FLAGS.has(key)) {
      repeats[key].push(value);
    } else {
      args[key] = value;
    }
  }
  for (const f of REPEATABLE_FLAGS) {
    if (repeats[f].length > 0) args[f] = repeats[f];
  }
  return args;
}

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${p}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: cannot parse ${p} as JSON: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Strict-gated extraction of envelope.run_id with identity verification.
 *
 * Mirrors the deep-evolve / deep-review identity-gated API by design (handoff
 * §4 deep-evolve round-1 C2 lesson). Caller MUST specify identity:
 *
 *   - With { producer, artifactKind } → strict 3-way check + ULID format.
 *   - With { selfConsistent: true } → producer === schema.name ===
 *     artifact_kind self-consistency + ULID format. Used for generic
 *     --source-artifact path-only auto-harvest.
 *   - No options → returns null (forces caller intent; defense against future
 *     regression where a new code path forgets the identity gate).
 *
 * Returns the envelope.run_id when all gates pass, null otherwise.
 * Builds atop env.isValidEnvelope (loose envelope detection + payload
 * non-null/non-array object — handoff §4 W4 lesson).
 */
function tryReadEnvelopeRunId(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
  if (!env.isValidEnvelope(obj)) return null;
  const e = obj.envelope;
  if (typeof e.run_id !== 'string' || !env.ULID_RE.test(e.run_id)) return null;
  if (!e.schema || typeof e.schema !== 'object' || Array.isArray(e.schema)) return null;

  if (opts && opts.producer !== undefined) {
    if (
      e.producer !== opts.producer ||
      e.artifact_kind !== opts.artifactKind ||
      e.schema.name !== opts.artifactKind
    ) {
      return null;
    }
  } else if (opts && opts.selfConsistent === true) {
    if (
      typeof e.producer !== 'string' ||
      typeof e.artifact_kind !== 'string' ||
      e.artifact_kind !== e.schema.name
    ) {
      return null;
    }
  } else {
    // No identity gate provided — refuse to extract. Forces caller intent.
    return null;
  }

  return e.run_id;
}

/**
 * Parse `--source-artifact path[:run_id]` value. The run_id portion is
 * optional and skipped if not a valid ULID (defense against typos / paths
 * containing colons). Returns { path, run_id? } or null on empty path.
 */
function parseSourceArtifactSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  // Find LAST colon to allow drive letters / URL-like paths in path portion.
  const lastColon = spec.lastIndexOf(':');
  if (lastColon === -1) {
    return { path: spec };
  }
  const candidate = spec.slice(lastColon + 1);
  if (env.ULID_RE.test(candidate)) {
    return { path: spec.slice(0, lastColon), run_id: candidate };
  }
  return { path: spec };
}

function normalizeSourceArtifacts(sourcePages, sourceArtifactSpecs) {
  const result = [];
  for (const page of sourcePages || []) {
    if (typeof page === 'string' && page.length > 0) result.push({ path: page });
  }
  for (const value of sourceArtifactSpecs || []) {
    const parsed = typeof value === 'string' ? parseSourceArtifactSpec(value) : { ...value };
    if (!parsed || typeof parsed.path !== 'string' || parsed.path.length === 0) continue;
    if (!parsed.run_id) {
      const absolute = path.isAbsolute(parsed.path)
        ? parsed.path
        : path.resolve(process.cwd(), parsed.path);
      const harvested = tryReadEnvelopeRunId(absolute, { selfConsistent: true });
      if (harvested) parsed.run_id = harvested;
    }
    result.push(parsed);
  }
  return result;
}

function writeIndexEnvelope(options = {}) {
  const outputPath = options.outputPath;
  const payload = options.payload;
  if (typeof outputPath !== 'string' || outputPath.length === 0 || !path.isAbsolute(outputPath)) {
    throw new TypeError('writeIndexEnvelope requires an absolute outputPath');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('index payload must be a non-null, non-array object');
  }
  if (!Array.isArray(payload.pages)) {
    throw new TypeError(
      `index payload does not match deep-wiki/index domain shape: required "pages" array (got ${
        Object.hasOwn(payload, 'pages') ? typeof payload.pages : 'missing'
      })`,
    );
  }
  const sourceArtifacts = normalizeSourceArtifacts(options.sourcePages, options.sourceArtifacts);
  const wikiRoot = path.dirname(path.dirname(outputPath));
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const wrapped = env.wrapEnvelope({
    artifactKind: 'index',
    payload,
    parentRunId: options.parentRunId,
    sessionId: options.sessionId,
    sourceArtifacts,
    git: options.git || env.detectGit(wikiRoot),
    generatedAt: now.toISOString(),
    runId: options.runId,
  });
  atomicWriteFile(outputPath, `${JSON.stringify(wrapped, null, 2)}\n`);
  return wrapped;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['payload-file', 'output'];
  for (const r of required) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  // artifact-kind defaults to 'index' (deep-wiki's single artifact kind in v1.5.0).
  const artifactKind = args['artifact-kind'] || 'index';
  if (!env.ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    usage(
      `--artifact-kind must be one of ${[...env.ALLOWED_ARTIFACT_KINDS].join(', ')}, got "${artifactKind}"`,
    );
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);

  const payload = readJson(payloadPath);
  let wrapped;
  try {
    wrapped = writeIndexEnvelope({
      outputPath,
      payload,
      parentRunId: args['parent-run-id'] || undefined,
      sessionId: args['session-id'] || undefined,
      sourcePages: args['source-page'],
      sourceArtifacts: args['source-artifact'],
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `wrapped: ${outputPath} (run_id=${wrapped.envelope.run_id}, artifact_kind=${wrapped.envelope.artifact_kind})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { parseSourceArtifactSpec, tryReadEnvelopeRunId, writeIndexEnvelope };
