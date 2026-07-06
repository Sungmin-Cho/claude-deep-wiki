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
const SCHEMA_YAML = path.resolve(
  __dirname, '..', 'skills', 'wiki-schema', 'wiki-schema.yaml',
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
RETRY_FILE="\${WIKI_ROOT}/.wiki-meta/.pending-scan-retry-count"
if [ -n "$current_window" ]; then
  TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  LAST_FILE="\${WIKI_ROOT}/.wiki-meta/.last-scan"
  CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [[ "$current_window" =~ $TS_RE ]] && { [[ -z "$CURRENT_LAST" ]] || ! [[ "$CURRENT_LAST" =~ $TS_RE ]] || [[ "$current_window" > "$CURRENT_LAST" ]]; }; then
    _LS_TMP="\${LAST_FILE}.tmp.$$.$(date +%s)"
    if printf '%s\\n' "$current_window" > "$_LS_TMP" && mv "$_LS_TMP" "$LAST_FILE"; then
      rm -f "\${WIKI_ROOT}/.wiki-meta/.pending-scan"
      rm -f "$RETRY_FILE"
    else
      rm -f "$_LS_TMP" 2>/dev/null || true
      echo "FATAL: F1 3-strike could not advance .last-scan (rename failed); .pending-scan and retry counter preserved." >&2
      exit 1
    fi
  else
    rm -f "\${WIKI_ROOT}/.wiki-meta/.pending-scan"
    rm -f "$RETRY_FILE"
  fi
else
  rm -f "$RETRY_FILE"
fi
`;

// Slice the F1 3-strike escape sub-block out of the real SKILL.md.
function extractF1ThreeStrike(md) {
  const startAnchor = '# 3-strike escape';
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

// F2-e — impl R2 fix: the valid+newer advance clears the stuck state
// (.pending-scan + retry counter) ONLY after a CONFIRMED rename. If the rename
// fails (ENOSPC/EACCES/network FS), .last-scan stays stale, so both the window
// and the counter must be preserved for the next hook cycle. RED before the fix
// (the pre-R2 form dropped .pending-scan + counter unconditionally on failure).
test('F2-e: F1 3-strike preserves .pending-scan + retry counter when the rename fails', () => {
  const f = setupFixture();
  const window = '2026-06-01T00:00:00Z';
  const priorLast = '2026-05-01T00:00:00Z';           // older → advance attempted
  fs.writeFileSync(f.pending, window + '\n');
  fs.writeFileSync(f.last, priorLast + '\n');
  const retryFile = path.join(f.meta, '.pending-scan-retry-count');
  const retryContent = `${window}:3`;                 // <pending_scan ISO>:count (3-strike armed)
  fs.writeFileSync(retryFile, retryContent);

  // Shadow `mv` with a stub that always fails, so the temp write succeeds but
  // the rename into `.last-scan` does not.
  const binDir = path.join(f.tmp, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mvStub = path.join(binDir, 'mv');
  fs.writeFileSync(mvStub, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(mvStub, 0o755);

  try {
    let status = 0;
    try {
      execSync('bash', {
        input: F1_PROMOTE_BASH,
        env: { ...process.env, WIKI_ROOT: f.tmp, PATH: `${binDir}:${process.env.PATH}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status || 1;   // the block bails non-zero on rename failure
    }
    assert.notEqual(status, 0, 'the promotion must bail non-zero when the rename fails');
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), priorLast, '.last-scan must stay at its prior value (advance did not commit)');
    assert.equal(fs.existsSync(f.pending), true, '.pending-scan must be preserved (the only record of the stuck window)');
    assert.equal(fs.readFileSync(f.pending, 'utf8').trim(), window, '.pending-scan content unchanged');
    assert.equal(fs.existsSync(retryFile), true, 'retry counter must be preserved (escape stays armed for the next cycle)');
    assert.equal(fs.readFileSync(retryFile, 'utf8'), retryContent, 'retry counter content unchanged');
    assert.equal(
      fs.readdirSync(f.meta).filter((n) => n.startsWith('.last-scan.tmp.')).length,
      0,
      'the failed temp file must be cleaned up (no stray tmp)',
    );
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// F2-f — shipped-procedure guard (RED-able) for impl R2: the real SKILL.md
// 3-strike region must clear the stuck state ONLY inside a rename-success gate,
// and a failed rename must surface a fatal error + bail (lock released).
test('F2-f: F1 3-strike gates .pending-scan/counter cleanup on a confirmed rename (impl R2)', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractF1ThreeStrike(md);
  assert.match(
    region,
    /if\s+printf[^\n]*&&\s*mv[^\n]*;\s*then/,
    'the .last-scan advance must be success-gated (if printf … && mv …; then)',
  );
  assert.match(region, /FATAL/, 'a failed rename must surface a fatal error (not silently drop state)');
  assert.match(region, /return 1/, 'a failed rename must bail (return 1) after releasing the lock');
});

