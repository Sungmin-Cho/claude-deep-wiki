'use strict';

// tests/last-scan-promotion.test.js — audit fix #3 (atomic .last-scan promotion).
//
// The hook-driven batch promotion (skills/wiki-ingest/SKILL.md "Auto-Ingest"
// Step 11) advances `.last-scan` to the batch's covered window. Historically
// the advance was a direct redirect (`echo "$BATCH_PENDING" > "$LAST_FILE"`),
// which is O_TRUNC-then-write: a SIGTERM between the truncate and the write
// (the 15s hook budget on network-backed volumes is the motivating case) can
// leave `.last-scan` empty/truncated. This suite pins the atomic temp+rename
// form (the repo standard, matching scan-vault-changes.sh:396-403 for
// `.pending-scan` and wrap-index-envelope.js for index.json).
//
// Two kinds of assertion:
//   - shipped-procedure guard (T1-a): reads the REAL SKILL.md promotion block
//     and asserts the non-atomic redirect is gone / the atomic rename is
//     present. RED before the fix, GREEN after.
//   - behavioral (T1-b/-c): extracts the promotion bash into a constant and
//     exercises it under fixtures. PROMOTE_BASH must stay in sync with
//     skills/wiki-ingest/SKILL.md Step 11 promotion block. (A future
//     plugin-level CI lint will compare them.)

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');

const SKILL_MD = path.resolve(
  __dirname, '..', 'skills', 'wiki-ingest', 'SKILL.md',
);

// Promotion bash extract (must stay in sync with skills/wiki-ingest/SKILL.md
// "Auto-Ingest (SessionStart Hook)" Step 11 promotion block). `<wiki_root>`
// in the skill is rendered as `${WIKI_ROOT}` here; `BATCH_PENDING` is supplied
// by the caller's environment, exactly as the ambient batch snapshot supplies
// it in the skill.
const PROMOTE_BASH = `
PENDING_FILE="\${WIKI_ROOT}/.wiki-meta/.pending-scan"
LAST_FILE="\${WIKI_ROOT}/.wiki-meta/.last-scan"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
if [ -n "$BATCH_PENDING" ] && [ -s "$PENDING_FILE" ]; then
  CURRENT_PENDING=$(cat "$PENDING_FILE")
  CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [[ "$CURRENT_PENDING" =~ $TS_RE ]] && [[ "$BATCH_PENDING" =~ $TS_RE ]]; then
    if [[ -z "$CURRENT_LAST" ]] || ! [[ "$CURRENT_LAST" =~ $TS_RE ]] || ! [[ "$CURRENT_LAST" > "$BATCH_PENDING" ]]; then
      _LS_TMP="\${LAST_FILE}.tmp.$$.$(date +%s)"
      printf '%s\\n' "$BATCH_PENDING" > "$_LS_TMP" && mv "$_LS_TMP" "$LAST_FILE"
    fi
    CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
    if [[ "$CURRENT_LAST" =~ $TS_RE ]] && ! [[ "$CURRENT_PENDING" > "$CURRENT_LAST" ]]; then
      rm -f "$PENDING_FILE"
    fi
  fi
fi
`;

