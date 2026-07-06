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
const os = require('node:os');
const { execSync } = require('node:child_process');
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

// ---------------------------------------------------------------------------
// Review fix (impl R4) #5 — Step 7.6.G released the lock (rmdir + trap -) and
// then ran `run_step_13_auto_lint`, whose comment claimed it "includes
// retention prune last-3 .versions per page" and was "safe outside the
// transaction". A retention prune is a MUTATION, so running it unlocked breaks
// invariant #3 (every write acquires the lock) — a concurrent ingest that grabs
// the freed lock races the prune against its own fresh .versions backups. The
// fix: the post-lock auto-lint is read-only diagnostics; the prune is performed
// only through wiki-lint §13 Auto-Fix Phase A, which self-acquires the lock.
// ---------------------------------------------------------------------------
test('F5-a: Step 7.6.G post-lock auto-lint is read-only; prune deferred to a locked path', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  const gIdx = md.indexOf('#### Step 7.6.G');
  assert.notEqual(gIdx, -1, 'Step 7.6.G heading not found');
  const gBlock = md.slice(gIdx, md.indexOf('\n#### ', gIdx + 10));
  assert.doesNotMatch(
    gBlock,
    /safe outside the transaction/i,
    '7.6.G must not claim the post-lock prune is safe outside the lock transaction',
  );
  assert.match(gBlock, /read-only/i, '7.6.G must state the post-lock auto-lint is read-only');
  assert.match(gBlock, /Phase A/, '7.6.G must route the retention prune through wiki-lint §13 Phase A (self-locked)');
  assert.match(gBlock, /invariant #3/i, '7.6.G must tie the prune-under-lock rule to invariant #3');
});

// ---------------------------------------------------------------------------
// Review fix (impl R5) #7 — R4 corrected Step 7.6.G's comment but left the
// Step 13 SECTION body ("### 13. Auto-Lint") still instructing an unlocked
// "**Auto-fix**" (add/remove index.json entries, prune excess versions). An
// agent following that section post-release mutates state without the lock
// (invariant #3). The fix makes the section read-only + delegates the
// auto-fixable mutations to `/wiki-lint --fix` (self-locking §13 Phase A / B).
// ---------------------------------------------------------------------------
test('F7-a: Step 13 Auto-Lint section performs no unlocked mutation (delegates auto-fix)', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  // Anchor on the real markdown heading (leading newline), not the 7.6.G comment
  // that quotes "### 13. Auto-Lint".
  const sIdx = md.indexOf('\n### 13. Auto-Lint');
  assert.notEqual(sIdx, -1, 'Step 13 section not found');
  const section = md.slice(sIdx, md.indexOf('\n### 14.', sIdx));
  assert.doesNotMatch(
    section,
    /\*\*Auto-fix\*\* what can be fixed/,
    'Step 13 must not carry an unlocked auto-fix mutation directive',
  );
  assert.match(section, /\/wiki-lint --fix/, 'Step 13 must delegate auto-fixable mutations to /wiki-lint --fix');
  assert.match(section, /read-only/i, 'Step 13 must state it is read-only');
});

// ---------------------------------------------------------------------------
// Review fix (impl R5) #8 — Pattern 2 (the 7.6.C conversion) holds the lock
// across 7.6.C -> 7.6.D -> 7.6.E -> 7.6.F -> 7.6.G, but only 7.6.C registered a
// failure-only trap. A general command failure in an intermediate block
// (7.6.D/7.6.F) between the 7.6.C success and the 7.6.G release would exit the
// block non-zero with the lock still held → stranded lock, all writers blocked.
// The catalog's Pattern 2 definition requires each mutation block to register a
// release-on-failure trap (wiki-rebuild cleanup_step3 model).
// ---------------------------------------------------------------------------
test('F8-a: intermediate lock-holding blocks 7.6.D and 7.6.F register a failure-only trap', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  for (const [name, heading, fn] of [
    ['7.6.D', '#### Step 7.6.D', 'cleanup_7_6_D'],
    ['7.6.F', '#### Step 7.6.F', 'cleanup_7_6_F'],
  ]) {
    const block = firstBashBlockUnder(md, heading);
    assert.match(block, new RegExp(`${fn}\\(\\)`), `${name} must define a failure-only cleanup (${fn})`);
    assert.match(block, /rc.*-ne.*0/, `${name} cleanup must release the lock ONLY on non-zero rc`);
    assert.match(block, new RegExp(`trap ${fn} EXIT`), `${name} must register the failure-only trap`);
    assert.doesNotMatch(block, /trap\s+'rmdir[^']*'\s+EXIT/, `${name} must not use an unconditional release trap`);
  }
});

test('F8-b: a lock-holding intermediate block releases the lock on failure, keeps it on success', () => {
  const md = fs.readFileSync(INGEST, 'utf8');
  const fBlock = firstBashBlockUnder(md, '#### Step 7.6.F');
  const m = /cleanup_7_6_F\(\)\s*\{[\s\S]*?\}\s*\ntrap cleanup_7_6_F EXIT/.exec(fBlock);
  assert.notEqual(m, null, 'cleanup_7_6_F function + trap not found in the 7.6.F block');
  const trapMech = m[0];

  // Failure path: the block exits non-zero with the lock held → trap releases it.
  let tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f8-fail-')));
  try {
    fs.mkdirSync(path.join(tmp, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const failScript = trapMech.split('<wiki>').join(tmp) + '\nfalse\n';
    let status = 0;
    try {
      execSync('bash', { input: failScript, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      status = e.status || 1;
    }
    assert.notEqual(status, 0, 'the block must exit non-zero on a mid-block failure');
    assert.equal(
      fs.existsSync(path.join(tmp, '.wiki-meta', '.wiki-lock')),
      false,
      'the failure-only trap must release the lock (no strand)',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Success path: the block exits zero → lock stays held for Step 7.6.G.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f8-ok-')));
  try {
    fs.mkdirSync(path.join(tmp, '.wiki-meta', '.wiki-lock'), { recursive: true });
    const okScript = trapMech.split('<wiki>').join(tmp) + '\ntrue\n';
    execSync('bash', { input: okScript, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(
      fs.existsSync(path.join(tmp, '.wiki-meta', '.wiki-lock')),
      true,
      'success must keep the lock held for Step 7.6.G',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