// ---------------------------------------------------------------------------
// Review fix (impl R3) #4 — the F1 all-dropped 3-strike retry counter parsed
// its window key with `${saved%%:*}` (strip from the FIRST colon). But the key
// is the `.pending-scan` value — an ISO-8601 timestamp WITH colons
// (2026-06-01T00:00:00Z) — so `%%:*` truncated it to `2026-06-01T00`, never
// matched the current window, and reset the count to 1 on every run. The `>= 3`
// escape (including the guarded promotion above) was therefore unreachable in
// the real hook flow and `.pending-scan` stuck forever. Fix: `${saved%:*}`
// (strip from the LAST colon → keep the full timestamp) + integer-validate
// saved_count. These run the REAL counter block sliced from SKILL.md, so they
// are RED before the fix and GREEN after.
// ---------------------------------------------------------------------------

// Slice the retry-counter read+increment block out of the real SKILL.md and
// render <wiki> as ${WIKI_ROOT} so it runs hermetically.
function extractRetryCounterBash(md) {
  const startAnchor = 'RETRY_FILE="<wiki>/.wiki-meta/.pending-scan-retry-count"';
  const sIdx = md.indexOf(startAnchor);
  assert.notEqual(sIdx, -1, 'retry-counter block start anchor not found');
  const endAnchor = 'printf \'%s:%d\' "$current_window" "$current_count" > "$RETRY_FILE"';
  const eIdx = md.indexOf(endAnchor, sIdx);
  assert.notEqual(eIdx, -1, 'retry-counter block end anchor not found');
  return md.slice(sIdx, eIdx + endAnchor.length).split('<wiki>').join('${WIKI_ROOT}');
}

// F3-a — shipped-procedure guard (RED-able): colon-safe parse + int validation.
test('F3-a: F1 retry counter parses its timestamp window colon-safely (impl R3)', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractRetryCounterBash(md);
  assert.match(region, /\$\{saved%:\*\}/, 'window must be parsed with ${saved%:*} (strip from LAST colon)');
  assert.doesNotMatch(
    region,
    /\$\{saved%%:\*\}/,
    'window must NOT use ${saved%%:*} — it truncates the ISO timestamp at its first colon',
  );
  assert.match(region, /=~\s*\^\[0-9\]\+\$/, 'saved_count must be integer-validated (=~ ^[0-9]+$)');
});

