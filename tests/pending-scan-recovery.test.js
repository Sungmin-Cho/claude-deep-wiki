'use strict';

// tests/pending-scan-recovery.test.js — M5.5 #5 (deep-wiki side).
//
// Pins the `.pending-scan` recovery contract of
// hooks/scripts/scan-vault-changes.js against artificially-dangled state:
// invalid content, stale-vs-fresh timestamp ordering, presence-vs-absence
// of `.last-scan`. The hook's per-fire decision (overwrite vs preserve)
// is load-bearing for `/wiki-ingest`'s detection window — a regression
// that overwrites a valid `.pending-scan` on every hook fire would erase
// the lower bound and let files detected in an earlier session drop
// below the next LAST_EPOCH (H1 regression on fresh installs, reported
// by ultrareview bug_006 — now enforced by the cooperative Node runtime).
//
// This file is the missing companion to wiki-lint.md Step 11 / 12
// stale-detection-and-fix protocol: wiki-lint is a markdown protocol
// that Claude follows (not directly executable), so this test exercises
// the executable upstream half — the hook's reaction to dangling state.
//
// **Hermetic** — uses HOME=tmpRoot + a tmpRoot config to avoid any
// contact with the user's real `~/.claude/deep-wiki-config.yaml` or
// real Obsidian vault.
//
// Spec: deep-suite/docs/superpowers/plans/
// 2026-05-12-m5.5-remaining-tests-handoff.md §2 #5 (deep-wiki row).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCAN_HOOK = path.resolve(
  __dirname, '..', 'hooks', 'scripts', 'scan-vault-changes.js',
);

if (!fs.existsSync(SCAN_HOOK)) {
  throw new Error(`scan-vault-changes.js missing at ${SCAN_HOOK}`);
}

// ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ` matching the Node scanner contract.
function nowMinusHours(hours) {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function setupHermeticVault({ withConfig = true, withWikiRoot = true } = {}) {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-rec-')),
  );
  const vaultRoot = path.join(tmp, 'vault');
  const wikiRoot = path.join(tmp, 'wiki');
  fs.mkdirSync(vaultRoot, { recursive: true });
  if (withWikiRoot) {
    fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  }
  if (withConfig) {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'deep-wiki-config.yaml'),
      `vault: ${vaultRoot}\nwiki_root: ${wikiRoot}\nobsidian_cli:\n  available: false\nauto_ingest:\n  ignore_globs: []\n`,
    );
  }
  return { tmp, vaultRoot, wikiRoot };
}

