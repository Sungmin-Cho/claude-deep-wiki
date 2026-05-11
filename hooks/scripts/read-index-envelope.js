#!/usr/bin/env node
'use strict';

/**
 * read-index-envelope.js — CLI to read a deep-wiki index.json and emit its
 * payload to stdout. Handles three cases:
 *
 *   1. Legacy index.json (pre-1.5.0): { pages: [...], generated_at } at root.
 *      → pass through unchanged (stdout = file contents).
 *   2. Envelope-wrapped index.json (v1.5.0+): { schema_version: "1.0", envelope:
 *      {producer: "deep-wiki", artifact_kind: "index", ...}, payload: {pages:
 *      [...], generated_at, ...} }.
 *      → identity-checked unwrap; stdout = payload only.
 *   3. Corrupt or identity-mismatched envelope. → exit 1, stderr message.
 *
 * Designed to be called from markdown command prompts (wiki-rebuild,
 * wiki-ingest, wiki-query, wiki-lint, wiki-setup) via the Bash tool. The
 * downstream consumer treats stdout JSON as if it were the legacy structure,
 * so existing jq pipelines (`.pages[]`, `.generated_at`) work unchanged.
 *
 * Atomic-read note: index.json itself is atomically written by
 * wrap-index-envelope.js (temp + rename), so a single readFileSync is safe.
 *
 * Usage:
 *   node read-index-envelope.js <path-to-index.json>
 *
 * Exit codes:
 *   0 — emitted payload (legacy or unwrapped) to stdout
 *   1 — envelope identity mismatch / corrupt payload
 *   2 — usage / IO / JSON parse error
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

const EXPECTED_KIND = 'index';

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write('usage: read-index-envelope.js <path-to-index.json>\n');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) usage(argv.length === 0 ? 'missing path argument' : 'too many arguments');
  const arg = argv[0];
  if (typeof arg !== 'string' || arg.length === 0) usage('path must be non-empty');

  const filePath = path.resolve(process.cwd(), arg);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${filePath}: ${err.message}\n`);
    process.exit(2);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: cannot parse ${filePath} as JSON: ${err.message}\n`);
    process.exit(2);
  }

  // unwrapEnvelope returns:
  //   - input unchanged for legacy (non-envelope) shape
  //   - payload object for envelope with identity match
  //   - null for envelope-shaped with identity mismatch OR corrupt payload
  const unwrapped = env.unwrapEnvelope(obj, EXPECTED_KIND);

  if (unwrapped === null) {
    // identity mismatch or corrupt payload — unwrapEnvelope already logged the
    // specific reason to stderr.
    process.stderr.write(
      `error: ${filePath} is envelope-shaped but failed identity check or has corrupt payload\n`,
    );
    process.exit(1);
  }

  // Defense against unwrapEnvelope returning the original object for legacy
  // shapes where the original happens to fail downstream consumer expectations:
  // we still emit unchanged — consumers are responsible for their own legacy
  // pass-through handling (e.g. legacy index.json had `pages` array at root).
  process.stdout.write(JSON.stringify(unwrapped, null, 2) + '\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { EXPECTED_KIND };
