'use strict';

// tests/wiki-lint-fix-lock.test.js — audit fix #1 (wiki-lint --fix under lock).
//
// §13 Auto-Fix historically mutated wiki state (`.pending-scan` drop, version
// prune) with NO `.wiki-lock` — invariant #3 (lock atomicity) was silently
// exempting wiki-lint, so a hook-driven auto-ingest running concurrently could
// lost-update index.json / clobber the scan window / prune fresh backups.
//
// The fix introduces a 2-phase lock-ownership model:
//   Phase A — lint's own mutations run inside ONE self-contained lock block
//             (pattern 1: acquire → unconditional EXIT trap → re-read/re-validate
//             under lock → mutate → block exit releases the lock).
//   Phase B — index.json repair delegates to /wiki-rebuild AFTER Phase A releases
//             the lock (rebuild's mkdir-lock is non-reentrant).
//
// The behavioral tests run the REAL Phase A bash block extracted from the
// shipped SKILL.md (no duplicated constant → no sync drift). The doc guards
// (T2-a / T2-h) assert the shipped procedure/canonical schema directly.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');

const LINT_MD = path.resolve(__dirname, '..', 'skills', 'wiki-lint', 'SKILL.md');
const SCHEMA_MD = path.resolve(__dirname, '..', 'skills', 'wiki-schema', 'SKILL.md');

// Extract the fenced ```bash block whose body contains `needle` from a markdown
// string. Used to run the shipped Phase A block directly.
function extractFencedBlock(md, needle) {
  const nIdx = md.indexOf(needle);
  assert.notEqual(nIdx, -1, `needle not found in SKILL.md (Phase A block absent?): ${needle}`);
  const openIdx = md.lastIndexOf('```bash', nIdx);
  assert.notEqual(openIdx, -1, 'opening ```bash fence not found before needle');
  const bodyStart = md.indexOf('\n', openIdx) + 1;
  const closeIdx = md.indexOf('\n```', bodyStart);
  assert.notEqual(closeIdx, -1, 'closing fence not found');
  return md.slice(bodyStart, closeIdx);
}

function phaseABlock() {
  const md = fs.readFileSync(LINT_MD, 'utf8');
  // Needle is unique to the Phase A code block's leading comment (the prose
  // bullet says "lint's own mutations" without "--fix", so this only matches
  // inside the fenced block).
  return extractFencedBlock(md, "lint's own --fix mutations under the wiki lock");
}

function setupWiki() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-lock-')));
  const meta = path.join(tmp, '.wiki-meta');
  fs.mkdirSync(meta, { recursive: true });
  return {
    tmp,
    meta,
    lock: path.join(meta, '.wiki-lock'),
    pending: path.join(meta, '.pending-scan'),
    last: path.join(meta, '.last-scan'),
    versions: path.join(meta, '.versions'),
  };
}

function runBash(block, tmp, extraEnv = {}) {
  return spawnSync('bash', {
    input: block,
    env: { ...process.env, WIKI_ROOT: tmp, ...extraEnv },
    encoding: 'utf8',
    timeout: 20000,
  });
}

function seedVersions(dir, names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'backup body\n');
}

// T2-a — shipped-procedure lock guard (RED-able). The §13 Auto-Fix region must
// acquire `.wiki-lock` via mkdir and register an EXIT trap. Before the fix,
// wiki-lint contained zero `wiki-lock` references.
test('T2-a: §13 Auto-Fix acquires .wiki-lock with an EXIT trap', () => {
  const md = fs.readFileSync(LINT_MD, 'utf8');
  const sectionIdx = md.indexOf('### 13. Auto-Fix');
  assert.notEqual(sectionIdx, -1, '§13 Auto-Fix heading not found');
  const section = md.slice(sectionIdx);
  assert.match(section, /mkdir "\$LOCK_DIR"/, '§13 must acquire the lock via mkdir "$LOCK_DIR"');
  assert.match(section, /\.wiki-lock/, '§13 must reference .wiki-lock');
  assert.match(section, /trap '[^']*rmdir[^']*' EXIT/, '§13 must register an EXIT trap that rmdir-releases the lock');
});

