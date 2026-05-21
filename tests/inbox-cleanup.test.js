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
// update this constant. (A future plugin-level CI lint will compare them.)
//
// Stat order: GNU `stat -c %Y` first, BSD `stat -f %m` fallback. On Linux,
// `stat -f %m` returns filesystem metadata + exits 0 — the `||` chain never
// fires — so a BSD-first order would receive non-numeric input on Linux.
// The numeric guard below makes the fallback robust on either platform.
//
// Quarantine instead of hard-delete: stale files are MOVED to .quarantine/
// rather than rm -f'd, so the Step 6.5 → Step 7.6.F crash window does not
// destroy the only copy of pasted-text source state.
//
// sed pattern handles both double-quoted and single-quoted `origin:` forms
// to mirror the Step 1.5 origin parser, which accepts both shapes.
//
// JS template literal note: $`...` interpolates JS variables, so we use
// `${...}` syntax in bash by escaping the dollar sign as `\${...}` inside
// the JS template. The resulting bash source has literal `${VAR}` strings.
const STEP_0_5_BASH = `
set +e
INBOX_DIR="\${WIKI_ROOT}/.wiki-meta/.inbox"
SOURCES_DIR="\${WIKI_ROOT}/.wiki-meta/sources"
QUARANTINE_DIR="\${INBOX_DIR}/.quarantine"

PROTECTED_INBOX=""
if [ -d "$SOURCES_DIR" ]; then
  for y in "$SOURCES_DIR"/*.yaml; do
    [ -f "$y" ] || continue
    grep -q '^partial_fail:' "$y" 2>/dev/null || continue
    origin=$(grep -E '^origin:' "$y" 2>/dev/null | sed -E "s/^origin: *['\\"]?([^'\\"]*)['\\"]?\\$/\\1/" | head -1)
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
    FILE_EPOCH=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
    case "$FILE_EPOCH" in
      ''|*[!0-9]*) continue ;;
    esac
    AGE_SEC=$(( NOW_EPOCH - FILE_EPOCH ))
    if [ "$AGE_SEC" -gt 604800 ]; then
      mkdir -p "$QUARANTINE_DIR" 2>/dev/null
      mv "$f" "$QUARANTINE_DIR/$(basename "$f").$(date +%s)" 2>/dev/null
    fi
  done
fi
set -e
`;

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

test('Step 0.5: stale (>7d) inbox file is quarantined (not deleted)', () => {
  const { tmp, inbox } = setupFixture();
  const stale = path.join(inbox, 'stale.txt');
  fs.writeFileSync(stale, 'old session');
  const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

  try {
    runStep0_5(tmp);
    assert.equal(fs.existsSync(stale), false, '8-day-old file must be moved out of inbox');
    const quarantineDir = path.join(inbox, '.quarantine');
    assert.equal(fs.existsSync(quarantineDir), true, '.quarantine/ must be created');
    const survivors = fs.readdirSync(quarantineDir).filter((n) => n.startsWith('stale.txt.'));
    assert.equal(survivors.length, 1, 'exactly one quarantined file must remain (epoch-suffixed)');
    assert.equal(
      fs.readFileSync(path.join(quarantineDir, survivors[0]), 'utf8'),
      'old session',
      'quarantined file content must be preserved verbatim',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 0.5: fresh (<7d) inbox file is preserved in place', () => {
  const { tmp, inbox } = setupFixture();
  const fresh = path.join(inbox, 'fresh.txt');
  fs.writeFileSync(fresh, 'recent session');
  const oneDayAgo = Date.now() / 1000 - 1 * 86400;
  fs.utimesSync(fresh, oneDayAgo, oneDayAgo);

  try {
    runStep0_5(tmp);
    assert.equal(fs.existsSync(fresh), true, '1-day-old file must be preserved in place');
    const quarantineDir = path.join(inbox, '.quarantine');
    if (fs.existsSync(quarantineDir)) {
      assert.equal(
        fs.readdirSync(quarantineDir).length,
        0,
        '.quarantine/ must remain empty (fresh files do not trigger move)',
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 0.5: partial_fail-referenced stale inbox is protected (double-quoted origin)', () => {
  const { tmp, inbox, sources } = setupFixture();
  const protectedFile = path.join(inbox, 'pasted-source.txt');
  fs.writeFileSync(protectedFile, 'pending retry');
  const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
  fs.utimesSync(protectedFile, eightDaysAgo, eightDaysAgo);
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
      '8-day-old file MUST be preserved when partial_fail sentinel references it',
    );
    const quarantineDir = path.join(inbox, '.quarantine');
    if (fs.existsSync(quarantineDir)) {
      assert.equal(
        fs.readdirSync(quarantineDir).length,
        0,
        '.quarantine/ must remain empty (protected file is not moved)',
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 0.5: partial_fail with single-quoted origin is also protected', () => {
  const { tmp, inbox, sources } = setupFixture();
  const protectedFile = path.join(inbox, 'pasted-singlequote.txt');
  fs.writeFileSync(protectedFile, 'single-quoted yaml retry');
  const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
  fs.utimesSync(protectedFile, eightDaysAgo, eightDaysAgo);
  // Single-quoted origin: form (review round 3 / C1 — Step 1.5's origin parser
  // accepts this shape, so the protection scan must too).
  const yaml = `id: pasted-singlequote
type: text
origin: '${protectedFile}'
partial_fail:
  ts: '2026-05-13T10:00:00Z'
  failed_pages: ['foo.md']
`;
  fs.writeFileSync(path.join(sources, 'pasted-singlequote.yaml'), yaml);

  try {
    runStep0_5(tmp);
    assert.equal(
      fs.existsSync(protectedFile),
      true,
      'single-quoted-origin file MUST be preserved when partial_fail sentinel references it',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