// Slice the promotion bash region out of the real SKILL.md so the guard is
// scoped to the block under test (not the whole file).
function extractPromotionRegion(md) {
  const startAnchor = 'PENDING_FILE="<wiki_root>/.wiki-meta/.pending-scan"';
  const startIdx = md.indexOf(startAnchor);
  assert.notEqual(startIdx, -1, 'promotion block start anchor not found in SKILL.md');
  // Closing fence may be indented (the block lives inside a numbered list item).
  const fenceMatch = /\n[ \t]*```/.exec(md.slice(startIdx));
  assert.notEqual(fenceMatch, null, 'promotion block closing fence not found in SKILL.md');
  return md.slice(startIdx, startIdx + fenceMatch.index);
}

function setupFixture() {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'last-scan-')),
  );
  const meta = path.join(tmp, '.wiki-meta');
  fs.mkdirSync(meta, { recursive: true });
  return {
    tmp,
    meta,
    pending: path.join(meta, '.pending-scan'),
    last: path.join(meta, '.last-scan'),
  };
}

function runPromote(tmp, batchPending, extraEnv = {}) {
  execSync('bash', {
    input: PROMOTE_BASH,
    env: { ...process.env, WIKI_ROOT: tmp, BATCH_PENDING: batchPending, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// T1-a — shipped-procedure atomicity guard (RED-able). The real promotion
// block must NOT truncate-write `.last-scan` directly, and MUST rename a temp
// file into place.
test('T1-a: SKILL.md promotion block writes .last-scan atomically (temp+rename)', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractPromotionRegion(md);
  assert.doesNotMatch(
    region,
    />\s*"\$LAST_FILE"/,
    'promotion block must not redirect directly into "$LAST_FILE" (non-atomic O_TRUNC)',
  );
  assert.match(
    region,
    /mv\s+"\$_LS_TMP"\s+"\$LAST_FILE"/,
    'promotion block must rename a temp file into "$LAST_FILE" (atomic swap)',
  );
});

// T1-b — promotion correctness regression guard (logic-invariant; passes
// before and after the fix). Cases (a)/(b)/(c) from the Step 11 comment.
test('T1-b case (a): normal advance — no concurrent hook', () => {
  const f = setupFixture();
  const batch = '2026-06-01T00:00:00Z';
  fs.writeFileSync(f.pending, batch + '\n');           // CURRENT_PENDING == BATCH
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');  // CURRENT_LAST < BATCH
  try {
    runPromote(f.tmp, batch);
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), batch, '.last-scan advances to BATCH_PENDING');
    assert.equal(fs.existsSync(f.pending), false, '.pending-scan dropped (window covered)');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('T1-b case (b): concurrent hook wrote newer pending — commit snapshot, keep remainder', () => {
  const f = setupFixture();
  const batch = '2026-06-01T00:00:00Z';               // snapshot captured at batch start
  const newerPending = '2026-06-15T00:00:00Z';        // concurrent hook advanced it
  fs.writeFileSync(f.pending, newerPending + '\n');   // CURRENT_PENDING > BATCH
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');  // CURRENT_LAST < BATCH
  try {
    runPromote(f.tmp, batch);
    assert.equal(
      fs.readFileSync(f.last, 'utf8').trim(),
      batch,
      '.last-scan commits BATCH_PENDING (snapshot), NOT the newer CURRENT_PENDING',
    );
    assert.equal(
      fs.readFileSync(f.pending, 'utf8').trim(),
      newerPending,
      '.pending-scan preserved (newer remainder a concurrent hook detected)',
    );
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('T1-b case (c): stale pending older than last — do NOT regress .last-scan', () => {
  const f = setupFixture();
  const batch = '2026-04-01T00:00:00Z';                // pending older than last
  const freshLast = '2026-05-01T00:00:00Z';
  fs.writeFileSync(f.pending, batch + '\n');
  fs.writeFileSync(f.last, freshLast + '\n');
  try {
    runPromote(f.tmp, batch);
    assert.equal(
      fs.readFileSync(f.last, 'utf8').trim(),
      freshLast,
      '.last-scan must NOT regress below its current value',
    );
    assert.equal(fs.existsSync(f.pending), false, 'obsolete .pending-scan dropped');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// T1-c — atomic-swap failure semantics (only meaningful after the fix). If the
// rename fails (disk/SIGTERM), `.last-scan` keeps its prior valid value and the
// temp file remains — never an empty/truncated `.last-scan`.
test('T1-c: rename failure leaves prior .last-scan intact + temp remnant (never truncated)', () => {
  const f = setupFixture();
  const batch = '2026-06-01T00:00:00Z';
  const priorLast = '2026-01-01T00:00:00Z';           // valid, older than batch → advance attempted
  fs.writeFileSync(f.pending, batch + '\n');
  fs.writeFileSync(f.last, priorLast + '\n');

  // Shadow `mv` with a stub that always fails, so the temp write succeeds but
  // the rename into `.last-scan` does not.
  const binDir = path.join(f.tmp, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mvStub = path.join(binDir, 'mv');
  fs.writeFileSync(mvStub, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(mvStub, 0o755);

  try {
    runPromote(f.tmp, batch, { PATH: `${binDir}:${process.env.PATH}` });
    assert.equal(
      fs.readFileSync(f.last, 'utf8').trim(),
      priorLast,
      '.last-scan must retain its prior valid value when the rename fails',
    );
    const remnants = fs.readdirSync(f.meta).filter((n) => n.startsWith('.last-scan.tmp.'));
    assert.equal(remnants.length, 1, 'temp file must remain (atomic swap did not complete)');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// T1-d — reader defense stays valid: scan-vault-changes.sh rejects a
// truncated/empty `.last-scan` and falls through to `.pending-scan`. This pins
// the downstream half of the defense-in-depth (the atomic write is the
// upstream half). Complements tests/pending-scan-recovery.test.js, which
// covers empty `.pending-scan` but not empty `.last-scan`.
test('T1-d: reader rejects empty .last-scan and falls through to .pending-scan', () => {
  const SCAN_HOOK = path.resolve(
    __dirname, '..', 'hooks', 'scripts', 'scan-vault-changes.sh',
  );
  assert.ok(fs.existsSync(SCAN_HOOK), 'scan-vault-changes.sh must exist');

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'last-scan-rd-')));
  try {
    const vaultRoot = path.join(tmp, 'vault');
    const wikiRoot = path.join(tmp, 'wiki');
    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'deep-wiki-config.yaml'),
      `vault: ${vaultRoot}\nwiki_root: ${wikiRoot}\nobsidian_cli:\n  available: false\nauto_ingest:\n  ignore_globs: []\n`,
    );

    // Empty `.last-scan` (truncated mid-write), valid `.pending-scan`.
    const validPending = new Date(Date.now() - 3 * 3600 * 1000)
      .toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(path.join(wikiRoot, '.wiki-meta', '.last-scan'), '');
    fs.writeFileSync(path.join(wikiRoot, '.wiki-meta', '.pending-scan'), validPending + '\n');

    const env = { ...process.env, HOME: tmp };
    delete env.DEEP_WIKI_ROOT;
    delete env.CLAUDE_PROJECT_DIR;
    const r = require('node:child_process').spawnSync('bash', [SCAN_HOOK], {
      cwd: tmp, env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 0, `hook crashed on empty .last-scan: ${r.stderr}`);
    // The valid pending-scan must be preserved (reader used it as the bound,
    // did not overwrite it, since it is a well-formed timestamp).
    assert.equal(
      fs.readFileSync(path.join(wikiRoot, '.wiki-meta', '.pending-scan'), 'utf8').trim(),
      validPending,
      'reader must fall through to and preserve the valid .pending-scan',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review fix (impl R1) #2 — the F1 all-dropped 3-strike escape promoted the
// stuck window with a raw `mv "<wiki>/…/.pending-scan" "<wiki>/…/.last-scan"`,
// with NO TS_RE validation and NO monotonicity check. A stale window (older
// than .last-scan) would regress .last-scan, and a malformed one would corrupt
// it — both invariant #2 (.last-scan monotonicity) breaks. The fix reuses the
// Step 11 promotion guard: advance .last-scan ONLY when the window is a valid
// TS strictly newer than .last-scan; either way drop .pending-scan so the stuck
// window is still released. F1_PROMOTE_BASH must stay in sync with the guarded
// block in skills/wiki-ingest/SKILL.md do_all_failed_under_lock 3-strike path.
const F1_PROMOTE_BASH = `
current_window=$(cat "\${WIKI_ROOT}/.wiki-meta/.pending-scan" 2>/dev/null || echo "")
if [ -n "$current_window" ]; then
  TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  LAST_FILE="\${WIKI_ROOT}/.wiki-meta/.last-scan"
  CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [[ "$current_window" =~ $TS_RE ]] && { [[ -z "$CURRENT_LAST" ]] || ! [[ "$CURRENT_LAST" =~ $TS_RE ]] || [[ "$current_window" > "$CURRENT_LAST" ]]; }; then
    _LS_TMP="\${LAST_FILE}.tmp.$$.$(date +%s)"
    printf '%s\\n' "$current_window" > "$_LS_TMP" && mv "$_LS_TMP" "$LAST_FILE"
  fi
  rm -f "\${WIKI_ROOT}/.wiki-meta/.pending-scan"
fi
`;

// Slice the F1 3-strike escape sub-block out of the real SKILL.md.
function extractF1ThreeStrike(md) {
  const startAnchor = '# 3-strike escape — emit ingest-fail';
  const sIdx = md.indexOf(startAnchor);
  assert.notEqual(sIdx, -1, 'F1 3-strike block start anchor not found in SKILL.md');
  const endAnchor = 'Normal retry-required emit';
  const eIdx = md.indexOf(endAnchor, sIdx);
  assert.notEqual(eIdx, -1, 'F1 3-strike block end anchor not found in SKILL.md');
  return md.slice(sIdx, eIdx);
}

function runF1Promote(tmp) {
  execSync('bash', {
    input: F1_PROMOTE_BASH,
    env: { ...process.env, WIKI_ROOT: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// F2-a — shipped-procedure guard (RED-able). The F1 3-strike region must not
// contain the raw unguarded `mv .pending-scan .last-scan`, and MUST validate
// via TS_RE + drop .pending-scan.
test('F2-a: F1 3-strike promotion is guarded (no unguarded mv onto .last-scan)', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractF1ThreeStrike(md);
  assert.doesNotMatch(
    region,
    /mv\s+"<wiki>\/\.wiki-meta\/\.pending-scan"\s+"<wiki>\/\.wiki-meta\/\.last-scan"/,
    'F1 3-strike must not unconditionally mv .pending-scan onto .last-scan (regress/corrupt risk)',
  );
  assert.match(region, /TS_RE/, 'F1 3-strike must validate the stuck window against TS_RE before promoting');
  assert.match(
    region,
    /rm -f "<wiki>\/\.wiki-meta\/\.pending-scan"/,
    'F1 3-strike must drop .pending-scan (release the stuck window) on the non-promote path',
  );
});

// F2-b — valid window strictly newer than .last-scan → atomic advance + drop.
test('F2-b: F1 3-strike promotes a valid window newer than .last-scan (atomic advance)', () => {
  const f = setupFixture();
  fs.writeFileSync(f.pending, '2026-06-01T00:00:00Z\n');
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');
  try {
    runF1Promote(f.tmp);
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), '2026-06-01T00:00:00Z', '.last-scan advances to the stuck window');
    assert.equal(fs.existsSync(f.pending), false, '.pending-scan dropped (stuck window released)');
    assert.equal(
      fs.readdirSync(f.meta).filter((n) => n.startsWith('.last-scan.tmp.')).length,
      0,
      'no temp remnant on a successful atomic advance',
    );
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// F2-c — stale window (older than .last-scan) → no regress, still dropped.
test('F2-c: F1 3-strike drops a stale window without regressing .last-scan', () => {
  const f = setupFixture();
  fs.writeFileSync(f.pending, '2026-04-01T00:00:00Z\n');  // older than last
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');
  try {
    runF1Promote(f.tmp);
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), '2026-05-01T00:00:00Z', '.last-scan must NOT regress (invariant #2)');
    assert.equal(fs.existsSync(f.pending), false, 'stale .pending-scan dropped (stuck window still released)');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// F2-d — malformed window → .last-scan untouched, still dropped.
test('F2-d: F1 3-strike drops a malformed window and leaves .last-scan intact', () => {
  const f = setupFixture();
  fs.writeFileSync(f.pending, 'not-a-timestamp\n');
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');
  try {
    runF1Promote(f.tmp);
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), '2026-05-01T00:00:00Z', 'invalid window must not corrupt .last-scan');
    assert.equal(fs.existsSync(f.pending), false, 'invalid .pending-scan dropped (stuck window released)');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});