// T2-b — held-lock contention: another session holds the lock. Phase A must
// skip its mutations (leave `.pending-scan` intact), print a soft-skip notice,
// and NOT remove the other session's lock.
test('T2-b: held lock → mutations skipped, soft warning, foreign lock untouched', () => {
  const w = setupWiki();
  fs.mkdirSync(w.lock, { recursive: true });  // foreign session holds the lock
  const last = '2026-05-01T00:00:00Z';
  const stalePending = '2026-04-01T00:00:00Z';  // older than last → would be dropped if unlocked
  fs.writeFileSync(w.last, last + '\n');
  fs.writeFileSync(w.pending, stalePending + '\n');
  try {
    const r = runBash(phaseABlock(), w.tmp);
    assert.equal(r.status, 0, `expected soft-skip exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(fs.existsSync(w.pending), true, 'stale .pending-scan must NOT be dropped while another session holds the lock');
    assert.match(r.stdout, /locked by another session/, 'must print a contention soft-skip notice');
    assert.equal(fs.existsSync(w.lock), true, 'must not remove the foreign lock');
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-c — interrupt right after lock acquisition. The EXIT trap must release the
// lock so no stale lock leaks (pattern-1 single-block guarantee). A pattern-2
// multi-block design would leak here; this pins the pattern-1 choice.
test('T2-c: interrupt after acquire → EXIT trap releases the lock (no leak)', () => {
  const w = setupWiki();
  fs.writeFileSync(w.pending, 'not-a-timestamp\n');
  try {
    const block = phaseABlock();
    const injected = block.replace(/(trap [^\n]*EXIT\n)/, '$1exit 1\n');
    assert.notEqual(injected, block, 'injection anchor (trap ... EXIT) must exist for the interrupt simulation');
    const r = runBash(injected, w.tmp);
    assert.notEqual(r.status, 0, 'injected exit must abort the block');
    assert.equal(fs.existsSync(w.lock), false, 'EXIT trap must release .wiki-lock even on interrupt');
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-d — TOCTOU: a valid current `.pending-scan` (not stale, not invalid) must
// survive. The block must judge on the value re-read UNDER the lock, not on any
// stale pre-lock diagnostic.
test('T2-d: valid current .pending-scan preserved (re-validated under lock)', () => {
  const w = setupWiki();
  const validPending = '2026-06-01T00:00:00Z';
  const olderLast = '2026-05-01T00:00:00Z';  // pending is NEWER → not stale → keep
  fs.writeFileSync(w.pending, validPending + '\n');
  fs.writeFileSync(w.last, olderLast + '\n');
  try {
    const r = runBash(phaseABlock(), w.tmp);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.readFileSync(w.pending, 'utf8').trim(), validPending, 'valid current .pending-scan must be preserved');
    assert.equal(fs.existsSync(w.lock), false, 'lock released after run');
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-e — after a normal run the lock is released, so the Phase B /wiki-rebuild
// delegation can acquire it (invariant i/iii). Encoded as "a fresh mkdir on the
// lock dir succeeds after Phase A".
test('T2-e: lock released after run → rebuild delegation can re-acquire', () => {
  const w = setupWiki();
  try {
    const r = runBash(phaseABlock(), w.tmp);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(w.lock), false, '.wiki-lock must be absent after Phase A');
    // Simulate /wiki-rebuild's non-reentrant acquire — must succeed.
    fs.mkdirSync(w.lock);
    assert.equal(fs.existsSync(w.lock), true, 'rebuild can acquire the lock lint no longer holds');
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-f — happy path: no lock held → acquire → apply mutations (stale pending
// dropped, excess versions pruned) → release.
test('T2-f: normal path applies mutations then releases the lock', () => {
  const w = setupWiki();
  const last = '2026-05-01T00:00:00Z';
  const stalePending = '2026-04-01T00:00:00Z';
  fs.writeFileSync(w.last, last + '\n');
  fs.writeFileSync(w.pending, stalePending + '\n');
  seedVersions(w.versions, ['p.v1.md', 'p.v2.md', 'p.v3.md', 'p.v4.md']);  // 4 → prune oldest 1
  try {
    const r = runBash(phaseABlock(), w.tmp);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(w.pending), false, 'stale .pending-scan dropped');
    assert.equal(fs.existsSync(path.join(w.versions, 'p.v1.md')), false, 'oldest version pruned');
    assert.deepEqual(
      fs.readdirSync(w.versions).sort(),
      ['p.v2.md', 'p.v3.md', 'p.v4.md'],
      'newest 3 versions retained',
    );
    assert.equal(fs.existsSync(w.lock), false, 'lock released after run');
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-g — version prune numeric-sort guard (the destructive-path regression).
// Lexicographic order would rank v10 < v2 and delete the NEWEST backups; the
// impl must sort NUMERICALLY. Cross-stem isolation is asserted too.
test('T2-g: version prune keeps newest 3 by NUMERIC version, per stem', () => {
  const w = setupWiki();
  seedVersions(w.versions, [
    'a.v1.md', 'a.v2.md', 'a.v9.md', 'a.v10.md', 'a.v11.md',  // keep v9/v10/v11
    'b.v1.md', 'b.v2.md',                                      // only 2 → keep both
  ]);
  try {
    const r = runBash(phaseABlock(), w.tmp);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const survivors = fs.readdirSync(w.versions).sort();
    assert.deepEqual(
      survivors,
      ['a.v10.md', 'a.v11.md', 'a.v9.md', 'b.v1.md', 'b.v2.md'],
      'must keep {a.v9,a.v10,a.v11} (numeric top-3) + both b.* — never delete v10/v11 as "less than v2"',
    );
  } finally {
    fs.rmSync(w.tmp, { recursive: true, force: true });
  }
});

// T2-h — canonical-doc sync guard (RED-able). Invariant #3's enforcement list
// (wiki-schema) must include wiki-lint now that it acquires the lock.
test('T2-h: invariant #3 enforcement list includes wiki-lint', () => {
  const md = fs.readFileSync(SCHEMA_MD, 'utf8');
  const inv3Idx = md.indexOf('3. **Lock atomicity**');
  assert.notEqual(inv3Idx, -1, 'invariant #3 not found');
  const inv3 = md.slice(inv3Idx, md.indexOf('\n\n', inv3Idx));
  assert.match(inv3, /wiki-lint/, 'invariant #3 enforcement list must include wiki-lint');
});
