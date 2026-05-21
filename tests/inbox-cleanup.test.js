'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');

// Step 0.5 bash extract (must stay in sync with skills/wiki-ingest/SKILL.md
// Step 0.5 block). The extract is duplicated here so the test does not
// depend on parsing the markdown skill file. If the skill block changes,
// update this constant.
//
// Stat order: GNU `stat -c %Y` first, BSD `stat -f %m` fallback. On Linux,
// `stat -f %m` returns filesystem metadata + exits 0 — the `||` chain never
// fires — so a BSD-first order would receive non-numeric input on Linux.
// The numeric guard below makes the fallback robust on either platform.
//
// JS template literal note: $`...` interpolates JS variables, so we use
// `${...}` syntax in bash by escaping the dollar sign as `\${...}` inside
// the JS template. The resulting bash source has literal `${VAR}` strings.
const STEP_0_5_BASH = `
set +e
INBOX_DIR="\${WIKI_ROOT}/.wiki-meta/.inbox"
SOURCES_DIR="\${WIKI_ROOT}/.wiki-meta/sources"

PROTECTED_INBOX=""
if [ -d "$SOURCES_DIR" ]; then
  for y in "$SOURCES_DIR"/*.yaml; do
    [ -f "$y" ] || continue
    grep -q '^partial_fail:' "$y" 2>/dev/null || continue
    origin=$(grep -E '^origin:' "$y" 2>/dev/null | sed -E 's/^origin: *"?([^"]*)"?$/\\1/' | head -1)
    case "$origin" in
      "$INBOX_DIR"/*) PROTECTED_INBOX="\${PROTECTED_INBOX}\${origin}"$'\\n' ;;
    esac
  done
fi

if [ -d "$INBOX_DIR" ]; then
  NOW_EPOCH=$(date +%s)
  for f in "$INBOX_DIR"/*.txt; do
    [ -f "$f" ] || continue
    if printf '%s' "$PROTECTED_INBOX" | grep -Fxq "$f"; then
      continue
    fi
    # GNU first, BSD fallback. Numeric guard rejects filesystem-info output.
    FILE_EPOCH=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
    case "$FILE_EPOCH" in
      ''|*[!0-9]*) continue ;;
    esac
    AGE_SEC=$(( NOW_EPOCH - FILE_EPOCH ))
    if [ "$AGE_SEC" -gt 604800 ]; then
      rm -f "$f"
    fi
  done
fi
set -e
`;

// Invocation helper: pass the bash body via stdin and WIKI_ROOT via the env
// option. Using `bash -c "<body>"` from execSync would let the OUTER
// /bin/sh -c expand ${WIKI_ROOT}/$INBOX_DIR/$f BEFORE bash receives the
// command — the per-command WIKI_ROOT prefix only sets the variable in
// bash's environment, not in outer sh's parameter expansion. stdin + env
// eliminates the entire outer-shell escape problem.
function runStep0_5(tmp) {
  execSync('bash', {
    input: STEP_0_5_BASH,
    env: { ...process.env, WIKI_ROOT: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function setupFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-cleanup-'));
  const inbox = path.join(tmp, '.wiki-meta', '.inbox');
  const sources = path.join(tmp, '.wiki-meta', 'sources');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(sources, { recursive: true });
  return { tmp, inbox, sources };
}

test('Step 0.5: stale (>7d) inbox file is removed', () => {
  const { tmp, inbox } = setupFixture();
  const stale = path.join(inbox, 'stale.txt');
  fs.writeFileSync(stale, 'old session');
  const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

  try {
    runStep0_5(tmp);
    assert.equal(fs.existsSync(stale), false, '8-day-old file must be removed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 0.5: fresh (<7d) inbox file is preserved', () => {
  const { tmp, inbox } = setupFixture();
  const fresh = path.join(inbox, 'fresh.txt');
  fs.writeFileSync(fresh, 'recent session');
  const oneDayAgo = Date.now() / 1000 - 1 * 86400;
  fs.utimesSync(fresh, oneDayAgo, oneDayAgo);

  try {
    runStep0_5(tmp);
    assert.equal(fs.existsSync(fresh), true, '1-day-old file must be preserved');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 0.5: partial_fail-referenced stale inbox is protected', () => {
  const { tmp, inbox, sources } = setupFixture();
  const protectedFile = path.join(inbox, 'pasted-source.txt');
  fs.writeFileSync(protectedFile, 'pending retry');
  // Make it look stale (>7 days) — protection must override age.
  const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
  fs.utimesSync(protectedFile, eightDaysAgo, eightDaysAgo);
  // Sentinel: yaml with partial_fail: block + origin: pointing at protectedFile.
  const yaml = `id: pasted-source
type: text
origin: "${protectedFile}"
partial_fail:
  ts: "2026-05-13T10:00:00Z"
  failed_pages: ["foo.md"]
`;
  fs.writeFileSync(path.join(sources, 'pasted-source.yaml'), yaml);

  try {
    runStep0_5(tmp);
    assert.equal(
      fs.existsSync(protectedFile),
      true,
      '8-day-old file MUST be preserved when referenced by partial_fail sentinel',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
