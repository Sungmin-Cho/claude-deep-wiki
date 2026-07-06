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

// ---------------------------------------------------------------------------
// Review fix (impl R1) #1 — wiki-ingest Step 7.6.C is a MULTI-block critical
// section (7.6.C → 7.6.D → 7.6.E Steps 8-11 → 7.6.F → 7.6.G), each a separate
// Claude Code Bash block. An unconditional `trap 'rmdir …' EXIT` in the 7.6.C
// acquisition block fires the instant that block ends — releasing the lock
// before Steps D-G run (the same early-release bug wiki-rebuild round-4 fixed).
// The fix converts 7.6.C to Pattern 2: no unconditional release trap in the
// acquisition block, a failure-only cleanup instead, and Step 7.6.G's explicit
// release on success. These guards read the shipped SKILL.md so a doc/impl
// drift is caught (RED before the fix, GREEN after).
// ---------------------------------------------------------------------------
const INGEST = S('wiki-ingest', 'SKILL.md');

// Slice the first ```bash fence body under a `#### Step <id>` heading.
function firstBashBlockUnder(md, heading) {
  const hIdx = md.indexOf(heading);
  assert.notEqual(hIdx, -1, `heading not found: ${heading}`);
  const fenceOpen = md.indexOf('```bash', hIdx);
  assert.notEqual(fenceOpen, -1, `bash fence not found under ${heading}`);
  const bodyStart = fenceOpen + '```bash'.length;
  const fenceClose = md.indexOf('```', bodyStart);
  assert.notEqual(fenceClose, -1, `closing fence not found under ${heading}`);
  return md.slice(bodyStart, fenceClose);
}

// F1-a — the 7.6.C acquisition block must NOT register an unconditional
// rmdir-EXIT trap; it registers a failure-only cleanup instead (RED-able).
test('F1-a: 7.6.C acquisition block uses a failure-only trap, not an unconditional release', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  const block = firstBashBlockUnder(md, '#### Step 7.6.C — Atomic write under lock');
  assert.match(block, /mkdir "<wiki>\/\.wiki-meta\/\.wiki-lock" \|\|/, 'mkdir||exit acquisition must be retained');
  assert.doesNotMatch(
    block,
    /trap\s+'rmdir[^']*'\s+EXIT/,
    '7.6.C must NOT register an unconditional `trap \'rmdir …\' EXIT` (fires early → Steps D-G run unlocked)',
  );
  assert.match(block, /cleanup_7_6_C/, '7.6.C must register a failure-only cleanup function');
  assert.match(block, /rc.*-ne.*0/, 'the 7.6.C cleanup must release the lock ONLY on non-zero rc');
});

// F1-b — Step 7.6.G still holds the explicit success-path release.
test('F1-b: Step 7.6.G explicitly releases the lock (rmdir + trap - EXIT)', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  const gIdx = md.indexOf('#### Step 7.6.G');
  assert.notEqual(gIdx, -1, 'Step 7.6.G heading not found');
  const gBlock = md.slice(gIdx, md.indexOf('\n#### ', gIdx + 10));
  assert.match(gBlock, /rmdir "<wiki>\/\.wiki-meta\/\.wiki-lock"/, '7.6.G must rmdir the lock on success');
  assert.match(gBlock, /trap - EXIT/, '7.6.G must clear the EXIT trap');
});

// F1-c — the pattern catalog reclassifies 7.6.C from Pattern 1 to Pattern 2.
test('F1-c: storage-layout.md lists wiki-ingest 7.6.C under Pattern 2, not Pattern 1', () => {
  const md = fs.readFileSync(STORAGE, 'utf8');
  const proto = md.slice(md.indexOf('## Concurrency Lock Protocol'));
  const p1Idx = proto.indexOf('Pattern 1');
  const p2Idx = proto.indexOf('Pattern 2');
  const p3Idx = proto.indexOf('Pattern 3');
  assert.ok(p1Idx !== -1 && p2Idx !== -1 && p3Idx !== -1, 'all three patterns must be present');
  const p1 = proto.slice(p1Idx, p2Idx);
  const p2 = proto.slice(p2Idx, p3Idx);
  assert.doesNotMatch(p1, /7\.6\.C/, 'Pattern 1 must no longer list wiki-ingest Step 7.6.C');
  assert.match(p2, /7\.6\.C/, 'Pattern 2 must list wiki-ingest Step 7.6.C (multi-block critical section)');
});
