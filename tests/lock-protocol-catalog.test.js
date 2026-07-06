'use strict';

// tests/lock-protocol-catalog.test.js — audit fix #1-derived (lock pattern docs).
//
// The canonical lock doc (storage-layout.md §Concurrency Lock Protocol +
// invariant #3) described only ONE trap pattern, but the skills legitimately
// use three (single-block unconditional trap / multi-block failure-only trap /
// contention soft-fail). Taking invariant #3's "release via `trap 'rmdir' EXIT`"
// literally in a multi-block skill would reintroduce the early-release bug
// wiki-rebuild's round-4 review fixed. This commit documents all three patterns
// and splits invariant #3 into what (acquire/release) vs how (trap form →
// pattern catalog). Docs-only: existing skill trap code is unchanged.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const S = (...p) => path.resolve(__dirname, '..', 'skills', ...p);
const STORAGE = S('wiki-schema', 'references', 'storage-layout.md');
const SCHEMA = S('wiki-schema', 'SKILL.md');

// T3-a — the 3-pattern catalog exists in storage-layout.md (RED-able).
test('T3-a: storage-layout.md documents all three lock patterns', () => {
  const md = fs.readFileSync(STORAGE, 'utf8');
  const proto = md.slice(md.indexOf('## Concurrency Lock Protocol'));
  assert.notEqual(proto.length, 0, '§Concurrency Lock Protocol section not found');
  assert.match(proto, /single[- ]block/i, 'pattern 1 (single-block unconditional trap) must be documented');
  assert.match(proto, /multi[- ]block/i, 'pattern 2 (multi-block failure-only trap) must be documented');
  assert.match(proto, /failure-only/i, 'pattern 2 must name the failure-only trap');
  assert.match(proto, /soft-fail/i, 'pattern 3 (contention soft-fail) must be documented');
});

// T3-b — invariant #3 splits what/how and keeps the enforcement list intact
// (including the wiki-lint entry added in the previous commit). RED-able on the
// what/how delegation.
test('T3-b: invariant #3 delegates trap form to the pattern catalog, keeps enforcement list', () => {
  const md = fs.readFileSync(SCHEMA, 'utf8');
  const inv3Idx = md.indexOf('3. **Lock atomicity**');
  assert.notEqual(inv3Idx, -1, 'invariant #3 not found');
  const inv3 = md.slice(inv3Idx, md.indexOf('\n\n', inv3Idx));
  assert.match(inv3, /pattern catalog/i, 'invariant #3 must delegate trap form to the pattern catalog');
  // Enforcement list (what) preserved, including wiki-lint from the prior commit.
  assert.match(inv3, /wiki-lint/, 'invariant #3 enforcement list must still include wiki-lint');
  assert.match(inv3, /wiki-ingest/, 'invariant #3 enforcement list must still include wiki-ingest');
  assert.match(inv3, /acquire/i, 'invariant #3 must still state the acquire-before-write requirement');
});

// T3-c — existing skill trap code is NOT changed by this docs-only commit. The
// rationale anchors that justify each variant must remain in place.
test('T3-c: existing skill trap rationales are unchanged (docs-only commit)', () => {
  assert.match(
    fs.readFileSync(S('wiki-rebuild', 'SKILL.md'), 'utf8'),
    /round-4 Codex review #1 fix/,
    'wiki-rebuild pattern-2 rationale must be preserved',
  );
  assert.match(
    fs.readFileSync(S('wiki-ingest', 'SKILL.md'), 'utf8'),
    /R3\.C-1 fix/,
    'wiki-ingest F1 soft-fail (pattern-3) rationale must be preserved',
  );
  const query = fs.readFileSync(S('wiki-query', 'SKILL.md'), 'utf8');
  assert.match(query, /trap cleanup EXIT/, 'wiki-query pattern-2 cleanup trap must be preserved');
});