function runHook(tmpHome) {
  // Scrub leak vars that might redirect config or wiki_root resolution.
  const env = { ...process.env };
  delete env.DEEP_WIKI_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  // Critical: HOME override pins config lookup to tmpRoot/.claude/, NOT
  // the developer's real ~/.claude/deep-wiki-config.yaml.
  env.HOME = tmpHome;
  return spawnSync(process.execPath, [SCAN_HOOK], {
    cwd: tmpHome,
    env,
    encoding: 'utf8',
    timeout: 20000,
    shell: false,
  });
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

describe('scan-vault-changes.js .pending-scan recovery (M5.5 #5)', () => {
  let setup;
  afterEach(() => {
    if (setup && setup.tmp) {
      fs.rmSync(setup.tmp, { recursive: true, force: true });
      setup = null;
    }
  });

  // Test A: invalid `.pending-scan` content (non-ISO-8601). Hook must
  // not crash and must overwrite with a fresh valid timestamp. Pre-
  // recovery the `_pending_ok` guard in scan-vault-changes.sh:388-393
  // returns false for non-matching content, allowing the rewrite at
  // line 395-404.
  it('A: invalid `.pending-scan` content → overwritten with fresh ISO-8601 timestamp', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    fs.writeFileSync(pendingFile, 'not-a-timestamp\n');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0, `hook crashed: ${r.stderr}`);

    const after = readIfExists(pendingFile);
    assert.ok(after, '.pending-scan should still exist (rewritten)');
    assert.match(
      after.trim(),
      TS_RE,
      `expected fresh ISO-8601 timestamp, got ${JSON.stringify(after.trim())}`,
    );
  });

  // Test B: valid `.pending-scan` → hook PRESERVES it (does not advance).
  // This is the H1 regression guard from bug_006: every-hook-fire
  // overwrite would erase the oldest-detection-window lower bound.
  it('B: valid `.pending-scan` → preserved verbatim across hook fires', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    const original = nowMinusHours(2);
    fs.writeFileSync(pendingFile, original + '\n');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0);

    const after = readIfExists(pendingFile);
    assert.ok(after, '.pending-scan must still exist');
    assert.equal(
      after.trim(),
      original,
      `valid pending-scan must NOT advance — found '${after.trim()}', expected '${original}'`,
    );
  });

  // Test C: dangling `.pending-scan` OLDER than `.last-scan`. Priority
  // logic uses `.last-scan` as LAST_SCAN; `.pending-scan` is preserved
  // (still valid format) AND the file-list detection window is correct.
  // This pins the wiki-lint Step 11 State B detection target (dangling
  // pending older than last) — wiki-lint --fix would drop it, but the
  // hook running BEFORE wiki-lint must not crash or corrupt state.
  it('C: pending older than last-scan → both preserved, hook does not crash', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    const lastFile = path.join(setup.wikiRoot, '.wiki-meta', '.last-scan');
    const stalePending = nowMinusHours(48);  // older
    const freshLast = nowMinusHours(1);      // newer
    fs.writeFileSync(pendingFile, stalePending + '\n');
    fs.writeFileSync(lastFile, freshLast + '\n');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0, `hook crashed: ${r.stderr}`);

    // Both files should still exist with their original content — the
    // hook reads them but does not mutate either in this branch.
    assert.equal(readIfExists(pendingFile).trim(), stalePending);
    assert.equal(readIfExists(lastFile).trim(), freshLast);
  });

  // Test D: no `.last-scan`, valid `.pending-scan` → priority falls
  // through to pending-scan as LAST_SCAN value (scan-vault-changes.sh
  // lines 73-77 fallback). Pending preserved.
  it('D: no .last-scan + valid .pending-scan → pending used + preserved', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    const pending = nowMinusHours(3);
    fs.writeFileSync(pendingFile, pending + '\n');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0);
    assert.equal(readIfExists(pendingFile).trim(), pending);
  });

  // Test E: neither file present (fresh install) → hook writes a new
  // `.pending-scan` with current time. Closes the "no oldest window"
  // bootstrapping case so /wiki-ingest's first run has a lower bound.
  it('E: fresh install (no .last-scan, no .pending-scan) → hook creates .pending-scan', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    assert.equal(readIfExists(pendingFile), null, 'precondition: pending missing');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0);
    const after = readIfExists(pendingFile);
    assert.ok(after, '.pending-scan must be created on fresh install');
    assert.match(after.trim(), TS_RE);
  });

  // Test F: `.pending-scan` exists as an EMPTY file (truncate crash mid-
  // write — atomic mv interrupted before fsync). `[ -s ]` check at
  // line 388 treats empty file as "no valid pending"; the rewrite branch
  // fires. Must produce a valid timestamp, not double-write garbage.
  it('F: empty .pending-scan (truncated mid-write) → overwritten with valid timestamp', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    fs.writeFileSync(pendingFile, '');  // empty file
    const sizeBefore = fs.statSync(pendingFile).size;
    assert.equal(sizeBefore, 0, 'precondition: file is empty');

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0);

    const after = readIfExists(pendingFile);
    assert.ok(after, '.pending-scan must exist after hook');
    assert.match(after.trim(), TS_RE);
  });

  // Test G: corrupted UTF-8 in `.pending-scan` (binary noise from a
  // power-loss-during-write). `_existing =~ TS_RE` is false, rewrite
  // fires. Must not propagate the corrupt bytes nor crash the hook
  // (regex matching in bash 3.2 on non-UTF-8 has been a subtle source
  // of hook-budget overruns).
  it('G: corrupt `.pending-scan` bytes → overwritten cleanly', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    fs.writeFileSync(pendingFile, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90]));

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0, `hook must tolerate corrupt pending: ${r.stderr}`);

    const after = readIfExists(pendingFile);
    assert.ok(after, '.pending-scan must exist');
    assert.match(after.trim(), TS_RE);
    // Belt-and-suspenders: confirm no binary noise survived in the
    // rewritten file (the timestamp regex alone would pass even if
    // junk preceded the timestamp on a separate line — but TS_RE is
    // anchored ^...$ with no trailing leniency).
    for (const ch of after.trim()) {
      assert.ok(
        ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f,
        `unexpected non-printable byte in rewritten .pending-scan: ${after}`,
      );
    }
  });

  it('H: invalid wiki-local policy → hook stays silent and does not advance pending-scan', () => {
    setup = setupHermeticVault();
    const pendingFile = path.join(setup.wikiRoot, '.wiki-meta', '.pending-scan');
    fs.writeFileSync(
      path.join(setup.wikiRoot, '.wiki-meta', '.config.json'),
      '{"auto_ingest":{"ignore_globs":[1]}}\n',
      'utf8',
    );

    const r = runHook(setup.tmp);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(readIfExists(pendingFile), null);
  });
});
