'use strict';

// Test-isolation helper for scan-vault-changes.sh (deep-wiki SessionStart hook).
//
// **Why this exists** — scan-vault-changes.sh reads its wiki config from
// `$HOME/.claude/deep-wiki-config.yaml` and walks `$wiki_root`'s parent
// directory. Without an isolated HOME, a developer's interactive shell or
// a CI runner would:
//
//   (a) Read the developer's REAL `~/.claude/deep-wiki-config.yaml` and
//       scan their REAL vault — leaking host filesystem state into the
//       test process, and worse, potentially overwriting the user's
//       `.wiki-meta/.pending-scan` timestamp.
//   (b) Inherit env vars (HOME, CLAUDE_PROJECT_DIR, …) that could
//       redirect output channels mid-run.
//
// Pattern mirrors deep-work's `hooks/scripts/test-helpers/run-phase-guard.js`
// (M5.5 #3, deep-work PR #29) — explicit env scrub + tmpRoot HOME override
// so a single regression in host-env handling fails loud across all
// fixtures.
//
// Spec: claude-deep-suite/docs/superpowers/plans/
//         2026-05-12-m5.5-remaining-tests-handoff.md §2 #3

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCRIPT = path.resolve(__dirname, '..', 'scan-vault-changes.sh');

// Verified consumer list (grep hooks/scripts/scan-vault-changes.sh as of
// v1.5.0). Update this list AND the comment block above when a new consumer
// of a host-leakable env var is added or removed — a stale list silently
// weakens isolation.
const HOST_LEAK_VARS = [
  'HOME',                  // CONFIG path anchor — line 14 of scan-vault-changes.sh
  'CLAUDE_PROJECT_DIR',    // forward-compat redirect (not consumed yet, scrubbed pre-emptively)
  'DEEP_WIKI_ROOT',        // forward-compat redirect
];

/**
 * Return a copy of process.env with the known host-leak vars removed,
 * then merged with caller-supplied overrides. Use this in tests that
 * spawn the scan-vault hook through a non-standard pattern (e.g. piped
 * shell wrappers) where the high-level runScanVault wrapper does not fit.
 *
 * @param {object} extra — env vars to merge AFTER scrub (test-specific)
 * @returns {object}
 */
function scrubHostEnv(extra = {}) {
  const scrubbed = { ...process.env };
  for (const k of HOST_LEAK_VARS) delete scrubbed[k];
  // PATH is preserved (we need `find`, `awk`, `stat`, `date`).
  return { ...scrubbed, ...extra };
}

/**
 * Spawn scan-vault-changes.sh under hermetic test isolation.
 *
 * Required setup the helper performs:
 *   1. Materialize `<homeDir>/.claude/deep-wiki-config.yaml` from the
 *      caller-supplied YAML string (only if `configYaml` is provided —
 *      omit to exercise the "no wiki configured" branch).
 *   2. Set HOME=homeDir (so the hook's `$HOME/.claude/...` lookup hits
 *      the tmpdir instead of the developer's real config).
 *   3. Merge any caller-supplied env on top of the scrubbed base.
 *
 * The caller is responsible for materializing the vault tree + setting
 * file mtimes via `fs.utimesSync` — `vaultRoot` is informational here
 * (the YAML config carries the canonical `wiki_root` path).
 *
 * @param {object} opts
 * @param {string} opts.homeDir         — tmpdir that becomes $HOME for the hook
 * @param {string} [opts.configYaml]    — YAML to write at $HOME/.claude/deep-wiki-config.yaml
 * @param {object} [opts.env]           — extra env vars (merged AFTER scrub)
 * @param {string} [opts.script]        — defaults to scan-vault-changes.sh
 * @param {number} [opts.timeout]       — defaults to 15000ms (matches hook budget)
 * @returns {{status:number,stdout:string,stderr:string,signal:string|null,error:Error|undefined}}
 */
function runScanVault({
  homeDir,
  configYaml,
  env: extraEnv = {},
  script = DEFAULT_SCRIPT,
  timeout = 15000,
} = {}) {
  if (!homeDir) {
    throw new Error('runScanVault: homeDir is required (use mkdtempSync output)');
  }

  // Always create $HOME/.claude/ so the hook's `[ ! -f "$CONFIG" ]` check
  // sees a real dir — even when configYaml is intentionally omitted (to
  // exercise the silent-skip branch on missing config).
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  if (typeof configYaml === 'string') {
    fs.writeFileSync(
      path.join(claudeDir, 'deep-wiki-config.yaml'),
      configYaml,
      'utf8',
    );
  }

  const env = scrubHostEnv({
    HOME: homeDir,
    ...extraEnv,
  });

  return spawnSync('bash', [script], {
    cwd: homeDir,
    env,
    encoding: 'utf8',
    timeout,
  });
}

/**
 * Parse the file list from scan-vault-changes.sh stdout.
 *
 * Output shape (from script lines 429-436):
 *   [deep-wiki] N개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.
 *
 *   자동 ingest 대상:
 *
 *     - foo/bar.md
 *     - baz.md
 *     ...
 *
 *   이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. ...
 *
 * The script emits each entry as `  - <relpath>` (two leading spaces, dash,
 * space). We extract every such line. The header "N개의" can be parsed
 * separately via parseHookHeader if needed.
 *
 * @param {string} stdout
 * @returns {{count:number|null, files:string[], hasHeader:boolean}}
 */
function parseHookOutput(stdout) {
  const result = { count: null, files: [], hasHeader: false };
  if (!stdout) return result;

  // Header: "[deep-wiki] N개의 새로운/수정된 파일이..."
  const headerMatch = stdout.match(
    /\[deep-wiki\]\s+(\d+)개의\s+새로운\/수정된\s+파일이/,
  );
  if (headerMatch) {
    result.hasHeader = true;
    result.count = Number(headerMatch[1]);
  }

  // File list lines: `  - <relpath>` — note `echo -e` materializes the `\n`
  // escapes from the script's FILE_LIST builder. We accept any leading
  // whitespace defensively (in case the printf shape ever shifts).
  const lines = stdout.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!m) continue;
    const entry = m[1];
    // Skip the "... and N more" continuation line emitted past 20 files.
    if (/^\.\.\.\s+and\s+\d+\s+more$/.test(entry)) continue;
    result.files.push(entry);
  }

  return result;
}

module.exports = {
  scrubHostEnv,
  runScanVault,
  parseHookOutput,
  HOST_LEAK_VARS,
  DEFAULT_SCRIPT,
};