// F3-b — behavioral regression (RED-able): a colon-bearing timestamp window
// matches the saved counter and increments (2 -> 3), not resets to 1.
test('F3-b: retry counter increments (not resets) for a colon-bearing timestamp window', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const counterBash = extractRetryCounterBash(md);
  const f = setupFixture();
  const window = '2026-06-01T00:00:00Z';
  fs.writeFileSync(f.pending, window + '\n');
  fs.writeFileSync(path.join(f.meta, '.pending-scan-retry-count'), `${window}:2`);
  try {
    execSync('bash', { input: counterBash, env: { ...process.env, WIKI_ROOT: f.tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
    const written = fs.readFileSync(path.join(f.meta, '.pending-scan-retry-count'), 'utf8').trim();
    const count = written.slice(written.lastIndexOf(':') + 1);
    const storedWindow = written.slice(0, written.lastIndexOf(':'));
    assert.equal(count, '3', 'a matching timestamp window must carry the count forward (2 -> 3), not reset to 1');
    assert.equal(storedWindow, window, 'the stored window key must be the full timestamp');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// F3-c — end-to-end (RED-able): counter increment -> 3-strike gate -> guarded
// promotion. Before the parse fix the count resets to 1, the `>= 3` gate never
// fires, and the stuck window is never released.
test('F3-c: counter reaching 3 makes the guarded promotion reachable (e2e)', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const counterBash = extractRetryCounterBash(md);
  const f = setupFixture();
  const window = '2026-06-01T00:00:00Z';
  fs.writeFileSync(f.pending, window + '\n');
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');
  fs.writeFileSync(path.join(f.meta, '.pending-scan-retry-count'), `${window}:2`);
  const e2e = `${counterBash}\nif [ "$current_count" -ge 3 ]; then\n${F1_PROMOTE_BASH}\nfi\n`;
  try {
    execSync('bash', { input: e2e, env: { ...process.env, WIKI_ROOT: f.tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), window, '3-strike fired → .last-scan advanced to the stuck window');
    assert.equal(fs.existsSync(f.pending), false, '3-strike fired → .pending-scan dropped (stuck window released)');
    assert.equal(
      fs.existsSync(path.join(f.meta, '.pending-scan-retry-count')),
      false,
      '3-strike fired → retry counter cleared',
    );
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review fix (impl R4) #6 — the F1 single-source path writes the retry counter
// as `<.pending-scan ISO string>:<count>`, but the multi-source Step 7.5.M-D
// contract defined the SAME file as `<window_epoch>:<count>`. Two paths sharing
// .pending-scan-retry-count with different key formats reset each other's
// counter, delaying/blocking the 3-strike escape. Fix: the multi-source
// contract adopts the same verbatim-`.pending-scan` key + colon-safe parse.
// ---------------------------------------------------------------------------

// Slice the multi-source counter contract prose (Counter file format → clear).
function extractMultiSourceCounterContract(md) {
  const sIdx = md.indexOf('**Counter file format**');
  assert.notEqual(sIdx, -1, 'multi-source counter contract start not found');
  const eIdx = md.indexOf('**Counter clear**', sIdx);
  assert.notEqual(eIdx, -1, 'multi-source counter contract end not found');
  return md.slice(sIdx, eIdx);
}

// F6-a — doc-assertion (RED-able): the multi-source contract uses the verbatim
// .pending-scan ISO string as the window key (string equality + colon-safe
// parse), NOT an epoch. RED before the fix (`<window_epoch>:<count>`), GREEN
// after.
test('F6-a: multi-source retry-counter contract shares the F1 ISO-string key format', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractMultiSourceCounterContract(md);
  assert.doesNotMatch(
    region,
    /<window_epoch>:<count>/,
    'multi-source contract must not define the counter file as <window_epoch>:<count>',
  );
  assert.match(region, /\.pending-scan/, 'the window key must be the .pending-scan value');
  assert.match(region, /\$\{saved%:\*\}/, 'the contract must specify the colon-safe parse (${saved%:*})');
  assert.match(region, /string equality|verbatim/i, 'window comparison must be full-string (not epoch)');
});

// F6-b — cross-path interop (behavioral): a counter written in the unified
// format (a colon-bearing ISO window) by one path is read + incremented by the
// F1 path to reach 3 (would trigger the shared 3-strike escape).
test('F6-b: a counter in the unified ISO format is continued (2 -> 3) across paths', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const counterBash = extractRetryCounterBash(md);
  const f = setupFixture();
  const window = '2026-06-01T00:00:00Z';
  fs.writeFileSync(f.pending, window + '\n');
  // The "other path" wrote the counter in the unified format: <ISO window>:<count>.
  fs.writeFileSync(path.join(f.meta, '.pending-scan-retry-count'), `${window}:2`);
  try {
    execSync('bash', { input: counterBash, env: { ...process.env, WIKI_ROOT: f.tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
    const written = fs.readFileSync(path.join(f.meta, '.pending-scan-retry-count'), 'utf8').trim();
    assert.equal(written.slice(written.lastIndexOf(':') + 1), '3', 'the F1 path must continue the shared counter (2 -> 3), reaching the 3-strike threshold');
    assert.equal(written.slice(0, written.lastIndexOf(':')), window, 'the window key round-trips as the full ISO timestamp');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review fix (impl R6 sweep) #9 — the R4 format unification updated the SKILL.md
// prose but left the machine-readable wiki-schema.yaml `retry_counter.format`
// (and the ingest-fail action description) declaring the old `<window_epoch>:
// <count>`. This sync guard pins the schema declaration and the SKILL.md
// contract to the same ISO key so a one-sided revert goes RED.
// ---------------------------------------------------------------------------
test('F9-a: retry-counter format unified (ISO key) across wiki-schema.yaml and wiki-ingest SKILL.md', () => {
  const schema = fs.readFileSync(SCHEMA_YAML, 'utf8');
  const md = fs.readFileSync(SKILL_MD, 'utf8');

  // schema.yaml retry_counter.format — the .pending-scan ISO key, never epoch.
  const rc = schema.slice(schema.indexOf('retry_counter:'), schema.indexOf('pending_scan:'));
  assert.notEqual(rc.length, 0, 'retry_counter block not found in wiki-schema.yaml');
  assert.doesNotMatch(rc, /window_epoch/, 'schema retry_counter must not declare the epoch key format');
  assert.match(rc, /pending_scan_iso|pending-scan/, 'schema retry_counter format must reference the .pending-scan ISO key');

  // schema.yaml ingest-fail action description — no epoch counter format.
  const ifIdx = schema.indexOf('- ingest-fail');
  assert.notEqual(ifIdx, -1, 'ingest-fail action not found in wiki-schema.yaml');
  const ifLine = schema.slice(ifIdx, schema.indexOf('\n', ifIdx));
  assert.doesNotMatch(ifLine, /<window_epoch>:<count>/, 'ingest-fail action must not cite the epoch counter format');

  // SKILL.md multi-source (7.5.M-D) contract — same ISO key, no epoch.
  const contract = md.slice(md.indexOf('**Counter file format**'), md.indexOf('**Counter clear**'));
  assert.doesNotMatch(contract, /<window_epoch>:<count>/, 'SKILL.md multi-source contract must not declare the epoch format');
  assert.match(contract, /\.pending-scan/, 'SKILL.md contract must key on the .pending-scan value');
});

// ---------------------------------------------------------------------------
// Review fix (impl R9) #14 — terminal-log logging for the 3-strike paths is
// idempotent emit-first, closing R7 AND R9 together. R9: the terminal
// ingest-fail row must be DURABLE BEFORE the window is released (a promote-first
// order could release the window then fail to log = fail-open, a 3-strike with
// no audit record). R7: a retry cycle must not append a SECOND terminal row for
// the same window. So each 3-strike path: (1) skips the emit if log.jsonl
// already carries a terminal ingest-fail row for THIS window (+slug) — window-
// key idempotency; (2) else emits, and on emit failure does NOT release the
// window (preserve .pending-scan + counter, bail); (3) only after the row is
// durable runs the guarded promotion (which itself preserves state + bails on a
// rename failure — the already-emitted row is not duplicated next cycle).
// ---------------------------------------------------------------------------

// Idempotent emit-first + guarded-promotion model shared by the behavioral
// cases below (mirrors the shipped F1 / Step 7.7.B structure).
const IDEMPOTENT_MODEL = `
run() {
  current_window=$(cat "\${WIKI_ROOT}/.wiki-meta/.pending-scan" 2>/dev/null || echo "")
  RETRY_FILE="\${WIKI_ROOT}/.wiki-meta/.pending-scan-retry-count"
  LOG_FILE="\${WIKI_ROOT}/.wiki-meta/log.jsonl"
  slug="src-a"
  # (1) window-key idempotent emit-first.
  if ! { grep -F '"ingest-fail"' "$LOG_FILE" 2>/dev/null | grep -F "$current_window" | grep -Fq "$slug"; }; then
    if ! printf '{"action":"ingest-fail","source":"%s","window":"%s"}\\n' "$slug" "$current_window" >> "$LOG_FILE"; then
      echo "FATAL: could not durably record ingest-fail" >&2; return 1
    fi
  fi
  # (3) guarded promotion — only after the terminal row is durable.
  if [ -n "$current_window" ]; then
    TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
    LAST_FILE="\${WIKI_ROOT}/.wiki-meta/.last-scan"
    CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
    if [[ "$current_window" =~ $TS_RE ]] && { [[ -z "$CURRENT_LAST" ]] || ! [[ "$CURRENT_LAST" =~ $TS_RE ]] || [[ "$current_window" > "$CURRENT_LAST" ]]; }; then
      _LS_TMP="\${LAST_FILE}.tmp.$$.$(date +%s)"
      if printf '%s\\n' "$current_window" > "$_LS_TMP" && mv "$_LS_TMP" "$LAST_FILE"; then
        rm -f "\${WIKI_ROOT}/.wiki-meta/.pending-scan"; rm -f "$RETRY_FILE"
      else
        rm -f "$_LS_TMP" 2>/dev/null || true; return 1
      fi
    else
      rm -f "\${WIKI_ROOT}/.wiki-meta/.pending-scan"; rm -f "$RETRY_FILE"
    fi
  else
    rm -f "$RETRY_FILE"
  fi
}
run
`;

const countIngestFail = (dir) => {
  const lp = path.join(dir, '.wiki-meta', 'log.jsonl');
  if (!fs.existsSync(lp) || fs.statSync(lp).isDirectory()) return 0;
  return fs.readFileSync(lp, 'utf8').split('\n').filter((l) => l.includes('ingest-fail')).length;
};

// F11-a — shipped-order guard (RED-able): the terminal ingest-fail emit comes
// FIRST (before the promotion gate), behind a window-key idempotency guard, and
// an emit failure bails without promoting.
test('F11-a: F1 3-strike emits the terminal ingest-fail first (idempotent), before the promotion', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const region = extractF1ThreeStrike(md);
  const emitIdx = region.indexOf('action=ingest-fail');
  const gateIdx = region.indexOf('if printf');
  assert.ok(emitIdx !== -1 && gateIdx !== -1, 'emit + promotion gate must both be present in the 3-strike block');
  assert.ok(emitIdx < gateIdx, 'the terminal ingest-fail emit must come BEFORE the promotion write+rename gate (emit-first — log durable before window release)');
  const idem = /grep -F '"ingest-fail"'/.exec(region);
  assert.ok(idem, 'a window-key idempotency guard (grep log.jsonl for an existing ingest-fail row) must be present');
  assert.ok(idem.index < emitIdx, 'the idempotency guard must precede the emit');
  assert.match(region, /could not durably record ingest-fail/i, 'an emit failure must bail (preserve the window) instead of proceeding to promote');
});

// F11-b — test (a): emit succeeds + rename fails, re-run leaves exactly ONE
// terminal row (window-key idempotency) and .pending-scan preserved.
test('F11-b: rename failure keeps exactly one terminal row across retries + preserves pending', () => {
  const ff = setupFixture();
  fs.writeFileSync(ff.pending, '2026-06-01T00:00:00Z\n');
  fs.writeFileSync(ff.last, '2026-05-01T00:00:00Z\n');
  const binDir = path.join(ff.tmp, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'mv'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(binDir, 'mv'), 0o755);
  const runOnce = () => {
    try {
      execSync('bash', { input: IDEMPOTENT_MODEL, env: { ...process.env, WIKI_ROOT: ff.tmp, PATH: `${binDir}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { /* run returns 1 on rename failure */ }
  };
  try {
    runOnce();  // cycle 1: emit + rename fails + preserve
    runOnce();  // cycle 2: idempotency skips the emit
    assert.equal(countIngestFail(ff.tmp), 1, 'exactly one terminal ingest-fail row across both cycles (no duplicate)');
    assert.equal(fs.existsSync(ff.pending), true, '.pending-scan preserved when the rename keeps failing');
    assert.equal(fs.readFileSync(ff.last, 'utf8').trim(), '2026-05-01T00:00:00Z', '.last-scan not advanced (rename failed)');
  } finally {
    fs.rmSync(ff.tmp, { recursive: true, force: true });
  }
});

// F14-b — test (b): the emit fails → the promotion is not attempted (window
// preserved). Modeled by making log.jsonl un-appendable (a directory).
test('F14-b: an emit failure blocks the promotion (window preserved, no fail-open)', () => {
  const f = setupFixture();
  fs.writeFileSync(f.pending, '2026-06-01T00:00:00Z\n');
  fs.writeFileSync(f.last, '2026-05-01T00:00:00Z\n');
  fs.mkdirSync(path.join(f.meta, 'log.jsonl'));   // append to a directory fails → emit fails
  try {
    try {
      execSync('bash', { input: IDEMPOTENT_MODEL, env: { ...process.env, WIKI_ROOT: f.tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { /* run returns 1 on emit failure */ }
    assert.equal(fs.readFileSync(f.last, 'utf8').trim(), '2026-05-01T00:00:00Z', '.last-scan must NOT advance when the terminal emit failed');
    assert.equal(fs.existsSync(f.pending), true, '.pending-scan preserved (no window release without a durable audit row)');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

// F13 — Step 7.7.B all-workers-fail 3-strike mirrors the F1 idempotent
// emit-first order: the terminal ingest-fail emit comes BEFORE the guarded
// promotion, behind a window-key idempotency guard. Shipped-order guard,
// isomorphic to F11-a.
test('F13: Step 7.7.B all-workers-fail 3-strike emits ingest-fail first (idempotent), before promotion', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const sIdx = md.indexOf('# 4. If counter == 3');
  assert.notEqual(sIdx, -1, 'Step 7.7.B 3-strike block not found');
  const region = md.slice(sIdx, md.indexOf('# else: .pending-scan NOT promoted', sIdx));
  const promoteIdx = region.indexOf('promote_pending_scan_to_last_scan');
  const emitIdx = region.indexOf('action=ingest-fail');
  assert.ok(promoteIdx !== -1 && emitIdx !== -1, 'the guarded promotion + ingest-fail emit must both be present');
  assert.ok(
    emitIdx < promoteIdx,
    'the terminal ingest-fail emit must come BEFORE the guarded promotion (emit-first, mirror of the F1 3-strike fix)',
  );
  assert.match(
    region,
    /already (has|carries) a terminal ingest-fail|idempoten|grep -F '"ingest-fail"'/i,
    'Step 7.7.B must have a window-key idempotency guard before the emit',
  );
});
