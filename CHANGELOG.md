# Changelog

All notable changes to deep-wiki are documented here.

## [1.7.0] — 2026-05-22 (large-wiki reader race fix + index.md dashboard redefinition + inbox stale cleanup)

### Fixed

- **`hooks/scripts/read-index-envelope.js` stdout truncation race** — `process.stdout.write()` followed by `process.exit(0)` could exit before the OS pipe buffer drained (Node.js documented behavior when stdout is piped). On 401-page wikis (~250KB envelope payload), this caused nondeterministic truncation of the reader's stdout. The reader is called from `wiki-ingest` Step 2 / Step 9 and from `wiki-rebuild` / `wiki-query` / `wiki-lint`, so truncation could trigger duplicate-page creation (overlap pre-filter wrong) or silent page-loss on index merge. Fix: pass a callback to `process.stdout.write(..., cb)` and call `process.exit(0)` only after the callback fires (flush complete). Small wikis behave identically because the callback fires synchronously when the buffer is empty. Discovered during a 401-page wiki dogfood ingest.

### Changed (spec)

- **`skills/wiki-ingest/SKILL.md` Step 11 — `index.md` redefined as a dashboard.** The previous contract required a full LLM-authored catalog rewrite every ingest, infeasible above ~100 pages (50K+ output tokens) and silently SKIPped in practice, leaving `index.md` chronically stale. The new contract treats `index.md` as a lightweight, always-fresh dashboard: 1-paragraph wiki overview, At-a-glance stats (pages / tags / last ingest / last catalog refresh), Recent activity (last 7 days from `log.jsonl`, expanded from `pages_created`/`pages_updated` arrays), Top 15 tags with 1-sentence descriptions, and an opt-in Featured pages section (frontmatter `featured: true`, lex-sorted, capped at 30, code-derived first-sentence summary). The full machine-readable catalog continues to live in `.wiki-meta/index.json`; chronological history continues to live in `log.jsonl`. Token budget per ingest: ~3-5 KB input / ~3-5 KB output, stable regardless of wiki size. On the first 1.7.0 ingest, the pre-existing `index.md` is auto-backed-up to `<wiki_root>/.wiki-meta/.backups/index.md.pre-1.7.0` (idempotent) before being overwritten — protects users who hand-curated their legacy catalog. `.backups/` is new in v1.7.0 and is NOT subject to `wiki-lint`'s `excess_versions` auto-fix (which prunes `.versions/` to `keep: 3`).
- **`CLAUDE.md` Storage layout** — `index.md` description updated from "LLM-written human-readable catalog" to "LLM-written human-readable dashboard". Lifecycle actions, Critical invariants, and other schema sections unchanged.

### Added

- **`skills/wiki-ingest/SKILL.md` Step 0.5 — inbox stale cleanup with `partial_fail` protection.** Inserted between the Prerequisites block (which sets `WIKI_ROOT`) and Step 1 (Identify Sources). Runs **without the wiki lock held** — safety via a 7-day mtime threshold AND explicit exclusion of inbox files referenced by an unresolved `partial_fail:` sentinel in `<wiki_root>/.wiki-meta/sources/*.yaml`. Step 12's "self-session files only, no wildcard" policy is preserved; Step 0.5 is the safety net for the crashed-session case Step 12 cannot cover, while honoring text-source partial-fail retry state regardless of operator absence. Bash 3.2 portable: GNU `stat -c %Y` first + BSD `stat -f %m` fallback + numeric guard against the Linux gotcha where `stat -f` returns filesystem metadata with exit 0.
- **`hooks/scripts/read-index-envelope.test.js`** — F1 regression. Synthesizes a 500-page envelope (with a valid ULID `run_id` via `envelope.js`), runs the reader via `spawnSync` (triggers piped-stdout code path), parses captured stdout, asserts `pages.length === 500`. Post-fix: always passes.
- **`tests/inbox-cleanup.test.js`** — F3 regression. Three scenarios: 8-day-old file removed, 1-day-old file preserved, 8-day-old file preserved when its `origin:` is referenced by a `partial_fail:` sentinel. Bash body is passed via `execSync('bash', { input, env: { WIKI_ROOT } })` (stdin + env), avoiding the outer `/bin/sh -c` parameter-expansion trap.
- **`package.json` `scripts.test`** — switched from explicit file enumeration to **bare `node --test`** (Node 20+ default recursive discovery from cwd, auto-skips `node_modules/`). Future `*.test.js` files anywhere in the repo are picked up automatically.

### Why this matters

All three findings only surface on wikis at scale (this followup was driven by a 401-page dogfood) — small wikis never hit them because (a) reader stdout stays under the OS pipe buffer, (b) `index.md` rewrite stays within feasible token budgets, and (c) inbox files don't accumulate enough generations to be visible. As deep-wiki adoption grows toward Karpathy's "wiki as the artifact" vision, the v1.7.0 fixes are prerequisite for healthy long-running wikis.

### Verification

- `npm test` passes — 130 tests (127 pre-change + 3 new in `tests/inbox-cleanup.test.js`; F1 regression added 1 to `hooks/scripts/`).
- `node scripts/validate-envelope-emit.js tests/fixtures/sample-index.json` clean.

### Known limitations

- Large-wiki acceptance test ("trigger an ingest on a real 401+ page wiki, confirm `read-index-envelope.js | jq '.pages | length'` returns correct count repeatedly, `index.md` regenerates as a dashboard with all sections present, `.wiki-meta/.inbox/` contains no files older than 7 days") requires a 401-page wiki environment not present in CI and not reproducible by every developer. Treated as a post-release dogfood checklist rather than a release-blocking verification step.
- Dashboard regeneration failures in the SessionStart auto-ingest hook path are stderr-only and effectively silent (hook runner discards stderr after the 15-second timeout). Operators discover stale dashboards organically when opening `index.md` in Obsidian. Schema-additive `dashboard_regen_failed:` field is deferred to a future release.

### Version sync

- `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `package.json` bumped 1.6.2 → 1.7.0.
- deep-suite marketplace `sha` and `description` updated post-merge per CLAUDE.md "CRITICAL — Plugin Update Workflow".

## [1.6.2] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- **`.codex-plugin/plugin.json`** — Codex-native plugin manifest pointing at the same skill and hook surfaces as the Claude Code manifest while preserving the existing `claude-deep-*` repository identity.
- **`AGENTS.md`** — Codex project guide covering runtime surfaces, verification commands, and the downstream suite marketplace update requirement.

### Changed

- Version bumped 1.6.1 → 1.6.2 across package and plugin manifests for a patch release.
- README documentation now calls out Codex compatibility alongside the existing Claude Code surface.

### Verification

- Repository validation was run before release; see the PR checklist for the exact command output.

## [1.6.1] — 2026-05-18 (Codex strict-YAML parse fix for wiki-setup description)

### Fixed

- **`skills/wiki-setup/SKILL.md` frontmatter description** — wrapped in double quotes + escaped internal `"` characters + rewrote `(A: inside an Obsidian vault, B: standalone directory)` to `(option A — inside an Obsidian vault, option B — standalone directory)` to remove the `A: ` / `B: ` colon-space hazard that broke Codex's strict YAML parser. Codex was emitting `⚠ invalid YAML: mapping values are not allowed in this context at line 2 column 524` and silently dropping the wiki-setup skill at load time. Claude Code's lenient YAML parser accepted the unquoted form; Codex's strict parser did not. Description content unchanged; only YAML quoting + the inner `A:/B:` colon-space pattern restructured.

### Why this matters

- The v1.6.0 conversion preserved the original `commands/wiki-setup.md` description as an unquoted plain YAML scalar. Plain scalars containing `: ` (colon-space) are ambiguous in YAML 1.1 — strict parsers (yaml-rust, used by Codex) reject them as "mapping values not allowed in this context"; lenient parsers (PyYAML, used by some Claude tooling) accept them. The fix matches the convention already used by the 24 deep-work v6.7.0 entry skills (always-quoted descriptions) and restores Codex cross-platform parity.
- Defensive scan across all 6 deep-suite plugins confirmed wiki-setup was the sole skill with this hazard.

### Version sync

- `.claude-plugin/plugin.json` + `package.json` bumped 1.6.0 → 1.6.1 (2-way sync).

## [1.6.0] — 2026-05-18 (5 commands → user-invocable skills: cross-platform)

### Changed

- All 5 `/wiki-*` slash commands promoted to `user-invocable: true` skills under `skills/wiki-{ingest,lint,query,rebuild,setup}/SKILL.md`. The `commands/` directory is removed.
- Each entry skill gains 3 new head sections — `## Invocation` (Claude Code slash + cross-platform `Skill({ skill: "deep-wiki:wiki-<verb>", args: "..." })`), `## Inputs (skill args)` (token matrix per command), and `## Prerequisites` (sibling skill relationship + cross-platform self-containment note + the original `~/.claude/deep-wiki-config.yaml` / `wiki-schema` load step).
- Frontmatter `allowed-tools:` keys removed (skills do not declare tool whitelists); replaced by `name:` + bilingual `description:` (Korean + English trigger phrases, third-person voice) + `user-invocable: true`. No `version:` field on SKILL.md (mirrors deep-docs / deep-evolve pilot pattern).
- Body content for each entry skill is byte-equivalent to the prior `commands/wiki-*.md` (mechanical copy via `cp`, then in-place `sed` retargeting of `commands/wiki-*.md` cross-references to `skills/wiki-*/SKILL.md`). Step / Gate / Section headers and bash blocks preserved verbatim — no semantic changes to the ingest / lint / query / rebuild / setup procedures.
- Cross-reference updates outside `commands/` (≈20 spots) — `agents/wiki-synthesizer-{analysis,inline}.md`, `hooks/scripts/{scan-vault-changes.sh, wrap-index-envelope.js}` comment headers, `skills/wiki-schema/{SKILL.md, wiki-schema.yaml}` enforcement-spot text, `tests/envelope-chain.test.js` mirror comments, `CLAUDE.md` directory tree + FAQ. `scripts/v0-probe/*` and historical `CHANGELOG` entries deliberately left as-is (line-pinned historical references).
- `.claude-plugin/plugin.json` + `package.json` version: 1.5.3 → 1.6.0; both descriptions augmented with "5 skill-based entry surfaces (cross-platform)".

### Rationale

Slash commands are Claude Code only. Skills are portable across Codex CLI, Copilot CLI, Gemini CLI, and the Agent SDK via `Skill({ skill: "deep-wiki:<verb>", args: "..." })`. This is the third installment of the suite-wide command-to-skill migration after deep-docs v1.3.0 (1 command, pilot) and deep-evolve v3.4.0 (1 command, second installment). deep-wiki is the largest single conversion in the suite — 5 entry surfaces simultaneously (4,062 lines total; `wiki-ingest` alone is 2,841 lines), all converted atomically because the 5 commands cross-reference each other (ingest recommends lint, query auto-files a new page as a side effect of ingest semantics, lint enforces the same `pages_created` exactly-once invariant the others emit, etc.) — partial conversion would leave some surfaces callable cross-platform and others Claude-Code-only.

### Migration

- Claude Code users: no change. `/wiki-setup`, `/wiki-ingest`, `/wiki-lint`, `/wiki-query`, `/wiki-rebuild` continue to work — Claude Code auto-discovers `user-invocable: true` skills as slash commands. The SessionStart auto-ingest hook (`scan-vault-changes.sh`) also continues working unchanged (it never invoked the slash command by name; it just emits a system-reminder advising `/wiki-ingest`, which the model now resolves to the skill).
- Codex / Copilot CLI / Gemini CLI / Agent SDK users: invoke as `Skill({ skill: "deep-wiki:wiki-ingest", args: "<source>" })` etc. The argument syntax is identical (no `$ARGUMENTS` placeholder existed; arguments were already taken as natural-language prose by each command).
- The `wiki-schema` reference skill at `skills/wiki-schema/` is unchanged and still loaded by description-matching auto-discovery; the 4 critical invariants enforcement text now points at `skills/wiki-*/SKILL.md` paths instead of `commands/wiki-*.md`.

### Tests

`npm test`: 126/126 pass. No production-code changes; node:test files (`envelope-emit`, `envelope-chain`, `auto-ingest-golden`, `pending-scan-recovery`) only had comment-level `// Mirror commands/wiki-…md …` retargeting to `// Mirror skills/wiki-…/SKILL.md …`. Assertion logic unchanged.

### Notes

- No `version:` field on entry-skill frontmatter (per deep-docs / deep-evolve pattern; skill-reviewer prefers minimal frontmatter).
- Body byte-equivalence for `wiki-ingest` was the riskiest preservation surface (2841 lines, many spec-pinned Step / Gate / phase-timing telemetry references). The `cp` + `sed` + targeted `Edit` approach kept the 6 internal self-references at lines 389 / 1914 / 1923 / 1933 / 1939 / 2356 mechanically retargeted only.
- `scripts/v0-probe/` historical probe docs deliberately keep `commands/wiki-ingest.md:1088-1099`-style line-pinned references — those documents are time-stamped artifacts of v1.4.x.

## [1.5.3] — 2026-05-13 (metadata — SKILL.md description length)

### Fixed

- `skills/wiki-schema/SKILL.md` frontmatter `description` exceeded the Claude Code 1024-character cap (1077 chars), surfaced as `invalid description: exceeds maximum length of 1024 characters` warning when loading the cached plugin from the deep-suite marketplace. Trimmed verbose phrasing ("This skill defines …" → "Defines …", "It should be activated whenever …" → "Activate whenever …", per-slash-command qualifier prose collapsed) while preserving every trigger keyword (all 5 slash commands, all 10 lifecycle actions, the 4 critical invariants, every storage-layout path). New length: 978 chars.

### Changed

- `.claude-plugin/plugin.json` + `package.json` version: 1.5.2 → 1.5.3.

### Notes

Metadata-only patch. Production code, tests, hooks, agents, commands, and skill body all unchanged. Test count unchanged (126).

## [1.5.2] — 2026-05-12 (M5.5 #5 pending-scan recovery test)

### Added — `.pending-scan` recovery integration test

New `tests/pending-scan-recovery.test.js` (7 node:test cases) pins the `.pending-scan` contract of `hooks/scripts/scan-vault-changes.sh` against artificially-dangled state. Hermetic via `HOME=tmpRoot` + tmpRoot config — never touches the user's real `~/.claude/deep-wiki-config.yaml` or real vault.

- A: invalid `.pending-scan` content (non-ISO-8601) → overwritten with fresh timestamp, hook does not crash.
- B: valid `.pending-scan` → **preserved verbatim** across hook fires (H1 regression guard from ultrareview bug_006 — every-fire overwrite would erase the oldest-detection-window lower bound).
- C: dangling `.pending-scan` older than `.last-scan` → both preserved, hook does not crash (wiki-lint Step 11 State B test target).
- D: no `.last-scan` + valid `.pending-scan` → pending used as LAST_SCAN + preserved.
- E: fresh install (neither file) → hook creates `.pending-scan` with current ISO-8601 timestamp.
- F: empty `.pending-scan` (truncate crash mid-write) → overwritten with valid timestamp.
- G: corrupt UTF-8 bytes in `.pending-scan` → overwritten cleanly, no non-printable bytes survive.

This file is the executable companion to wiki-lint.md Step 11 / 12 stale-detection-and-fix protocol (which is a markdown protocol Claude follows, not directly testable). The hook is the upstream half that must tolerate stale state until the next `/wiki-lint --fix`.

Test count: 119 → 126 (+7). Production code unchanged.

### Changed

- `.claude-plugin/plugin.json` + `package.json` version: 1.5.1 → 1.5.2.
- `package.json` `scripts.test` glob: added `tests/pending-scan-recovery.test.js`.

### Notes

Stacked on PR #15 (M5.5 #3 scan-vault-changes auto-ingest golden, v1.5.1).

Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #5 (deep-wiki row).

## [1.5.1] — 2026-05-12

**M5.5 #3 hook golden test** — pins `hooks/scripts/scan-vault-changes.sh`
(SessionStart auto-ingest detection) behavior on a fixture corpus so the
contract (detected count, file list, exit code, `.pending-scan`
preservation) is regression-protected. Tests-only release; no plugin
behavior change.

Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #3.
Reference implementation: `claude-deep-work` PR #29 (phase-guard golden).

### Added

- **`hooks/scripts/test-helpers/run-scan-vault.js`** — hermetic test
  helper. Exports `scrubHostEnv()` (removes HOME, CLAUDE_PROJECT_DIR,
  DEEP_WIKI_ROOT so the developer's real `~/.claude/deep-wiki-config.yaml`
  + vault cannot leak into the test process), `runScanVault()` (spawns
  the hook with `HOME=tmpRoot`, materializes the YAML config inside
  tmpRoot/.claude/), and `parseHookOutput()` (extracts the file list
  and Korean header count from stdout). Pattern mirrors deep-work's
  `run-phase-guard.js` (M5.5 #3, deep-work PR #29).
- **`tests/auto-ingest-golden.test.js`** — node:test driver. Discovers
  `tests/fixtures/golden/<name>.{input,expected}.json` pairs, fails
  loud on half-commits, materializes each fixture's `vault_tree` into a
  tmpdir, applies `mtime_offsets` via `fs.utimesSync` for deterministic
  mtime-comparison tests, pre-seeds `.last-scan` / `.pending-scan` if
  requested, then asserts exit code + header count + expected/forbidden
  file sets + `pending_scan_preserved`.
- **`tests/fixtures/golden/`** — 8-scenario corpus covering:
  1. Empty vault → silent exit
  2. 3 new .md files → all detected
  3. `.obsidian/` + `.trash/` excluded (find prune)
  4. Files older than `.last-scan` filtered (mtime comparison branch)
  5. `auto_ingest.require_tag: project` → only tagged files pass
  6. `auto_ingest.ignore_globs: [archive/**]` → archive subtree excluded
  7. No `deep-wiki-config.yaml` → silent exit (CONFIG-missing branch)
  8. Valid existing `.pending-scan` is preserved verbatim (not advanced)
- **`tests/fixtures/golden/README.md`** — fixture schema reference.
  Documents `${VAULT_ROOT}` / `${WIKI_ROOT}` template substitution in
  `config_yaml`, `mtime_offsets` semantics, and the assertion catalog.

### Deviation from deep-work reference

- deep-work's golden assertions parse a stdout JSON `{decision, reason}`
  object; scan-vault-changes.sh emits a free-form Korean system message
  instead. Switched to header-count regex extraction + file-list line
  parsing (`parseHookOutput`).
- Added `mtime_offsets` and `${VAULT_ROOT}` / `${WIKI_ROOT}` template
  substitution to the input schema because vault-fixture mtime control
  is intrinsic to this hook (find + stat-mtime comparison), unlike
  phase-guard which is stateless.
- The Obsidian CLI path (`obsidian recents` supplement at lines
  193-250) is NOT exercised here — the helper does not put `obsidian`
  on PATH, so `command -v obsidian` returns empty and the recents
  branch is naturally skipped. Adding obsidian-cli golden tests would
  require a mock shim; out of scope for M5.5 #3.

### Changed

- `package.json`: `test` script now includes `tests/auto-ingest-golden.test.js`.
- `package.json` + `.claude-plugin/plugin.json`: version `1.5.0` → `1.5.1`.

### Test count

- Before: 111
- After: 119 (+8 golden fixtures)

## [1.5.0] — 2026-05-11

**M3 envelope adoption** — `<wiki_root>/.wiki-meta/index.json` is now wrapped
in the M3 cross-plugin envelope (cf.
[claude-deep-suite/docs/envelope-migration.md](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/docs/envelope-migration.md)
§1). The legacy `{pages, generated_at}` shape is preserved verbatim inside
`payload`; consumers use the envelope-aware reader to get the legacy shape
back regardless of whether the file is v1.5.0+ envelope-wrapped or pre-1.5.0
legacy.

This is the **6th and final** of the M3 Phase 2 plugin migrations. After
this merge, suite-side Phase 3 (marketplace.json SHA bump, payload-registry
schema replacement, adoption ledger) is unblocked.

### Why envelope

- **Cross-plugin trace**: every emit carries a ULID `run_id` + optional
  `parent_run_id` chain — M4 telemetry / Phase 3 dashboard can reconstruct
  cross-plugin lineage.
- **Producer attribution**: `producer = "deep-wiki"`, `producer_version`
  mirrors `plugin.json.version` (single source of truth).
- **Schema drift detection**: `schema.name = "index"`, `schema.version =
  "1.0"`; identity guards (handoff §4 round-4) reject foreign envelopes
  at read-time.
- **Reproducibility**: `git.{head,branch,dirty}` snapshot + `provenance.
  tool_versions` snapshot.
- **Multi-source aggregator**: pages contribute to
  `provenance.source_artifacts[]` path-only (markdown — no envelope
  detect). `parent_run_id` is omitted by default — index.json has no
  single parent artifact.

### Added

- **`hooks/scripts/envelope.js`** — shared zero-dep library: ULID generator
  (MSB-first Crockford Base32), `detectGit`, `loadProducerVersion`,
  `wrapEnvelope`, `unwrapEnvelope`, `isEnvelope`, `isValidEnvelope`.
  Producer version is read from `.claude-plugin/plugin.json` relative to
  the module file (literal-cwd-resolve — handoff §4 deep-docs round-1
  lesson) so the helper works regardless of which directory the agent
  invokes it from.
- **`hooks/scripts/wrap-index-envelope.js`** — CLI writer. Wraps a payload
  JSON file into envelope form and atomically writes to
  `<wiki_root>/.wiki-meta/index.json` (temp + rename — handoff §4 deep-work
  round-1 C1 lesson). Supports `--source-page` (repeatable, path-only for
  markdown pages) and generic `--source-artifact path[:run_id]` with
  self-consistency auto-harvest (handoff §4 deep-evolve round-1 W4
  lesson). Forward-compat `--parent-run-id` accepts only ULIDs at the CLI
  boundary (defense-in-depth — handoff §4 deep-evolve round-1 C3 lesson).
- **`hooks/scripts/read-index-envelope.js`** — CLI reader. Emits the legacy
  `{pages, generated_at}` shape on stdout whether the input is v1.5.0+
  envelope-wrapped or pre-1.5.0 legacy. Identity guards reject foreign or
  corrupt envelopes with exit 1.
- **`scripts/validate-envelope-emit.js`** — release-lint validator. Mirrors
  the suite envelope schema without external deps: `additionalProperties:
  false` on every nested object, ULID/SemVer 2.0.0/RFC 3339/kebab-case
  regex, identity check (producer=deep-wiki, artifact_kind=index,
  schema.name=index), corrupt-payload defense.
- **`tests/envelope-emit.test.js` + `tests/envelope-chain.test.js`** —
  Node test runner. 87+ tests covering wrap roundtrip, identity gates,
  parseArgs boundary (scalar + repeatable empty-value rejection, deep-review
  round-1 Q6 lesson), atomic-write residue check, envelope-aware reader
  legacy pass-through, multi-source aggregator contract (no parent_run_id,
  source_artifacts path-only).
- **`tests/fixtures/sample-index.json`** — release sample emit. Phase 3
  uses this as input when replacing the placeholder schema at
  `claude-deep-suite/schemas/payload-registry/deep-wiki/index/v1.0.schema.json`.
- **`package.json`** — `npm test` runs the envelope test suite, `npm run
  validate-fixture` validates the sample fixture.

### Changed

- **`commands/wiki-setup.md`** — Step 3 scaffold now invokes
  `wrap-index-envelope.js` instead of writing a literal JSON. Caller
  contract: set `WIKI_ROOT` before invoking the snippet (deep-evolve
  round-2 R2-3 self-containedness lesson).
- **`commands/wiki-rebuild.md`** — Step 3 documents the envelope-wrap
  contract, the multi-source `--source-page` repeatable flag, and a
  bash-only fast-path (deep-work round-1 W6 lesson) for hot-path
  envelope detection without spawning per-file Node processes.
- **`commands/wiki-ingest.md`** — Step 2 (Read Existing Wiki State) and
  Step 9 (Update Index) read/write via envelope-aware helpers. The
  in-memory merge logic operates on the unwrapped payload (legacy shape),
  so existing jq pipelines work unchanged.
- **`commands/wiki-query.md`** — Layer 1 Index scan uses
  `read-index-envelope.js`.
- **`commands/wiki-lint.md`** — Step 5 (Duplicate/Alias Conflict) and
  Step 10 (Index Drift Detection) use `read-index-envelope.js`.
- **`skills/wiki-schema/SKILL.md` §Index** — documents the envelope
  wrapper, identity contract, and multi-source aggregator pattern. Both
  legacy and envelope-wrapped examples are shown.

### Compatibility

- **Forward compatibility (v1.5.0+ → consumers reading legacy code)**: the
  envelope-aware reader (`read-index-envelope.js`) emits the legacy
  `{pages, generated_at}` shape on stdout, so existing jq pipelines
  (`.pages[].file`, `.generated_at`) work without modification.
- **Backward compatibility (pre-1.5.0 → user wikis with legacy
  index.json)**: the reader passes legacy input through unchanged. Users
  do not need to run `/wiki-rebuild` after upgrading — existing
  `index.json` files continue to work. Running `/wiki-rebuild` regenerates
  in envelope-wrapped form (no data loss; payload shape is identical).
- **Atomic write**: the writer uses `outputPath + .tmp.<pid>.<Date.now()>`
  → `fs.renameSync` (deep-work round-1 C1 lesson). Mid-write interruption
  cannot leave a truncated index.json.
- **Identity guards**: the reader rejects foreign-producer envelopes
  (e.g., a deep-evolve envelope accidentally at the index.json path) with
  exit 1 — manual recovery is `/wiki-rebuild` which regenerates from page
  frontmatter (the source of truth per skills/wiki-schema/SKILL.md).

### Suite-side coordination (Phase 3, NOT this PR)

T+0 timer recording (suite-side `docs/envelope-migration.md` §6.1
adoption ledger) is intentionally deferred to claude-deep-suite Phase 3
per the Phase 2 §1 policy — all suite-repo changes (marketplace.json SHA
bump, payload-registry schema replacement, adoption ledger update) batch
in a single Phase 3 PR after all six Phase 2 plugin PRs land. See
claude-deep-suite/`docs/superpowers/plans/2026-05-07-m3-phase2-handoff.md`
§1 (handoff "Probe F" cross-repo doc drift lesson).

### Migration

No data migration needed. Existing `index.json` files (legacy shape)
remain readable by v1.5.0 consumers; they get re-wrapped into envelope
form the next time `/wiki-rebuild` or `/wiki-ingest` runs. To force an
immediate migration, run `/wiki-rebuild`.

### Post-impl review fixups (3-way /deep-review round 1, all ACCEPT)

Round 1 (Opus + Codex review + Codex adversarial — all three completed
without timeout) surfaced one CRITICAL (3-way agreement) + three HIGH /
MEDIUM (single-reviewer but real). All fixed before merge.

- **C1 (3-way agreement — `find -printf` GNU-only on macOS BSD)**:
  `commands/wiki-rebuild.md` Step 3 and `commands/wiki-lint.md` Step 10
  used `find ... -printf 'pages/%f\n'`. macOS `/usr/bin/find` (BSD) rejects
  `-printf` as unknown primary; under `set -euo pipefail` +
  `2>/dev/null` + process substitution, the failure was silently swallowed
  → empty `SOURCE_PAGE_ARGS` → envelope emitted with empty
  `provenance.source_artifacts[]` (violates the multi-source aggregator
  contract). Wiki-lint Step 10 silently reported every disk page as drift.
  Verified failure mode on real macOS BSD find. **Fix**: `cd "${WIKI_ROOT}"
  && find pages -maxdepth 1 -name '*.md' -type f` (portable to BSD + GNU).
  Wiki-lint Step 10 uses the symmetric pattern with `sed 's|^\./||'`.
  Added regression test `tests/envelope-chain.test.js` exercising the
  actual bash form end-to-end (3 new tests under "markdown bash snippet
  portability").

- **C2 (Codex review P2#1 — `isEnvelope` rejects envelope missing payload)**:
  Previously `isEnvelope` required `obj.payload !== undefined`. A malformed
  envelope with `{schema_version: "1.0", envelope: {...}}` but no `payload`
  key returned false → unwrapEnvelope fell through to legacy pass-through
  → consumers (e.g. wiki-ingest jq `.pages // []`) received the corrupt
  top-level object and rebuilt the index from an empty page set (silent
  corruption). **Fix**: `isEnvelope` now detects envelope shape based on
  `schema_version + envelope` only (payload key may be absent);
  `unwrapEnvelope`'s corrupt-payload guard now also rejects `undefined`
  alongside `null`/array/non-object. Reader exit code 1 with stderr
  `corrupt payload: expected object, got undefined`. Added emit + chain
  tests covering the absent-payload-key case.

- **C3 (Codex adversarial #1 HIGH — `/wiki-query` auto-file write path
  bypassed envelope)**: Step 5d Auto-Filing wrote `index.json` directly,
  stripping the envelope wrapper on every successful query synthesis.
  Subsequent envelope-aware reads either missed the entry or saw a stale
  legacy shape. **Fix**: Step 5d now read-merge-writes through
  `read-index-envelope.js` + `wrap-index-envelope.js` (same pattern as
  Step 9 of `/wiki-ingest`), using portable BSD-compatible `find` for
  `--source-page` collection. Lock released on helper failure so the wiki
  is never left locked.

- **C4 (Codex adversarial #2 MEDIUM — `/wiki-lint --fix` raw index edits)**:
  Step 13 `--fix` path described raw add/remove operations against
  `index.json`. **Fix**: Step 13 now delegates to `/wiki-rebuild` (which
  uses the envelope-wrap helper end-to-end) as the recommended form; an
  alternative in-place envelope-aware patch path references the
  `/wiki-ingest` Step 9 + `/wiki-query` Step 5d patterns.

- **W1 (Opus W1 — `CREATED_ENTRIES_JSON`/`UPDATED_ENTRIES_JSON` caller
  contract undocumented)**: `commands/wiki-ingest.md` Step 9 bash snippet
  references `--argjson` variables not previously documented. **Fix**:
  added an explicit caller-contract block above the snippet listing every
  required variable (`WIKI_ROOT`, `CLAUDE_PLUGIN_ROOT`,
  `CREATED_ENTRIES_JSON`, `UPDATED_ENTRIES_JSON`) with a one-line
  reference example for serializing the Step 8 arrays via `jq -s`. Added
  `: "${VAR:?msg}"` guards inside the bash snippet for defense-in-depth.

- **W2 (Opus W2 — bash fast-path heuristic clarity)**: `commands/
  wiki-rebuild.md` fast-path bash detection block now carries an explicit
  "Fast-path heuristic — node helper is authoritative" preamble that
  documents the trade-off (no corrupt-payload defense in the grep-only
  path).

Test status after fixes: `npm test` → **93 pass / 0 fail / ~2.4s** (was
87 pass before fixes; +6 tests covering the round-1 fixes).

### Round-2 review fixups (3-way /deep-review round 2)

Round 2 (Opus + Codex review + Codex adversarial — three reviewers, no
timeouts) confirmed all six round-1 fixes correct AND surfaced six
adjacent issues that were not covered. Monotonic decrease in
criticality (round 1: 1 CRITICAL + 3 HIGH/MEDIUM + 2 WARN; round 2: 0
CRITICAL + 3 HIGH + 3 WARN/INFO). No mission-scope-conflict findings —
no anti-oscillation trigger.

- **R2-1 (Codex adv HIGH-A — malformed envelope block bypass; deepens R1
  C2)**: previous R1 fix addressed payload-missing case but adjacent
  cases (envelope block missing/null/array under `schema_version="1.0"`)
  still fell through legacy pass-through. **Fix**: unified `isEnvelope`
  as marker-only detector (`schema_version === "1.0"` alone); moved
  envelope-block shape validation into `unwrapEnvelope` where it emits
  specific "malformed envelope" stderr. `isValidEnvelope` also re-checks
  envelope-block shape so chain extraction is safe. +3 regression tests
  (envelope-missing, envelope-null, envelope-array).

- **R2-2 (Codex adv HIGH-B — non-index payload wrapped as valid index;
  PARTIAL ACCEPT)**: writer accepted any non-null/non-array object as
  payload. Wrapping a `{}` or `{foo: 'bar'}` produced a structurally-
  valid envelope on disk that read-index-envelope.js unwrapped
  successfully, then consumers' `.pages // []` yielded empty catalog.
  **Fix (defense-in-depth at writer boundary)**: for
  `artifactKind === "index"`, require `payload.pages` to be an array.
  Authoritative payload schema enforcement still lives in
  `claude-deep-suite/schemas/payload-registry/deep-wiki/index/v1.0.schema.json`
  (Phase 3 batch replaces the placeholder); plugin-side check catches
  obvious mis-wrap without duplicating Phase 3 scope. +3 regression
  tests (missing pages, non-array pages, valid empty pages).

- **R2-3 (Codex review P2-A — wiki-ingest §9 jq merge produces duplicate
  index entries)**: in multi-source ingests where two sources touch the
  same page, Step 8 leaves duplicate filenames in `UPDATED_ENTRIES`. The
  Step 9 merge dropped the existing entry once but appended the entire
  `$delta`, producing two `.pages[]` records for the same file → breaks
  index uniqueness, downstream wiki-query / wiki-lint duplicate
  behavior. **Fix**: collapse `$delta` by `.file` via `reverse |
  unique_by(.file)` before merging (UPDATED takes precedence over
  CREATED because it appears last in `$delta_raw`).

- **R2-4 (Codex review P2-B — wiki-ingest auto-lint Step 13 raw edits)**:
  parallel to R1 C4 but lived in `wiki-ingest.md` (different command's
  Auto-Lint section) not `wiki-lint.md` Step 13. **Fix**: same
  delegation pattern — Step 13 auto-fix now points to `/wiki-rebuild`
  (envelope-wrap end-to-end) and references the Step 9 read-merge-write
  pattern for in-place patches.

- **R2-5 (Codex review P3 — validator accepts non-string git.head)**:
  `validate-envelope-emit.js#validateGit` applied the SHA regex only
  when `typeof head === 'string'`, so a numeric or null head passed.
  **Fix**: explicit `typeof !== 'string'` rejection before regex; typed
  error message. +1 regression test (numeric head).

- **R2-6 (Opus W2-1 — wiki-query Step 5d caller-contract + lock leak)**:
  Step 5d (newly added in R1 C3) declared `set -euo pipefail` but only
  guarded `WIKI_ROOT`; `CLAUDE_PLUGIN_ROOT` and `QUERY_FILED_ENTRY_JSON`
  were unguarded. Under `set -u` any unset variable crashed the script
  before reaching the explicit lock-release path → wiki stuck-locked.
  Codex adv MEDIUM #3 flagged the same lock-leak pattern. **Fix**:
  caller-contract block above the snippet listing all three required
  variables (with `QUERY_FILED_ENTRY_JSON` shape `{file, title, tags,
  aliases}`); `${VAR:?msg}` guards for all three; trap-based unconditional
  cleanup (`trap cleanup EXIT`) so the lock is released on every exit
  path including read-helper failure, jq failure, or undefined-variable
  abort.

- **R2-7 (Opus W2-2 — bash 3.2 empty-array foot-gun in SOURCE_PAGE_ARGS)**:
  `"${SOURCE_PAGE_ARGS[@]}"` under `set -u` aborts on macOS `/bin/bash`
  3.2 when the array is empty (e.g. fresh wiki with no pages, scenario
  reachable for `/wiki-setup` or post-prune `/wiki-rebuild`). **Fix**:
  use `${ARR[@]+"${ARR[@]}"}` POSIX-compatible empty-array fallback at
  every helper invocation site (`wiki-rebuild.md` Step 3.b,
  `wiki-ingest.md` §9, `wiki-query.md` Step 5d). +3 regression tests
  exercising bash 3.2 behavior end-to-end.

- **R2-8 (Opus I2-1 — isValidEnvelope coverage symmetry)**: added
  explicit test for `isValidEnvelope` rejecting envelope with absent
  payload key (makes the round-1 invariant fully testable as a triple:
  isEnvelope detects, isValidEnvelope rejects, unwrapEnvelope rejects).

Test status after R2 fixes: `npm test` → **102 pass / 0 fail / ~2.6s**
(was 93 pass after R1 fixes; +9 tests covering R2 fixes).

### Round-3 review fixups (3-way /deep-review round 3)

Round 3 (Opus + Codex review + Codex adversarial — three reviewers, no
timeouts) confirmed all eight round-2 fixes correct and surfaced 3
adjacent lock-lifetime / cross-shell issues that the R2 fixes didn't
cover. Monotonic decrease continues: R1 6 → R2 8 → R3 3. All ACCEPT.
No mission-scope-conflict — no anti-oscillation trigger.

Opus Round 3: APPROVE (8 → 0). Codex Round 3 (review + adversarial)
flagged the 3 issues below (2-way agreement on R3-1).

- **R3-1 (Codex adv #1 + Codex review #1 — 2-way) — wiki-query Step 5d
  trap releases lock BEFORE log.jsonl append**: The R2-6 fix introduced
  `trap cleanup EXIT` that unconditionally rmdir'd the lock when the
  bash block exited. But the `log.jsonl` append happens AFTER the bash
  block (described as a bullet for the agent to execute). Result: on
  success, the lock was released before the log append → a concurrent
  ingest/query could observe the wiki state between index update and
  log entry, and an interrupted log append would leave the index update
  with no audit trail. **Fix**: cleanup() now only rmdirs the lock on
  failure path (`rc != 0`); on success the lock stays held until Step
  5e (after the explicit log append). Critical section semantics:
  index update + log append are now one locked region. +2 regression
  tests covering cleanup-on-success (lock retained) and cleanup-on-
  failure (lock released).

- **R3-2 (Codex adv #2) — wiki-rebuild has no lock cleanup trap**: Step 1
  acquired `.wiki-lock` via `mkdir`, but no trap was registered. If
  the new envelope helper failed (missing node, unset
  CLAUDE_PLUGIN_ROOT, invalid payload JSON, helper IO error), the lock
  was stranded → all subsequent wiki writes blocked until manual
  `rmdir .wiki-meta/.wiki-lock`. Especially dangerous because
  `/wiki-rebuild` is the documented recovery path for corrupt or
  foreign envelopes. **Fix**: register `cleanup_lock` trap immediately
  after `mkdir LOCK_DIR` so every exit path (including envelope helper
  failure) releases the lock. +1 regression test simulating helper
  failure → asserts lock released.

- **R3-3 (Codex review #2) — wiki-rebuild Step 3.a + 3.b split lost
  PAYLOAD_TMP across Bash invocations**: The R1 wiki-rebuild rewrite
  split Step 3 into Step 3.a (build payload) and Step 3.b (envelope
  wrap), each in its own ```bash``` block. The Claude Code Bash tool
  spawns a fresh shell per invocation → `PAYLOAD_TMP` defined in Step
  3.a was undefined in Step 3.b → wrap-index-envelope.js received an
  empty/undefined `--payload-file` value and the empty-rejection
  caller-contract guard aborted the rebuild. **Fix**: merge Step 3.a +
  3.b into a single ```bash``` block (single Bash invocation) so
  `PAYLOAD_TMP` lives through both phases. Added explicit caller-
  contract block for both `WIKI_ROOT` + `CLAUDE_PLUGIN_ROOT`. +1
  regression test exercises the combined block end-to-end (payload
  build + envelope wrap in a single bash session, verifies non-empty
  source_artifacts + clean tmp residue).

R3 fixes: `npm test` → **106 pass / 0 fail / ~2.7s** (was 102 pass
after R2 fixes; +4 R3-specific tests).

### Round-4 review fixups (3-way /deep-review round 4)

Round 4 split-decision review:

- **Opus**: APPROVE, 0 findings, declared convergence.
- **Codex review**: 2 P2 — R4-A (wiki-rebuild Step 1 trap fires too
  early — REGRESSION from R3-2) + R4-B (envelope.git uses process.cwd
  instead of wiki_root, 2-way with Codex adv).
- **Codex adversarial**: 1 HIGH transactional rollback (3rd-occurrence
  of wiki-query atomicity probe class — DEFERRED on anti-oscillation +
  out-of-scope grounds) + 1 MEDIUM same git cwd issue (R4-B).

Decisions: 2 ACCEPT + 1 DEFER. Anti-oscillation §4 invoked for R4-C.

- **R4-A (Codex review #1) — wiki-rebuild Step 1 trap fires too early
  (R3-2 regression)**: R3-2 put `trap cleanup_lock EXIT` inside Step
  1's standalone bash block. Claude Code Bash tool spawns a fresh
  shell per ```bash``` block → the trap fires as soon as Step 1 exits
  → lock released BEFORE Steps 2-5 run → /wiki-rebuild proceeds
  unlocked and a concurrent ingest/rebuild can interleave. Critical
  regression of R3-2 fix introduced by misunderstanding bash-tool
  shell lifecycle. **Fix**: removed trap from Step 1; added
  failure-only cleanup trap INSIDE Step 3 (the mutation block) using
  the same pattern as wiki-query Step 5d (after R3-1). On Step 3
  success: lock kept for Step 6 to release. On Step 3 failure: trap
  releases lock; payload temp preserved for retry (no manual
  `rmdir .wiki-lock` needed).
  +3 regression tests (Step 1 no-trap retains lock; Step 3 failure
  releases lock; Step 3 success keeps lock).

- **R4-B (Codex review #2 + Codex adv #2 — 2-way) — envelope.git uses
  arbitrary process.cwd**: `wrap-index-envelope.js` previously called
  `env.wrapEnvelope({})` without a git override; `wrapEnvelope` fell
  through to `detectGit(process.cwd())`. The agent invokes the CLI
  from arbitrary bash cwd, so envelope.git could record an unrelated
  repo's HEAD/dirty state, undermining audit/recovery value of the
  M3 provenance metadata. **Fix**: derive wiki_root from the
  `--output` path (`<wiki_root>/.wiki-meta/index.json` →
  `path.dirname(path.dirname(outputPath))`); call
  `env.detectGit(wikiRoot)` and pass result to `wrapEnvelope` as
  explicit `git` override. If wiki_root is not a git repo (common —
  Obsidian vault without git), the sentinel `0000000` head + dirty=
  unknown is emitted (correctly signals "no git context", same as
  pre-fix behavior on non-git cwds). +2 regression tests (non-git
  wiki → sentinel; git wiki → wiki's HEAD).

- **R4-C (Codex adv #1, HIGH) — transactional rollback for wiki-query
  auto-file failure**: DEFERRED with explicit reasoning. Codex
  adversarial flagged: if `/wiki-query` Step 5c writes a page but
  Step 5d envelope-helper fails, the page is on disk but not in
  index/log — orphaned state.
  Analysis:
    1. This is pre-existing wiki-query design (pre-1.5.0 had the same
       write-page-first ordering; M3 only changed the index update
       mechanism, not the page-first sequence).
    2. The recovery mechanism is built into the system:
       `wiki-lint` reports "[DRIFT] N unindexed pages" and
       `/wiki-rebuild` regenerates index.json from page frontmatter
       (the source of truth per `skills/wiki-schema/SKILL.md`).
    3. Anti-oscillation §4 trigger: this is the 3rd occurrence of an
       "atomicity probe at wiki-query Step 5d" finding class (R2-6
       lock leak → R3-1 lock lifetime → R4-1 transactional rollback).
       Each previous round addressed a concrete subset; the residual
       (page-write-before-index) is the pre-existing design tradeoff
       that wiki-lint drift detection compensates for.
    4. Implementing transactional rollback (staging directory + atomic
       move-into-place for pages) is significant scope creep beyond
       envelope adoption — would touch every wiki write path in the
       plugin.
  **Decision**: DEFER as out-of-scope + recoverable. Document the
  failure mode in this CHANGELOG block + the convergence stance.
  No code change.

R4 fixes: `npm test` → **111 pass / 0 fail / ~2.5s** (was 106 pass
after R3 fixes; +5 R4-specific tests).

### Convergence summary

After 4 rounds of 3-way /deep-review (Opus + Codex review + Codex
adversarial), all actionable findings resolved:

| Round | Findings | Severity profile |
|---|---|---|
| R1 | 6 | 1 CRITICAL + 3 HIGH/MEDIUM + 2 WARN |
| R2 | 8 | 0 CRITICAL + 3 HIGH + 5 W/I |
| R3 | 3 | 0 CRITICAL + 3 HIGH |
| R4 | 3 (2 ACCEPT + 1 DEFER) | 0 CRITICAL + 2 HIGH + 1 HIGH-deferred |

Monotonic decrease in critical-path findings (1 CRITICAL → 0 → 0 → 0)
and overall actionable findings approaching zero (6 → 8 → 3 → 2). The
R4 DEFER on transactional rollback (anti-oscillation §4) draws the
mission-scope boundary at envelope adoption; the deferred design
question is a candidate for a follow-up issue, not a Phase 2 blocker.

Test status across rounds: 87 → 93 → 102 → 106 → **111 pass** /
0 fail. Coverage spans the full envelope contract (identity guards,
corrupt-payload defense, atomic writes, multi-source aggregator,
markdown bash snippet portability, lock-lifetime correctness, git
context provenance).

## [1.4.2] — 2026-05-07

Patch release closing four v1.4.1 backlog items captured in
`docs/handoff-2026-05-06-v1.4.2.md`. Two are field-issue fixes uncovered
by v1.4.1 cache-active dogfood (F1, F2 deferred from /deep-review round 1
I1); two are deferred quality items (B3 phase telemetry from v1.4.0
plan §10.2; I2 V-2/V-3 probe full-URL match from /deep-review rounds 1+2).
Single-source + multi-source ingest paths are spec-equivalent to v1.4.1
(NOT byte-identical — F1 disk-authoritative read + F2 §3.9 4th invocation
site change the runtime invariants). Wiki schema additive only
(`phase_timing_ms` field in `ingest` log lines; `wiki-lint` Step 6
LOG-INVARIANT scan unaffected).

**Mandatory verbatim known-limitations language carried forward from
v1.4.1 §11.5 (re-stated for transparency):**

- **L1**: V-0 PASS via Mechanism B is best-effort — Claude Code runtime
  does not expose dispatch metadata API. Track C v2 deferred to v1.5.0+
  pending runtime API support. **v1.4.2 addendum:** I2 fix improves
  V-2/V-3 probe fidelity (full-URL allowlist comparison), but the
  empirical SECOND run against v1.4.1 final agent files remains deferred
  (sandbox orchestration workstream); CHANGELOG retains "best-effort"
  framing without empirical addendum until SECOND run completes.
- **L2**: §3.9 dirty-scan covers `<wiki_root>/`-internal mutations only;
  off-root writes (e.g. `/tmp/`) NOT detected. v1.4.0 dogfood failure
  mode (workers writing `/tmp/v140-workers-out/*`) is NOT covered by
  §3.9. v1.4.1 was layered defense-in-depth; v1.4.2 F2 extends bracketing
  to the Stage 1 dispatch (single-source) but does NOT widen the
  off-root scope. Process-level sandboxing remains v1.5.0+ scope.

### Bug fixes

- **F1 (HIGH) — synthesizer `existing_page_body` truncation false-positive
  C3 abort.** v1.4.1 cache-active dogfood (post-`/reload-plugins`)
  observed Stage 1 LLM emitting dramatically-truncated `existing_page_body`
  for update entries (12377 bytes disk → 725 bytes emit; 20071 bytes disk
  → 587 bytes emit). Main computed C3 hash baseline from truncated bytes,
  so Step 7.6.C C3 check always reported "concurrent ingest detected"
  against actual disk bytes — every update aborted. Pre-v1.4.2 contract
  trusted synthesizer's emit; v1.4.2 contract has main re-read pages from
  DISK after Stage 1 returns and use disk bytes as the C3 hash baseline
  AND as the Stage 2 worker / inline-write synthesis context. Subsumes the
  prior P6 round-1 hash-from-emit compute pass — no separate compute
  needed because main reads disk directly. `agents/wiki-synthesizer-analysis.md`
  Rule 4 strengthened to require FULL VERBATIM bytes (defensive contract;
  if synthesizer emits short, main authoritatively recovers from disk).
  Single-source path only — multi-source A4 (workers, not analysis-mode)
  has no `existing_body_hash` field on entries.

  **Post-impl review fixups (3-way /deep-review on the v1.4.2 impl branch
  before merge):**
  - **F1.1 (2/3 reviewer agreement)** — sub-threshold drift escalation.
    Stage 1's `inline_bodies` are generated from the truncated emit
    BEFORE main re-reads disk. Writing those inline_bodies on a drift-
    detected entry would silently corrupt unrelated sections (synthesizer's
    Rule 5 + `preserve_sections` merge logic relied on full prior page
    context). Pre-v1.4.2 caught this LOUDLY via C3 abort; the v1.4.2
    base disk-read recovers the C3 baseline but does NOT restore Stage 1
    synthesis. Fix: when ANY drift detected on a sub-threshold entry,
    force the A5 fanout path so Stage 2 page-writer workers re-synthesize
    each affected page from disk-bytes context. Discards stale
    inline_bodies. Preserves the v1.4.1 LOUD-failure property for affected
    pages while recovering retry-correctness.
  - **F1.2 (2/3 reviewer agreement)** — PARTIAL_FAIL preservation across
    Step 7.6.C reset. F1's gate may populate FAILED_PAGES (basename
    invalid / file absent / disk read failed) and set PARTIAL_FAIL=true
    BEFORE Step 7.6.C runs. The shared atomic-write block resets
    PARTIAL_FAIL=false and only re-toggles based on FAILED_WORKERS (P5
    pattern from v1.4.0). Without preservation, F1-dropped pages are
    logged as failed but never receive the retry sentinel → next session
    skips them. Fix: mirror the P5 pattern for FAILED_PAGES at Step 7.6.C
    entry — `if [[ ${#FAILED_PAGES[@]} -gt 0 ]]; then PARTIAL_FAIL=true; fi`.
  - **F1.3 (single-reviewer Codex P1)** — basename traversal guard.
    F1 gate constructed `page_path="$WIKI_ROOT/pages/${entry.file}"` and
    cat'd it BEFORE the existing Step 7.6.C basename guard. A prompt-
    injected `entry.file = "../../etc/passwd"` would read OUTSIDE
    `<wiki_root>/pages` and place those bytes into Stage 2 / inline-write
    context. Fix: apply `^[a-z0-9][a-z0-9-]*\.md$` regex BEFORE
    constructing page_path (same regex as Step 7.6.B Gate 3.5 + Step
    7.6.C defense-in-depth).
  - **F1.4 + F1.5 (single-reviewer Opus C2 + C3)** — agent doc + CHANGELOG
    precision. Pre-fixup wording claimed "byte-identical Stage 3 hashing"
    and "synthesizer's existing_page_body flows to Stage 2 workers as
    synthesis context." Both are incorrect post-F1: `$(cat …)` strips
    trailing newlines (asymmetric vs. v1.4.1's `printf '%s' "$emit"`
    hashing of compliant agents), and main UNCONDITIONALLY overwrites
    synth bytes with disk bytes before Stage 2 dispatch. Fix: drop
    "byte-identical" claim, document that Stage 3 decisions are equivalent
    via symmetric `$(cat)` byte-stripping; rewrite Rule 4 + field
    semantics so spec accurately reflects synth bytes → telemetry-only
    contract.
  - **R2.F1.6 (2/3 reviewer agreement, 2nd-round /deep-review)** —
    concurrent-ingest baseline race. Pre-R2 fixup F1 size-delta heuristic
    (>4 bytes → escalate) only caught LARGE drifts. Concurrent
    `/wiki-ingest` commits during Stage 1 LLM execution that produce
    same-size byte changes (or truncation patterns within the EOL
    tolerance band) silently became the new C3 baseline → Stage 3 passed
    C3 → our session overwrote the concurrent commit. Fix: replace
    size-delta with HASH-COMPARE between synth's emit and disk read.
    Any byte-level difference triggers F1_DRIFT_DETECTED → force A5
    fanout per F1.1 escalation logic. Stage 2 worker re-synthesizes from
    current disk bytes — concurrent commit's content is preserved as the
    worker's input, our session's source contribution merges on top.
    Closes the T0→T1 (Stage 1 read → F1 cat) silent-window gap.
  - **R2.F1.7 (2/3 reviewer agreement, 2nd-round /deep-review)** —
    all-dropped → terminal ingest-skip bypass. Pre-R2 fixup `len(page_plan)
    == 0` routed unconditionally through `do_ingest_skip_terminal_under_
    lock` which emits `ingest-skip` log line + promotes source as
    accounted for. If F1 dropped ALL update entries (basename invalid /
    page absent / disk read failed), the source got promoted as a clean
    skip without writing the partial_fail sentinel → next session never
    retried → permanent silent failure. Fix: gate empty-page_plan terminal
    skip on FAILED_PAGES being EMPTY. When non-empty (all-F1-dropped),
    route through new `do_all_failed_under_lock` (Step 7.5.B) which
    mirrors Step 7.7.B "all-fail" finalization: acquires lock, writes
    partial_fail sentinel for the source slug, emits `ingest` log line
    with `pages_failed=[F1-dropped]`, does NOT promote `.pending-scan`.

**3rd-round /deep-review fixups (5 critical + 2 warning, all ACCEPT):**

The 2nd-round fixup commit introduced `do_all_failed_under_lock` (novel
~30-line function). 3rd-round /deep-review on this novel code surfaced
5 criticals + 2 warnings — direct regressions in the new code, not in
the v1.4.2 base design.

  - **R3.P2.1 (2/3 reviewer agreement, Codex review P2 + Codex
    adversarial high)** — slug vs. descriptor mismatch. Caller passed
    `SOURCES[0]` (the descriptor encoding `slug|origin|type`) where
    function expected `slug`. Result: yaml path constructed as
    `<wiki>/.wiki-meta/sources/<slug|origin|type>.yaml` → wrong path
    → partial_fail sentinel never landed at canonical location → Step
    1.5's partial-fail-recovery cascading detection missed. Fix: caller
    extracts slug via `slug="${SOURCES[0]%%|*}"` before invocation.
  - **R3.P2.2 (2/3 reviewer agreement, Codex review P2 + Codex
    adversarial medium)** — 3-strike retry counter missing. Step 7.5.M-D
    multi-source path has the `<wiki>/.wiki-meta/.pending-scan-retry-count`
    counter for stuck-window recovery (`ingest-fail` action emits on 3rd
    consecutive same-window failure + promotes `.pending-scan`).
    `do_all_failed_under_lock` did not increment this counter, so a
    persistent F1 all-drop scenario (e.g., synthesizer hallucinating
    absent pages repeatedly) loops indefinitely. Fix: mirror Step 7.5.M-D
    pattern — read counter, increment, emit `ingest-fail` + promote on
    count≥3, otherwise emit `ingest` with `pages_failed`.
  - **R3.C-1 (single-reviewer Opus)** — `mkdir … exit 1` mishandling.
    Pre-R3 fixup `mkdir … || { echo "Wiki locked"; exit 1; }` would
    terminate the script before the caller's user-facing exit message
    AND before any partial_fail signal could be written for benign
    concurrent-ingest cases. Fix: soft-fail with `if ! mkdir … 2>/dev/null;
    then echo WARN; return 1; fi`. Plus added `trap - EXIT` after explicit
    rmdir (mirror Step 7.7.B + Step 7.6.G pattern).
  - **R3.C-2 (single-reviewer Opus)** — first-ingest baseline yaml
    materialization missing. Step 7.7.B's R4-Adv-Adv-2 fix explicitly
    materializes a baseline yaml when the source's yaml does not exist
    yet (brand-new source whose first ingest hits all-fail).
    `do_all_failed_under_lock` claimed to mirror Step 7.7.B but was
    missing this block — first-ingest all-F1-dropped would produce a
    yaml with only the partial_fail block, missing `id/type/origin/
    content_hash/pages_created/pages_updated`. Fix: inline the same
    baseline materialization block at function entry.
  - **R3.C-3 (single-reviewer Opus)** — `FAILED_PAGE_FILES` parallel
    array population. F1 loop pushed only `FAILED_PAGES`; the function
    body's `printf '%s\n' "${FAILED_PAGE_FILES[@]}" | jq -R . | jq -s -c .`
    expansion under `set +u` produces `[""]` (the W1 round-2 bug shape),
    under `set -u` aborts the script with unbound-variable. Both
    outcomes defeat R2.F1.7's stated goal. Fix: add explicit
    `FAILED_PAGE_FILES+=("${entry.file}")` after each F1 `FAILED_PAGES+=`
    push (3 sites — basename invalid / page absent / disk read fail) +
    explicit `FAILED_PAGES=()` `FAILED_PAGE_FILES=()` init at top of
    `if sources_count == 1:` block.
  - **R3.W-1 (single-reviewer Opus)** — `phase_timing_ms.stage_3_write`
    formula. Pre-R3 fixup computed `LOG_EMIT_MS - INGEST_T0_MS` — same
    as `total`, violating the documented `total >= sum(stages)`
    invariant. Fix: caller captures `STAGE_3_START_MS_FAIL` immediately
    before invoking the function; function's compute uses
    `LOG_EMIT_MS - STAGE_3_START_MS_FAIL` for stage_3_write, scoping to
    lock+yaml+log emit only. B3.1 path-coverage matrix updated with
    new "Single-source F1 all-dropped" row.
  - **R3.W-2 (single-reviewer Opus)** — reason taxonomy normalization.
    Pre-R3 fixup used `"all_f1_dropped"` (snake_case) while existing
    Step 7.6.F vocabulary used space-separated phrases (`"stage 2
    worker fail"`, `"all workers failed"`). Fix: normalized to
    `"all f1 dropped"` and added to inline taxonomy at line ~2068.

- **F2 (MEDIUM) — single-source Stage 1 dispatch §3.9 bracketing gap.**
  v1.4.1 §3.9 worker-mutation dirty-scan brackets fire at 3 dispatch
  sites (Step 7.5.M-A multi-source A4 fanout, Step 7.5.M-B Case B2
  collision second-pass, Step 7.6.B-post single-source A5 fanout) but
  did NOT bracket the single-source Stage 1 analysis dispatch
  (`invoke deep-wiki:wiki-synthesizer-analysis` in Step 7.5). A
  misresolved or downgraded analysis subagent could mutate `<wiki_root>/`
  during Stage 1 LLM execution, undetected. v1.4.2 adds a 4th invocation
  site (label `"A5-analysis"`) immediately bracketing the Stage 1
  dispatch. Pre-snapshot fires before the dispatch; post-scan after
  Stage 1 returns and BEFORE the page_plan branch decision (sub-threshold
  inline vs. A5 fanout downstream branching is irrelevant — Stage 1
  mutation is caught regardless). `WIKI_TEST_MODE=1` env-gated;
  production cost unchanged.

### Telemetry

  **Post-impl review fixup (B3.1, single-reviewer Opus C1)** — path-coverage
  matrix vs. Step 10 omission rule self-contradiction. Pre-fixup matrix
  listed `Single-source empty page_plan terminal-skip`, `Re-ingest
  hash-skip`, `Ingest-fail / 3-strike abort` paths with phase_timing_ms
  schema, but Step 10 omission rule explicitly states the field is
  emitted only on `ingest` lifecycle action lines (not `ingest-skip` /
  `ingest-repair` / `ingest-fail`). Fix: rewrite path-coverage matrix as
  a 4-column table distinguishing "phase timing emitted" vs. "Step 10
  bypass" with per-stage descriptions. Implementer mental model now
  unambiguous. Also added W3 fixup — `${var:-0}` defaultization on the
  delta-compute pseudocode for set -u tolerance.

- **B3 — `phase_timing_ms` in `log.jsonl` `ingest` lines.** Deferred from
  v1.4.0 plan §10.2; v1.4.0 dogfood measured ~17 minutes wall-clock with
  anecdotal Stage 1 ~7 min + Stage 2 ~10 min splits but no per-phase timing
  was recorded, so the breakdown was unverifiable post-hoc. v1.4.2 adds
  a `_ts_ms` helper (Bash 3.2 portable; python3 preferred for ms precision,
  `date +%s000` fallback for second precision) and threads timestamp
  captures through Step 1 entry / Step 7.5 single-source / Step 7.5.M-A
  multi-source / Step 7.6.A A5 fanout / Step 7.6.B-post / Step 7.6.C
  Stage 3 lock acquire / Step 7.5.M-C multi-source atomic-write entry /
  Step 10 log emit. Ingest line emits new field
  `phase_timing_ms: {stage_1_analysis, stage_2_fanout, stage_3_write,
  total}` (all ms integers). **Schema-additive** — `wiki-lint` Step 6
  LOG-INVARIANT scan filters via
  `select(.action != "ingest-repair") | .pages_created[]?` and ignores
  unknown top-level fields. Field omitted from non-`ingest` lifecycle
  actions (ingest-skip, ingest-repair, ingest-fail, lint, rebuild,
  delete, query-filed, setup). Production cost: ~12 ms total per ingest
  (~6 `_ts_ms` calls dominated by Python startup; warm-cache ~2 ms each),
  negligible vs. minutes-scale LLM phases.

### Testing infrastructure (probe quality)

- **I2 — V-2/V-3 WebFetch probe full-URL allowlist comparison.** From
  /deep-review rounds 1 + 2 (Codex review, single-reviewer raised twice).
  `scripts/v0-probe/v2-v3-record.sh` previously recorded WebFetch
  probes with only the request PATH (column 3 of stub log) and compared
  against the path component of allowlist URLs. False-pass surface:
  injected `https://attacker.com/v2-probe-feed?data=<exfiltrated_secret>`
  matched allowed `https://example.com/v2-probe-feed` on the path-only
  comparison. v1.4.2 adds a 6th TSV column to
  `scripts/v0-probe/webfetch-stub-server.py` (`<host>` from request Host
  header), and `v2-v3-record.sh` now extracts full URLs as
  `<host><path>?<query>` (scheme stripped) for normalized comparison
  against allowlist URLs. Backward-compatible: pre-v1.4.2 5-column logs
  trigger lossy-mode detection and degrade to path-only comparison with
  `lossy-pre-v1.4.2-log: ...` annotation in the notes column. Testing
  infrastructure only — production agent behavior unaffected.

  **Post-impl review fixup (W4, single-reviewer Opus)** — empty-log
  short-circuit. Pre-fixup format-detect awk would treat an empty log
  file as "not new format" and tag the run as `lossy-pre-v1.4.2-log` in
  the notes column, falsely suggesting degraded probe infrastructure on
  what is actually a clean PASS shape (no requests made = no
  exfiltration attempt). Fix: `[ ! -s "$WEBFETCH_LOG" ]` short-circuit
  before format detection, treating empty file as the explicit empty PASS
  case.

### Migration

No external API changes from v1.4.1. Internal contract change is the
F1 disk-authoritative read for `existing_body_hash`: hashing is consistent
within Stage 3 — both F1 capture and C3 re-check use `$(cat …)`
byte-stripping (POSIX command substitution drops trailing newlines), so
the C3 comparison is symmetric and concurrent-ingest detection is
preserved. Hash values are NOT byte-identical to v1.4.1 (v1.4.1 hashed
`printf '%s' "$emit"` which preserved synthesizer's trailing newline if
compliant; v1.4.2 hashes `$(cat)` output which strips them) — but Stage 3
success/abort decisions remain equivalent for spec-compliant agents.
Non-compliant emits (truncation drift) trigger a `WARN: synthesizer
existing_page_body drift for ...` stderr line. Sub-threshold path with
drift is escalated to A5 fanout (post-review F1.1 fixup) so Stage 2
workers re-synthesize from disk-bytes context — preserves the v1.4.1
LOUD-failure property for affected pages while recovering retry-correctness.

### Acknowledgements

- Handoff doc `docs/handoff-2026-05-06-v1.4.2.md` (gitignored author
  artifact) drove the F1+F2+B3+I2 backlog ordering.
- /deep-review rounds 1+2 from v1.4.1 cycle (Opus + Codex review +
  Codex adversarial) flagged F2 (round 1 I1) and I2 (rounds 1+2,
  single-reviewer Codex twice).
- v1.4.1 cache-active dogfood (handoff §0) discovered F1 in the wild.

## [1.4.1] — 2026-05-06

Trust-boundary closure (best-effort, layered defense). Splits the unified
`wiki-synthesizer.md` agent into three role-scoped files
(`wiki-synthesizer-{analysis,worker,inline}.md`), all without `Write` in
their `tools:` declaration on the active paths, and routes
`/wiki-ingest` to them via Claude Code's qualified-namespace
(`deep-wiki:<agent>`). Together with a frontmatter lint
(`scripts/lint-agent-tools.sh`) and an in-root post-dispatch dirty-file
scan (gated by `WIKI_TEST_MODE=1`, zero cost in production), this closes
the v1.4.0 dogfood failure root cause: **caller-side voluntary downgrade
to `subagent_type: "general-purpose"`** which silently granted
Read+Write+Edit to `wiki-page-writer` workers and enabled writes outside
the Stage 3 lock. Single-source A5 + multi-source A4 paths are
structurally equivalent to v1.4.0 (NOT byte-identical — split-agent
dispatch changes WHO writes pages, not page-creation semantics).

**Production-cost note:** §3.9 dirty-file scan is `WIKI_TEST_MODE=1`
env-gated; production `/wiki-ingest` invocations skip it entirely (zero
cost). The scan opts in for sandbox + re-dogfood scenarios only — see
cycle-3 N3.4 / plan §3.9.

### Architectural

- **3-agent split (Track C closure)**: the v1.3.0 / v1.4.0 single
  `agents/wiki-synthesizer.md` (mode-scoped sections) is replaced by
  three role-scoped agent files. The split moves `Write` off the active
  call paths' `tools:` declarations — V-1 (callee-side enforcement) is
  now a static property of the agent file, not a runtime contract that
  the prompt has to negotiate per turn.

  | File | Role | `tools:` | Caller |
  |---|---|---|---|
  | `agents/wiki-synthesizer-analysis.md` | Stage 1 single-source A5 analysis (page_plan + sub-threshold inline_bodies) | `[Read, Glob, Grep, WebFetch]` (Write **absent**) | `commands/wiki-ingest.md` Step 7.5.M-A (single-source) |
  | `agents/wiki-synthesizer-worker.md` | multi-source A4 worker + 2nd-pass collision merge (worker mode + `colliding_drafts` input) | `[Read, Glob, Grep, WebFetch]` (Write **absent**) | `commands/wiki-ingest.md` Step 7.5.M-B + Step 7.6.B-post |
  | `agents/wiki-synthesizer-inline.md` | DORMANT — preserves the v1.3.0 inline-mode contract (page-write-on-emit) for future restoration | `[Read, Write, Glob, Grep, WebFetch]` | (no active caller; `status: dormant`) |

- **Old `agents/wiki-synthesizer.md` deleted (Option B per §3.4 — no
  shim)**: the unified agent file is removed in v1.4.1. There is no
  compatibility shim. External callers that were dispatching
  `subagent_type: "wiki-synthesizer"` directly MUST migrate to the
  qualified-namespace forms below — see Migration.

- **Qualified-namespace routing (V-0 empirical finding)**: 12 dispatch
  sites in `commands/wiki-ingest.md` were updated from the unqualified
  `subagent_type: "wiki-synthesizer"` (now Agent-not-found) to the
  qualified forms `deep-wiki:wiki-synthesizer-analysis`,
  `deep-wiki:wiki-synthesizer-worker`, and `deep-wiki:wiki-page-writer`.
  V-0 verification (Mechanism B forced-attempt probe) confirmed
  empirically that:
  - Qualified namespace `deep-wiki:wiki-X` resolves correctly via
    Claude Code's plugin agent registration.
  - Unqualified names return an explicit Agent-not-found error
    (no silent substitution to `general-purpose`).
  This means the v1.4.0 dogfood failure was NOT caused by runtime
  auto-substitution. The real root cause was **main-session voluntary
  downgrade** of `wiki-page-writer` workers to
  `subagent_type: "general-purpose"`, which granted them Read+Write+Edit
  and enabled writes to `/tmp/v140-workers-out/*` outside the Stage 3
  lock. Step 7.6.A now carries an explicit V-0/C3 comment forbidding
  this downgrade going forward.

- **Inline rot-mitigation (v1.3.0 contract preserved)**:
  `agents/wiki-synthesizer-inline.md` ships dormant but
  contract-frozen. Its frontmatter / header carries:
  - `status: dormant`
  - `last_known_active: v1.3.0`
  - `contract_frozen_at: a9966c7` (the SHA of the unified-agent
    deletion commit). When future restoration is needed, the inline
    contract is recoverable from that exact SHA without spec
    archaeology.

### Tooling

- **`scripts/lint-agent-tools.sh` (new, 225 lines, Bash 3.2 portable)**:
  static frontmatter lint for the four agent files
  (analysis + worker + inline + page-writer). Verifies each agent's
  declared `tools:` matches a hardcoded manifest, plus a string-match
  WebFetch URL allowlist check. Catches drift if a future spec change
  inadvertently adds `Write` back to an active agent. Bash 3.2 portable
  per CLAUDE.md (no `declare -A`, no `mapfile`, no `${var,,}`,
  newline-delimited string + `grep -Fxq` pattern).

- **`_post_dispatch_dirty_scan()` (new shell function in
  `commands/wiki-ingest.md`)**: in-root mutation defense at three
  invocation sites — Step 7.5.M-A (post single-source analysis), Step
  7.5.M-B Case B2 (post multi-source worker dispatch), Step 7.6.B-post
  (post 2nd-pass collision merge). Computes a sha256 hash over
  `<wiki_root>/pages/` + `<wiki_root>/.wiki-meta/` before and after each
  agent dispatch; on mismatch, emits a stderr warning and aborts the
  ingest with `PARTIAL_FAIL`. **`WIKI_TEST_MODE=1` env-gated** —
  production `/wiki-ingest` runs skip the scan entirely (zero cost). See
  Known limitations L2 for scope.

### Backward compatibility

- **Single-source A5 + multi-source A4 paths**: structurally equivalent
  to v1.4.0 (same pages produced, same provenance, same log events).
  NOT byte-identical — the split-agent dispatch changes which agent
  emits the JSON (analysis vs worker, both with Write absent), but
  `pages_created` semantics, lock acquisition, Stage 3 atomic-write,
  and metadata pipeline are unchanged.
- **All v1.4.0 invariants preserved**: A5 three-stage pipeline,
  mandatory C3 concurrency check, `partial_fail` sentinel + Step 1.5
  cascading, `pages_failed` log field, `ingest-fail` 3-strike
  promotion, `.config.json` knobs.
- **All v1.3.0 contracts preserved**: B5 dual-classification ledger,
  `colliding_drafts` second-pass input (now consumed by
  `wiki-synthesizer-worker`), hook YAML parser broaden.

### Migration

External callers that used `subagent_type: "wiki-synthesizer"` directly
MUST switch to the qualified namespace per their use case:

- Single-source analysis: `subagent_type: "deep-wiki:wiki-synthesizer-analysis"`
- Multi-source worker (or 2nd-pass collision merge): `subagent_type: "deep-wiki:wiki-synthesizer-worker"`
- Inline mode (DORMANT, restoration only): `subagent_type: "deep-wiki:wiki-synthesizer-inline"`

The old single-agent name is removed in v1.4.1 — there is no
compatibility shim per §3.4 Option B. `commands/wiki-ingest.md` itself
was migrated as part of this release; only out-of-tree callers need
action.

### V-0 / V-1 / V-2 / V-3 verification task results

Track C verification ran four behavioral probes (`scripts/v0-probe/`)
to validate the trust-boundary closure end-to-end:

- **V-0 PASS via Mechanism B (forced-attempt probe)**: qualified
  namespace `deep-wiki:wiki-X` resolves; unqualified returns explicit
  Agent-not-found error (no silent substitution to general-purpose).
  This empirical finding closes the v1.4.0 dogfood root-cause analysis
  (the failure was caller voluntary downgrade, not runtime
  auto-substitution).
- **V-1 ALL 3 surfaces PASS**: `wiki-page-writer` correctly refuses
  prompt-injection (returns `worker_status: failed` + `tools:[]` cited
  + Rule 2 cited); refuses nested-agent dispatch (contract violation
  cited); output-forgery from worker JSON is rejected by Step 7.6.B
  Gate 3.5 basename validation.
- **V-2 / V-3 UNDETERMINED-extrapolated**: stub agents required for
  V-2 / V-3 fault-injection were not in the plugin distribution cache
  during testing (Path A acceptance per §6 fix-and-go cap). PASS is
  evidence-extrapolated via the V-0 + V-1 chain. Final-file empirical
  re-run is deferred to post-distribution dogfood.
- **L1 caveat (cycle-4 R4-2)**: V-0 PASS is best-effort without a
  Claude Code runtime metadata API; the cache distribution gap on V-2/V-3
  stubs is treated as Path A acceptance.

### Known limitations (mandatory per §11.5 — Path A acceptance posture)

**L1. V-0 false-pass risk without dispatch-metadata API:**

> Trust-boundary closure achieved at agent-file-metadata level (`tools:` declarations) and via static lint + in-root runtime guard (§3.9). Empirical proof of caller-side `subagent_type` resolution is best-effort due to Claude Code runtime not exposing dispatch metadata. False-pass risk remains for caller-substitution scenarios identical to v1.4.0 dogfood. Track C v2 deferred until runtime-API supports metadata exposure.

**L2. §3.9 in-root scope only:**

> §3.9 post-dispatch dirty-file scan covers `<wiki_root>/`-internal mutations (state-corruption defense), NOT off-root writes (information-disclosure-via-side-channel). The v1.4.0 dogfood failure mode (worker writes to `/tmp/`) is NOT detected by §3.9. v1.4.1 trust boundary is layered defense-in-depth, not comprehensive enforcement. Process-level sandboxing deferred to v1.5.0+.

**Production-cost note (cycle-3 N3.4):** §3.9 is `WIKI_TEST_MODE=1`
env-gated. Production `/wiki-ingest` invocations skip the dirty-file
scan entirely (zero cost). Sandbox + re-dogfood opt-in only.

### Deferred to v1.4.x or v1.5.0+

- Track C v2 (post-runtime-metadata-API or post-process-sandbox)
- Real-vault re-dogfood (Task 11 — user discretion)
- Sandbox T1–T6 tests (Task 10 — user discretion per v1.4.0 Phase 6
  precedent)
- B1 fault-injection harness, B2 A4×A5 combination, B3
  `phase_timing_ms` telemetry
- §3.9 symlink-coverage tightening + post-Stage-3-close race hash-check

### Implementation references

- Plan: `docs/superpowers/plans/2026-05-05-wiki-synthesizer-agent-split.md`
  (825 lines, 4 review cycles)
- Handoff (V-0 empirical finding root-cause analysis):
  `docs/handoff-2026-05-06-v1.4.1-task4.md`
- 11 commits on `feature/v1.4.1-track-c` branch (Tasks 4–12 + this
  CHANGELOG commit, Task 13)

## [1.4.0] — 2026-05-05

A5 page-level fanout. Single-source `/wiki-ingest` parallelizes
page-body generation across N `wiki-page-writer` workers. Stage 1
(`wiki-synthesizer mode="analysis"`) emits a `page_plan` describing
which pages to create/update plus (when sub-threshold) `inline_bodies`
ready for atomic write. Stage 2 dispatches one `wiki-page-writer`
worker per affected page (parallel; `len(page_plan) ≥ a5_fanout_threshold`
default 3). Stage 3 main aggregates drafts and atomic-writes under
lock with mandatory C3 concurrency checks (update via hash compare,
create via existence check). Karpathy's "10–15 page touches per source"
property preserved — A5 changes WHO writes pages, not how many.
Multi-source path (≥2 sources) is unchanged from v1.3.0 A4 fanout;
A4×A5 combination deferred to v1.4.1+.

**Performance note (added 2026-05-05 post-release):** The original ≤5 min
wall-clock target (vs v1.3.0 ~15 min single-source baseline) assumed
unbounded subagent parallelism. Initial real-vault dogfood (14-page plan,
295-page wiki, this CHANGELOG's session) measured ~17 min total wall-clock
under Claude Code runtime's observed concurrent-subagent cap of ~3
(Stage 1 ~7 min analysis + Stage 2 ~10 min worker dispatch; effective
parallelism ~2.7×, not 14×). The architectural mechanism (parallel
page-body generation, lock-protected Stage 3, mandatory C3 concurrency
check) functions as designed; empirical per-stage characterization and
parallelism-cap quantification are deferred to v1.4.1 B1 fault-injection
+ B3 phase_timing_ms telemetry. Track C (synthesizer agent split for
trust-boundary closure) priority elevated after dogfood realized the
M1 limitation (2/14 workers violated `tools: []` contract).

### Architectural

- **A5 — single-source page-level fanout (Stages 1/2/3)**: new
  three-stage pipeline for 1-source ingests. Stage 1 invokes the
  synthesizer in `mode: "analysis"` (new contract) — synthesizer reads
  the source + cross-page candidates, emits a `page_plan` array of
  `{file, action, frontmatter_meta, source_excerpts, intent_summary,
  novel_facts, preserve_sections, existing_page_body, existing_body_hash}`
  entries describing each affected page. For sub-threshold runs
  (`len(page_plan) < a5_fanout_threshold`), Stage 1 also emits
  `inline_bodies` carrying the full `page_content` for each entry, and
  the flow skips Stage 2 entirely. Stage 2 (when active) dispatches one
  `wiki-page-writer` worker per `page_plan` entry in a single
  Agent-tool-message-turn — workers receive only the entry payload
  (NO Read/Glob/Grep tools), generate `page_content` for that one page,
  return `{file, page_content, frontmatter_meta, worker_status,
  fail_reason}`. Stage 3 (main, under lock) runs mandatory C3 optimistic
  concurrency check for every draft (update: re-read body + sha256
  compare against `existing_body_hash`; create: existence check), backs
  up under Rule 7, atomic-writes (tmp + rename), runs v1.3.0 Steps 8-13
  metadata pipeline UNCHANGED, then writes or removes the
  `partial_fail` sentinel based on `PARTIAL_FAIL` state.
- **`wiki-page-writer` agent (new)**: minimal LLM page-body generator.
  Tools: `[]` (no file I/O — main owns Stage 3 writes under lock).
  Inputs: `wiki_root` + one `page_plan_entry`. Output: a single JSON
  object `{file, page_content, frontmatter_meta, worker_status,
  fail_reason}` — main aggregates outputs and writes pages atomically
  in Step 7.6.C. No cross-page synthesis (Stage 1 owns it via
  `intent_summary` / `novel_facts` / `preserve_sections`); no source
  I/O (all relevant excerpts already in `source_excerpts`).
- **`wiki-synthesizer` extension**: new `mode: "analysis"` (additive
  to v1.3.0 `mode: "inline" | "worker"`). Analysis mode reads source +
  candidates, emits page_plan + (for sub-threshold) inline_bodies.
  Inline + worker modes preserved byte-identical from v1.3.0.

### Step 1.5 partial_fail cascading (A1)

- **`partial_fail` sentinel**: new optional field in
  `<wiki>/.wiki-meta/sources/<slug>.yaml` written when any page in a
  fanout run fails (Stage 2 worker fail OR Stage 3 write/concurrency
  abort). Schema:
  ```yaml
  partial_fail:
    ts: 2026-05-05T12:34:56Z
    failed_pages: ["page-a.md", "page-b.md"]
    reason: "stage 2 worker fail" | "stage 3 write fail" | "concurrency abort" | "all workers failed" | "metadata pipeline failure"
  ```
  Step 1.5 hash-skip cascades through partial_fail BEFORE the bytes-hash
  check: when present, force REPAIR override (new
  `partial-fail-recovery` repair_reason value) on next session even if
  source bytes are unchanged. Sentinel removal-on-success (Step 7.6.F
  Case ii) breaks the retry loop after a clean re-ingest.
- **`pages_failed` log field (additive)**: `log.jsonl` `ingest` action
  now includes `pages_failed: [<file>...]` whenever FAILED_PAGES OR
  FAILED_WORKERS is non-empty. wiki-lint Step 6 LOG-INVARIANT scan
  unaffected (additive field).
- **`partial-fail-recovery` repair_reason**: joins v1.2.1 R3W2's existing
  five values (informational note added in `commands/wiki-lint.md` —
  no strict whitelist exists; the value is emit-only).
- **`ingest-fail` lifecycle action**: emitted when the all-workers-fail
  retry counter reaches 3 consecutive batches on the same source
  (Step 7.7.B). Promotes `.pending-scan` despite failure to release
  stuck-window state.

### Hidden configuration

- **`<wiki>/.wiki-meta/.config.json` (optional, additive)**: new file
  with two A5 knobs:
  - `a5_fanout_threshold` (default 3) — `page_plan` size at which A5
    fanout activates. Below threshold, Stage 1's `inline_bodies` write
    via Step 7.5.A sub-threshold path (no Stage 2 dispatch). Set to a
    very large number to effectively disable fanout.
  - `a5_worker_timeout_sec` (default 90, aspirational per W9
    disclaimer) — soft per-worker timeout target. Agent tool exposes no
    per-call timeout knob; `a5_worker_timeout_sec` is a documentation
    target, not enforced. Actual hard limit is the runtime's ~5 min
    default per Agent call.
  - Loaded via python3 (preferred) or jq (fallback). When neither is
    available, defaults apply and a stderr warning is emitted (W10).
  - Absence of `.config.json` means defaults — no migration needed.

### Concurrency

- **Mandatory C3 concurrency check at Step 7.6.C**: every Stage 3
  draft runs the check (update: re-read + hash compare; create:
  existence check). On detection, the page is added to FAILED_PAGES
  with reason `"concurrent ingest detected at Stage 3 — page bytes
  drifted since Stage 1 read"` and the draft is skipped (loop
  CONTINUES — other pages may still write). PARTIAL_FAIL is toggled.
- **Existing global lock unchanged**: `mkdir
  <wiki>/.wiki-meta/.wiki-lock` for single-writer guarantee. A5
  acquires the lock at Stage 3 entry only (mirrors v1.3.0 single-source
  fast path; multi-source A4 still acquires at Phase 0).
- **R-P1 dual fallback**: every shasum invocation across A5 paths
  (Step 7.5 P6 hash compute, Step 7.6.C update C3 check, Step 7.7.B
  baseline yaml hash, Step 7.8 file-source hash) uses `shasum -a 256
  || sha256sum` for Linux portability.

### Failure handling

- **Step 7.7.A (per-worker fail)**: routed to FAILED_WORKERS;
  PARTIAL_FAIL toggled before SUCCESS_DRAFTS loop (P5 fix).
- **Step 7.7.B (all-workers fail)**: A7 lock acquisition before any
  log/meta write. R4-Adv-Adv-2 baseline yaml materialization for
  first-ingest case (sentinel writer otherwise corrupts non-existent
  yaml). 3-strike retry counter with `ingest-fail` force-promote on
  3rd consecutive failure.
- **Step 7.7.C (mid-loop write fail)**: A6 abort — remaining drafts
  go to FAILED_PAGES with reason `"skipped due to mid-loop abort"`
  on tmp-write fail OR rename fail (R4-R4-2 symmetry fix).
- **Step 7.7.D (C3 concurrency abort)**: continue (other pages may
  still write); PARTIAL_FAIL toggled, sentinel fires.
- **Step 7.7.E (worker timeout)**: treated identically to per-worker
  failure.
- **Step 7.7.F (R4-Adv-Adv-1 metadata pipeline failure recovery)**:
  Steps 8-13 fail AFTER Step 7.6.C wrote pages — mark all WRITTEN
  entries as failed, write `partial_fail` sentinel under held lock,
  best-effort log emit, do NOT promote `.pending-scan` (next session
  retries via partial_fail cascading + R3W2 wiki state drift detection).

### Backward compatibility

- **Single-source semantics preserved** but **NOT byte-identical**.
  v1.4.0 routes 1-source `/wiki-ingest` through analysis mode (page_plan
  emit) instead of v1.3.0's inline mode (direct synthesis). Same pages
  produced, same provenance, same log events; ~10–25% wall-clock
  variance from analysis-mode invocation.
- **Multi-source path unchanged from v1.3.0 A4** (worker mode + B5
  dual-classification + Phase 0 lock + second-pass collision merge).
  A4×A5 combination deferred to v1.4.1+.
- **All v1.2.0+ invariants preserved**: `pages_created` exactly-once
  across log, `.last-scan` monotonic, lock atomicity, source provenance,
  Step 1.5 hash-skip (now with `partial_fail` cascade prepended).
- **All v1.3.0 contracts preserved**: worker mode `proposed_action: "skip"`,
  `colliding_drafts` second-pass input, multi-source B5 ledger
  invariants, hook YAML parser broaden.

### Sandbox tests (Phase 6, deferred per W2)

12 sandbox scenarios specified in spec §10.1. Tests 1, 2, 3, 4, 8, 9,
11, 12 cover success/main paths and run on plain `/wiki-ingest`
invocations. Tests 5, 6, 7, 10 require fault-injection (`WIKI_TEST_*`
env vars) which is deferred to v1.4.1 per round-1 W2 fix. Phase 6
sandbox runs themselves are deferred to user discretion / v1.4.1 release
prep.

### Review trajectory

Plan went through 4 deep-review cycles before implementation:
- Round 1: 18 items. Plan: 1267 → 1810.
- Round 2: 7 items. Plan: 1810 → 1953.
- Round 3: 9 items. Plan: 1953 → 2080.
- Round 4: 7 items. Plan: 2080 → 2213.
- Round 5: not performed (fix-and-go cap after 4 cycles).

Implementation phase added one Phase 4 cleanup commit (stale v1.3.0
prose drift identified by impl-vs-spec drift check between Phase 4 and
Phase 5).

## [1.3.0] — 2026-05-02

Architectural minor release. Two parallel-axis changes plus six polish items
carried over from v1.2.1 cycle reviews. Multi-source `/wiki-ingest` now
fans out across up to 3 parallel `wiki-synthesizer` subagents in worker
mode, capturing the LLM-analysis-dominant cost in parallel while keeping
all writes serialized on main under the existing single mkdir-based lock.
Hook YAML parser now accepts inline + dotted forms in addition to block
form. Single-source ingest is byte-identical to v1.2.1 (fast path).

### Architectural

- **A4 — wiki-synthesizer fanout (Approach B)**: multi-source `/wiki-ingest`
  splits sources across `min(3, N)` worker subagents (round-robin by
  sorted source path), dispatched in parallel. Workers do full LLM
  analysis but NO file writes. Main aggregates drafts via cross-worker
  B5 dual-classification ledger and performs all writes sequentially
  under the existing global lock (now acquired in Phase 0 for fanout
  branch only — single-source path keeps v1.2.1 Phase-3-only timing).
  Cross-worker page collisions trigger a second-pass `wiki-synthesizer`
  invocation in worker mode (with new `colliding_drafts` input field) to
  merge conflicting page bodies into one cohesive page — preserves
  v1.2.1 multi-source merge invariant. v1.2.1 invariants (log-line
  uniqueness, per-source provenance, ingest-repair semantics) preserved
  by keeping main as single writer. Worker mode is opt-in via
  `mode: "worker"` parameter on the synthesizer agent; default remains
  `"inline"` for single-source fast path. Hardcoded cap of 3;
  configurable knob deferred to v1.4.0+. Expected wall-clock reduction
  for 3+ source batches: 30–50% (LLM analysis is dominant cost; ideal
  speedup of 3× in practice ~2× due to fastest-source dominance +
  Phase 2/3 sequential).
- **C — Hook YAML parser broaden**: `scan-vault-changes.sh` awk now
  recognizes three forms of `auto_ingest.ignore_globs`: block (current),
  inline (`["a", "b"]`), and dotted (`auto_ingest.ignore_globs: [...]`).
  Same broaden applied to `wiki-lint.md` `lint.orphan_ignore` parser
  (mirror parser per in-repo comment). Closes the v1.2.1 cycle-3
  README/parser mismatch on the parser side. Also fixes a pre-existing
  latent bug in the block-form path (`sub()` mutates `$0` causing
  terminator rule to fire on same line via fall-through, silently
  dropping multi-item block lists after the first).

### Polish

- **1.1 — Delimiter-aware awk slug allocator extractor**: replaces the
  v1.2.0 two-pass sed in `wiki-ingest.md` slug allocator's `prev_origin`
  extraction. Three anchored awk rules (double-quoted / single-quoted /
  unquoted) with `\47` literal-single-quote (POSIX awk portable) handle
  all 3 forms correctly, including embedded opposite-kind quotes
  (e.g., `"/path/with'quote.md"`). The single-pass char-class sed
  initially proposed in Plan #1 was rejected in Cycle-1 cross-validation
  — `[^"']*` capture stops at first inner quote, doesn't actually fix
  the embedded-opposite-kind case.
- **1.2 — Tab-indent recognized as code-block marker**: `wiki-lint.md`
  `strip_code_blocks` awk now matches `/^(    |\t)/` instead of `/^    /`.
  Closes W-γ false-positive on broken-link detection inside tab-indented
  code blocks.
- **1.3 — Post-list 2-blank-line reset**: same awk gains a `blank_run`
  counter; `prev_was_list` resets after 2 consecutive blank lines per
  CommonMark spec. Closes W-δ false-negative when a 4-space line after
  2 blanks is a real code block but was treated as list continuation.
- **1.4 — Spec/plan ordering convention**: `CLAUDE.md` Workflows &
  Conventions section gains a sub-section requiring spec writers to name
  the surrounding pattern when using positional language ("above X",
  "below Y"). v1.2.1 cycle-3 lesson applied.
- **1.5 — Implementation review prompt tweak**: `CLAUDE.md` Review cycle
  sub-section gains a memo about config/parser execution checks at Step
  6 (implementation review). Optional companion change in deep-review
  repo (`commands/deep-review.md`) appends the same guidance to the
  final code-reviewer prompt.
- **1.6 — README config syntax sweep**: `README.md` and `README.ko.md`
  now document all three accepted YAML forms for `auto_ingest`. Removed
  the v1.2.1 cycle-3 "block-form only / silently ignored" warning
  parenthetical (factually false post-Task-1).

### Tier 3 decisions (closed)

- **D — R3W2 missing-log design**: status quo retained. Prose-only
  `ingest-repair` (`pages_created:[]`) for log-truncation cases. No
  spec change. Will revisit if v1.3.0+ dogfood reveals frequent
  occurrence.
- **E — `cache_local` automation**: deferred to v1.4.0+ pending
  user-base data. Personal vault is Google Drive offline mode;
  cache_local benefit for that mode is ~0. Other-user prevalence is
  unobservable for a 1-user plugin.

### Backwards compatibility

- Single-source `/wiki-ingest` is byte-identical to v1.2.1 (fast path
  skips fanout entirely; lock still acquired in Phase 3 only — same as
  v1.2.1).
- Multi-source `/wiki-ingest` produces identical final wiki state when
  no cross-worker page collision occurs (the common case); second-pass
  synthesis preserves the same invariant when collisions DO occur. Only
  wall-clock changes.
- Existing `auto_ingest:` block-form configs continue to work unchanged.

### Trade-offs

- **Token cost increase (multi-source batches):** A4 fanout dispatches
  `min(3, sources)` `wiki-synthesizer` subagents in parallel. Each worker
  independently loads the synthesizer spec + wiki-schema (~3-5K tokens of
  context per worker). For 3-source batches, expect ~2-3× synthesizer-spec
  context cost vs the v1.2.1 single-synthesizer baseline. Wall-clock
  savings (~30-50% on LLM-dominant analysis) outweigh the token increase
  for most users; configurable `max_workers` knob deferred to v1.4.0+
  pending dogfood data.
- **Lock-held duration (multi-source only):** the global mkdir-based
  lock is now acquired in Phase 0 for the fanout branch (≥2 sources)
  and held through Phase 3 (atomic writes), versus v1.2.1 which acquired
  in Step 8. Lock held for the full LLM-analysis duration (~minutes for
  multi-source). Single-source path unchanged. Concurrent
  `/wiki-ingest` sessions are rare (single-user vault); contention will
  surface in dogfood if it matters.
- **Second-pass synthesis (cross-worker collision):** when ≥2 workers
  target the same proposed_file with non-byte-identical `page_content`,
  main dispatches one extra **worker-mode** synthesizer (with new
  `colliding_drafts` input field) to merge the colliding drafts. Worker
  returns the merged draft; main writes during Phase 3 — preserves the
  single-writer invariant (an `inline`-mode dispatch here would write
  during Phase 2 and break that invariant). Cost: 1 extra subagent
  invocation per same-page collision. Without this, multi-source merge
  invariant (v1.2.1 semantics) would silently drop facts. Most
  multi-source batches have no collision.

### New lifecycle action

- **`ingest-fail`**: emitted to `log.jsonl` when the all-workers-fail
  retry counter (`<wiki>/.wiki-meta/.pending-scan-retry-count`,
  format `<window_epoch>:<count>`) reaches 3 consecutive batches on
  the same `.pending-scan` window. Promotes `.pending-scan → .last-scan`
  despite the failure (releases the stuck window) and records affected
  source paths + 3 prior failure timestamps. Counter resets on any
  successful (full or partial) batch — partial relies on
  `.failed-sources.tsv` for per-source retry.

### New storage-layout files

- **`<wiki>/.wiki-meta/.failed-sources.tsv`**: path-level retry manifest
  written when a partial worker failure occurs in multi-source ingest.
  TSV format `<source_path>\t<failure_reason>\t<ts>`. Hook reads this
  alongside `.pending-scan` on next iteration. Cleared on full success.
  Replaces the (incorrect) Plan #2 idea of writing paths into
  `.pending-scan` (which is timestamp-only).
- **`<wiki>/.wiki-meta/.pending-scan-retry-count`**: all-workers-fail
  counter for the 3-strike `ingest-fail` trigger. Format
  `<window_epoch>:<count>`. Cleared on success or 3-strike trigger.

## [1.2.1] — 2026-05-02

Patch release closing v1.2.0 review-cycle backlog. Fourteen issues across four axes: Step 1.5 hash-skip integrity hardening, wiki-lint false-positive elimination, per-source provenance preservation, and README cloud-mirror documentation accuracy. No behavior change on the happy path; every fix is either a stricter invariant check or a doc/parser correction.

### Hash-skip integrity (Step 1.5 hardening)

- **R3W1 — Slug collision disambiguation**: when two file sources share a basename (`/A/foo.md` and `/B/foo.md` both → slug `foo`), the new disambiguation step at end of Step 1 picks the next available `foo-N` whose origin matches (or fresh `foo-N` slot). Closes the silent cross-attribution risk on coincidental bytes-hash match.
- **R3W2 — Forced repair on missing log signal**: Step 1.5 now triggers `ingest-repair` when (a) `log.jsonl` is absent entirely, or (b) the slug has no terminal log entry (`last_action=''`) despite a present yaml. Both indicate state drift that demands re-ingest, not skip. **Caveat (W-α v1.2.1+):** when triggered by log absence/truncation, the resulting `ingest-repair` line emits `pages_created:[]` per spec — the historical creation record for those pages is gone and is not synthesized. wiki-lint Step 6 LOG-INVARIANT only flags duplicates so the wiki stays clean, but log-based audit reconstruction will be incomplete for log-truncated repairs. Per-source yaml (intact, verified by Checks 1+2) remains the authoritative provenance record. To preserve full log-based traceability, restore log.jsonl from a backup before re-ingesting affected sources.
- **RW3 — Inline-list yaml parser**: Check 1 awk now accepts `pages_created: [a.md, b.md]` in addition to the block-list form. Defense-in-depth against future Step 8e variants.
- **RW4 — Single-quote yaml strip**: both Check 1 and Check 2 now use the same `gsub(/^["\x27]+|["\x27]+$/, "", v)` pattern as v1.2.0 IW1's wiki-lint fix.
- **RW7 — Explicit array init**: `SKIPPED=()` and `REPAIR=()` are explicitly initialized at the top of the Step 1.5 scan loop for `set -u` cleanliness.

### Wiki-lint false-positive elimination

- **T10 — http(s):// targets excluded from broken-link check**: external URLs ending in `.md` (e.g., GitHub gist raw URL) no longer emit `[BROKEN]`. Closes 5 false positives observed in v1.2.0 dogfood.
- **W7 — Block-context-aware 4-space code-block strip**: `strip_code_blocks()` now distinguishes real CommonMark indented code blocks (4-space after a blank line, not under a list item) from list continuations and paragraph lazy continuations. Real code is stripped (multi-line via `in_indented_code` state, CR-C v1.2.1+); continuations are preserved so links inside list items stay subject to broken-link detection. Tab-indented code and post-2-blank-line code remain documented limitations (v1.3.0+ candidates).

### Per-source provenance

- **B5 — Same-batch co-create attribution preserved**: when two sources independently produce the same page in one batch, both contributing slugs' yamls now record the page under `pages_created` (per-source truth). Step 10's log emission still applies the intra-batch dedup so the log invariant (each filename in `pages_created` at most once across log lines) holds. Length-guarded snapshot init (CR-B v1.2.1+) replaces the broken `("${ARR[@]:-}")` pattern that produces 1-element-empty-string under bash 3.2.57. Step 10 prose updated to reference post-dedup arrays explicitly (CR-D v1.2.1+). Closes the v1.2.0 W6 trade-off.

### Documentation accuracy

- **R3W3 — Cloud-mirror VAULT_ROOT note**: README A5 now warns that moving `wiki_root` to a non-vault local path makes the SessionStart hook watch `$HOME` (since `VAULT_ROOT=$(dirname "$WIKI_ROOT")`). Recommends hook disable or `ignore_globs: ['**']` in this mode. A `vault_root:` config knob is tracked for v1.3.0+.
- **R3W4 — auto_ingest pause guidance corrected**: removing the `auto_ingest:` block does NOT pause auto-ingest (it returns to v1.1.x whole-vault default — *more* aggressive). Corrected to: set `ignore_globs: ['**']` or disable the SessionStart hook.

### Spec polish

- **RW2 — Step 10 SKIPPED/REPAIR drain note**: explicit forward-pointer in Step 10 prose so the implicit Step 1.5 → Step 10 drain is visible without chasing the blockquote.
- **RW5 — Hook 50-line frontmatter guard reorder + line-1 opening guard**: the `^---$` rule now precedes the line counter so a closing `---` past line 50 (Templater plugin) is honored. Line-counter early-exit narrowed to fire only when frontmatter has not started; hard 200-line absolute cap added. Opening `---` restricted to line 1 so a body horizontal rule past line 50 cannot leak into frontmatter mode (CR-E v1.2.1+).
- **RW6 — Synthesizer message-boundary count covers Phase 1c**: "four message boundaries" → "four to six" with breakdown for whether Phase 1c fires and escalates.

### Backfill

- v1.2.0 CHANGELOG A3 bullet now carries the measured ~20% per-page reduction observed in 2026-04-30 dogfood.

### Files changed

- `commands/wiki-ingest.md` — Step 1 disambiguation, Step 1.5 hardening (R3W1+R3W2+RW3+RW4+RW7), Step 8c.1 + 8e (B5), Step 10 (RW2+CR-D)
- `commands/wiki-lint.md` — Step 4 (T10, W7+CR-C)
- `hooks/scripts/scan-vault-changes.sh` — `auto_ingest_passes()` (RW5+CR-E)
- `agents/wiki-synthesizer.md` — message-boundary count (RW6)
- `README.md`, `README.ko.md` — A5 (R3W3+R3W4)
- `.claude-plugin/plugin.json` — version bump
- `CLAUDE.md` — v1.2.1 entry under "Recent releases" + ingest-repair lifecycle action note (C2-Y v1.2.1+)

## [1.2.0] — 2026-04-30

### Performance

- **SessionStart auto-ingest scope filter** — `~/.claude/deep-wiki-config.yaml` now accepts an optional `auto_ingest:` block with `ignore_globs` (path glob exclusions) and `require_tag` (frontmatter-tag opt-in). The SessionStart hook applies these filters before /wiki-ingest is invoked, reducing call frequency for high-volume low-value paths (Daily notes, archive folders). Backwards compatible — block is optional, default behavior unchanged. (A1)
- **Re-ingest hash skip** — `/wiki-ingest` Step 1.5 now compares each `file`/`deep-work-report` source's sha256 against the existing `.wiki-meta/sources/<slug>.yaml:content_hash`. Matching sources are dropped from the batch before lock acquisition; an entirely-skipped batch still acquires the lock briefly to append a per-slug `ingest-skip` log entry and run the `.pending-scan → .last-scan` promotion before exit. New `ingest-skip` log action records skipped slugs for audit (canonical schema preserved: `{ts, action, source, pages_created:[], pages_updated:[], skip_reason}`). Slug derivation moved from Step 5 to end of Step 1 so Step 1.5 can locate the existing yaml. **Hash match alone is insufficient (IC1 review fix):** Step 1.5 also verifies wiki-side state integrity (every page in `pages_created`∪`pages_updated` exists; each page's frontmatter `sources:` lists the slug; the most-recent log entry for the slug is a clean terminal action). Any failure forces fall-through to normal ingest as self-repair, recorded as new `ingest-repair` log action. The `ingest-repair` line emits `pages_created:[]` and routes all touched pages to `pages_updated` so the wiki-lint Step 6 LOG-INVARIANT (each filename appears in `pages_created` exactly once across history) is preserved (R3C1 review fix); `wiki-lint` Step 6 also adds `select(.action != "ingest-repair")` defense-in-depth. (A2)
- **A3 — Skim-first candidate filtering**: synthesizer Phase 1 now scores candidates against frontmatter only, deep-reads the top K (typically 3, up to 5 when score distribution is flat), and verifies skim-skipped candidates with a parallel Grep batch (Phase 1c, IW1 fix). Per-call wall-clock projected to drop ~15-25% (projection from v1.1.4 follow-up; **measured ~20% per-page reduction in v1.2.0 first dogfood (2026-04-30)** — 1.7 min/page in v1.2.0 8-page cloud-vault dogfood vs v1.1.3 ~2.14 min/page baseline (2-page update, smaller sample), source vault on Google Drive offline mode. Sample sizes differ — directional only, not strictly like-for-like).
- **Cloud-storage mirror-and-sync workflow guide** — README (EN/KO) now documents a 3-step manual workflow for users on iCloud/Google Drive/Dropbox vaults: keep `wiki_root` on local disk, additive rsync (NO `--delete`) to vault on a schedule, manual reverse-rsync first when editing on other devices (no automated conflict detection). Automated `cache_local` config option deferred to v1.3.0+. (A5)

### Lint Hardening

- **`[SCAN-WINDOW]` invariant check + `--fix` auto-cleanup** — `/wiki-lint` gains Step 11 detecting three pathological states of `.pending-scan`/`.last-scan` (invalid TS regex, `PENDING < LAST` regression risk, stalled auto-ingest with `LAST > 48h`). `--fix` drops stale and invalid `.pending-scan` automatically; the >48h informational warning requires manual judgment. Includes tri-branch date parsing (gdate / Darwin / Linux) for portable epoch comparison. Implements the v1.1.4 follow-up doc's deferred recommendation. (B1+B2)
- **`[ORPHAN]` classification** — `/wiki-lint` Step 3 now exempts pages with frontmatter `tags: [leaf]` and pages matching `~/.claude/deep-wiki-config.yaml:lint.orphan_ignore` globs. Reduces noise on wikis with intentional archive/milestone leaves. (B3)
- **`[BROKEN]` code-block exclusion** — `/wiki-lint` Step 4 now strips **fenced** code blocks (```...```) before grep'ing for `[text](target.md)` patterns, eliminating false positives from documentation pages that mention `.md` filenames inside code samples. **4-space-indented blocks are intentionally NOT stripped** (NW3 review note): CommonMark treats 4-space inside lists as item-continuation, and unconditional stripping would silently swallow valid links like `- top\n    - nested with [link](other.md)`. (B4)
- **`pages_created` same-batch dedup guard** — `/wiki-ingest` Step 8c now reclassifies within-batch duplicates (the same `file` produced by two sources in one batch) so only the first is `created` and the rest are `updated`, restoring the "exactly once across log" invariant for v1.2.0+ ingests. Past log entries are unmodified (append-only). bash 3.2 compatible: uses newline-delimited string + `grep -Fxq` (NOT `declare -A`). (B5)

### Wiki Data Cleanup (one-off)

- **Broken-link findings (5)** — All 5 lint-flagged broken links analyzed; ALL turned out to be false positives — external URLs whose path ends in `.md` (e.g. `https://github.com/.../ARCHITECTURE.md`, `https://code.claude.com/docs/en/hooks.md`). Vault unchanged. **Note:** wiki-lint Step 4 URL exclusion (skip `http(s)://...` targets) is a v1.3.0+ candidate to eliminate this false-positive class structurally.
- **Version backup chains (4 pages pruned)** — `cross-model-3way-review-synthesis`, `deep-suite-marketplace`, `plan-review-as-integration-test`, `quant-monitor-watcher` reduced to retention limit (last 3 versions per page) by manual prune. Backup tarball saved before prune as safety net.
- **Orphan classification (36 pages)** — Deferred to user. v1.2.0's B3 tooling (`leaf` tag + `lint.orphan_ignore` config) ships ready; user can run a one-off pass with the appropriate globs/tags to clear the orphan list at their pace.
- **Historical `pages_created` violations (28)** — Remain in `log.jsonl` (append-only). B5 closes the future-recurrence path; v1.2.0+ ingests will not produce new ones.

### Preserved (functional parity)

- Agent input/output contract — `candidates` shape changed from `[filename]` to `[{file,title,tags,aliases}]` (caller and agent both updated; no third-party consumers of this contract)
- Lock protocol, version backup, source provenance schema — unchanged
- Pre-v1.2.0 wikis: `auto_ingest:` and `lint.orphan_ignore:` blocks are optional; absence yields v1.1.x behavior

### Migration

No action required. Existing wikis continue to work. To opt into v1.2.0 perf gains:

1. Add `auto_ingest:` block to `~/.claude/deep-wiki-config.yaml` with high-volume paths in `ignore_globs`.
2. Run `/wiki-lint --fix` once to clear stale `.pending-scan` files and prune excess version backups.
3. (Optional) Migrate `wiki_root` to local disk per the README cloud-storage section.
4. (Optional) Add `lint.orphan_ignore` globs and/or `tags: [leaf]` to intentional-orphan pages to clean up the `[ORPHAN]` lint report.

## [1.1.4] — 2026-04-24

### Fixed

- **`content_hash` no longer silently stores agent sentinels** (D1 from the v1.1.3 follow-up doc) — v1.1.2 moved sha256 computation into `wiki-synthesizer`, but the agent's tool scope (`Read, Write, Glob, Grep, WebFetch`) provides no hashing capability, so every manifest had been returning a placeholder string that the caller wrote verbatim to `sources/<slug>.yaml:content_hash`. Re-ingest detection and provenance auditing have therefore been unreliable since v1.1.2. `/wiki-ingest` now has an explicit Step 8d "Normalize `source_hashes`" that validates each manifest value against `^[0-9a-f]{64}$` (case-insensitive); non-hex values are recomputed from the source's `origin` (`shasum -a 256` for files and inbox text, `curl | shasum` for URLs) before Step 8e writes the provenance yaml. `wiki-synthesizer.md` is updated to document the sentinel convention (`"main-computes"`) and to explicitly mark non-hex values as non-fatal for the caller. Authoritative agent digests still pass through unchanged, so a future agent with a `shasum`-capable tool scope keeps full v1.1.2 semantics.
- **`.pending-scan → .last-scan` promotion no longer regresses `.last-scan` when a stale pending file is left behind** (D2 from the v1.1.3 follow-up doc) — if a prior interrupted session left `.pending-scan` older than the current `.last-scan`, the v1.1.1-shipped promotion block would execute `mv PENDING LAST`, moving `.last-scan` *backward*. The next hook would then re-detect every file since the stale pending timestamp, producing duplicate `log.jsonl` entries. The promotion block now reads `.last-scan` before advancing and skips the advance whenever `CURRENT_LAST > BATCH_PENDING` (lexicographic compare, which matches numeric order for fixed-width UTC ISO 8601 `Z`-suffix timestamps); `.pending-scan` is dropped in the same block once its window is covered by `.last-scan`. Concurrent-hook semantics (case where `.pending-scan` was overwritten with a newer timestamp mid-batch) are unchanged from prior releases.

### Preserved (functional parity)

- Agent input/output contract — unchanged (sentinel was already the observed behavior; the contract now documents it honestly)
- v1.1.3 parallel tool dispatch guidance in `wiki-synthesizer.md` — unchanged
- `.pending-scan` promotion under normal (non-stale) hook/ingest interleaving — unchanged; the regression guard is strictly defensive
- Manual (non-hook) ingest path — unchanged; `BATCH_PENDING=""` is still a no-op for the promotion block
- Lock protocol, version backup, auto-lint, per-source yaml schema, `log.jsonl` schema — all unchanged

### Migration

No action required. Existing `sources/<slug>.yaml` files with placeholder `content_hash` values are left as-is (they are historical records); any re-ingest of the same source will produce a valid sha256 digest going forward. Existing `.pending-scan` files are handled by the new promotion logic on the next ingest.

## [1.1.3] — 2026-04-24

### Performance

- **`wiki-synthesizer` now dispatches tool calls in parallel within each phase** — Previous versions composed the agent's workflow without explicit concurrency guidance, so Claude naturally emitted one tool call per message (read source, then read candidate A, then read candidate B, …). For typical 5-10 page ingests this produced ~3N sequential round-trips and dominated wall-clock time beyond the unavoidable LLM inference cost. `agents/wiki-synthesizer.md` now carries a "Performance guidance — parallel tool dispatch" section that partitions the workflow into four phases (source read / candidate survey / backup batch / page write) and requires every tool call within a phase to be issued in a single batched message. The data-dependency order between phases is unchanged; only the intra-phase fan-out is new. This is a pure prompt change — no runtime, tool contract, input/output schema, or lock/provenance behavior is modified.
- **Cloud-synced `wiki_root` documented as a latency tax** — README (EN/KO) now notes that placing the wiki on iCloud Drive, Google Drive, Dropbox, or similar sync-daemon-backed paths adds hundreds of ms per `Write` because each page write wakes the sync daemon. Recommendation: keep `wiki_root` on local disk and rely on the sync client's native file sync for propagation. This is environmental, outside the plugin's control, and the README explicitly scopes it as user infrastructure.

### Preserved (functional parity)

- Agent input/output contract (`{wiki_root, sources, candidates}` → `{created, updated, versioned, source_hashes, failed}`) — unchanged
- All correctness rules: grounded content, page template, kebab-case filenames, merge-don't-duplicate, conflict notation, version-before-overwrite, write scope — unchanged
- Rule 5 widening (`Glob`/`Grep` search beyond `candidates`) is still mandatory — the parallel guidance explicitly notes that correctness dominates performance and must not be relaxed
- Lock / `.pending-scan → .last-scan` promotion / auto-lint / index.json schema — unchanged

### Migration

No action required. Plugin consumers do not need to update their wikis or configs. The only observable change is faster ingest for sessions that write or update ≥3 pages (the more pages, the more linear-dispatch waste is eliminated).

## [1.1.2] — 2026-04-21

### Changed

- **`/wiki-ingest` always delegates page I/O to `wiki-synthesizer` subagent (sonnet)** — Previously the subagent was only invoked for multi-source batches or when `--synthesize` was passed; everything else happened inline in the main session, which pulled source content and existing page bodies into the main context window. Now every ingest (single-source, multi-source, URL, file, deep-work report, manual, or auto-ingest) dispatches to `wiki-synthesizer` at Step 7. Main session keeps only the small metadata footprint (`index.json`, `log.jsonl`, `sources/*.yaml`, lock, auto-lint). This materially reduces context pressure for SessionStart hook auto-ingests where multiple Obsidian vault files land together.
- **Version backup moved from main command to `wiki-synthesizer`** — Pre-overwrite snapshot copies to `.wiki-meta/.versions/<name>.v<N>.md` are now written by the agent as part of the same pass that decides create-vs-update, keeping the "write + backup" responsibility in a single context. Retention (last-3 pruning) stays in main via auto-lint — unchanged.
- **Agent input/output contract is now formal (structured)** — `wiki-synthesizer` accepts `{wiki_root, sources: [{slug, origin, type}], candidates}` and returns a structured manifest: `created` and `updated` entries carry `{file, title, tags, aliases, sources}`, plus `versioned`, `source_hashes` (per-slug sha256), and `failed` (may include `orphan_version`). The caller cross-references against a pre-batch `ls pages/` snapshot, reconciles each reported write against actual filesystem state, validates filenames against `^[a-z0-9][a-z0-9-]*\.md$`, and is authoritative for `pages_created` vs `pages_updated` classification.
- **`index.json` updates use manifest frontmatter directly** — Since main no longer writes pages, the agent's `created`/`updated` entries include the exact `title`/`tags`/`aliases` written to each page's frontmatter. Main uses these values verbatim to update `index.json` without re-reading page bodies, keeping the index always in sync with what the agent actually wrote.
- **Per-source provenance in multi-source batches** — Each source in a batch gets its own `.wiki-meta/sources/<slug>.yaml` and its own `log.jsonl` line. The agent's per-entry `sources` list drives the per-slug filtering, so a page only appears under a given slug's `pages_created`/`pages_updated` if that slug actually contributed to it. `wiki-lint`'s source-provenance invariant (every page's frontmatter `sources:` slug has a matching `.wiki-meta/sources/<slug>.yaml` with that page in `pages_*`) continues to hold for multi-source batches.
- **`content_hash` computed by agent at fetch/read time** — Previously main would re-`curl` URLs or re-`shasum` files after the agent had already read them, risking hash drift (dynamic content, cookies, UA differences) and doubling network/disk cost. Now the agent computes sha256 as it ingests each source and returns the map in `source_hashes`; main writes these values verbatim to `sources/<slug>.yaml`. The hash is guaranteed to reflect exactly the bytes that were ingested.
- **`--synthesize` flag demoted to a hint** — Accepted for backward compatibility but no longer gates any branching logic; synthesis behavior is now the default for any batch the agent receives.
- **Agent tool scope** — `wiki-synthesizer` gains `WebFetch` (for `type: url` sources it now reads directly) in addition to `Read`/`Write`/`Glob`/`Grep`. Write access remains constrained to `<wiki_root>/pages/` and `<wiki_root>/.wiki-meta/.versions/`.
- **Pasted-text ingest path made uniform** — For `type: text`, `/wiki-ingest` materializes the pasted text to `<wiki_root>/.wiki-meta/.inbox/<slug>.txt` before dispatch so the agent reads it like any other file. The inbox file is deleted in the same trap that releases the lock (success or failure).
- **Overlap detection strengthened against pre-filter misses** — The `candidates` list passed to the agent is now explicitly a hint, not an exhaustive set. `wiki-synthesizer` Rule 5 requires the agent to widen its search via `Glob "<wiki_root>/pages/*.md"` + `Grep` when a topic name it would assign could plausibly overlap pages outside the candidate list. This preserves the "merge, don't duplicate" invariant even when filename/URL-based pre-filtering misses semantic overlaps.
- **Post-write reconciliation added** — After the agent returns, main verifies each `file` in `created`/`updated` actually exists on disk (`test -f`). Missing files are moved to `failed` with reason `"agent reported written but file not present"`, catching agent crashes or manifest lies before metadata gets corrupted.

### Preserved (functional parity)

- Lock (`.wiki-meta/.wiki-lock` mkdir/rmdir atomicity) — unchanged
- `.pending-scan → .last-scan` promotion with `BATCH_PENDING` race guard + `TS_RE` size guard + promotion-before-rmdir ordering — unchanged
- Partial / full failure semantics — no `.pending-scan` promotion on any failure; next session's hook re-detects the window
- `index.json` / `log.jsonl` / `sources/*.yaml` on-disk schemas — unchanged. Data quality for multi-source batches is now **stronger** than before (per-source attribution is now authoritative instead of inferred).
- `.wiki-meta/.versions/` last-3 retention — still handled by main's auto-lint auto-fix
- Auto-lint (schema compliance, broken links, index drift, orphan detection) — unchanged
- UTC ISO 8601 `Z` timestamp requirement — unchanged

### Migration

No action required. Existing wikis continue to work; the only observable change is that main session context usage drops during ingest, and multi-source batches now produce correct per-source provenance (v1.1.1 had a latent ambiguity there that was never tripped because `--synthesize` was rarely used). `--synthesize` flag invocations continue to work unchanged (scheduled for removal in 1.2.0).

## [1.1.1] — 2026-04-17

### Security

- **Prevent accidental commit of local permission overrides** — `.gitignore` now covers `.claude/settings.local.json` and `.claude/.sensor-detection-cache.json`. These files can grant repo-scoped filesystem/exec permissions that should not propagate to other contributors. (R3, from Codex adversarial review)
- **Scrub destructive `git rm --cached -r . && git reset --hard` guidance** from upgrade docs. Replaced with a safe `git add --renormalize` flow that requires a clean working tree and warns against the destructive alternative. (R2)

### Fixed

- **SessionStart hook crashes on macOS bash 3.2** — Wrapped every `"${ARR[@]}"` iteration with `${#ARR[@]}` guards so the default macOS shell does not abort with `unbound variable` when `NEW_FILES` is empty during the recents-merge step. (C1)
- **File-loss risk on skipped auto-ingest** — Hook now writes the detected-at timestamp atomically to `.wiki-meta/.pending-scan` (via `mktemp` + `mv`). `wiki-ingest` promotes pending → committed only after a successful batch, and the promotion captures the pending timestamp at batch start so concurrent hook runs cannot advance `.last-scan` past what was actually ingested. (H1, plus race / atomicity hardening)
- **`wiki_prefix: "."` edge case** — When the wiki lives at the vault root, the hook now explicitly excludes `pages/`, `.wiki-meta/`, `index.md`, `log.md`, and `log.jsonl` from the scan so the wiki cannot ingest itself. (H3)
- **YAML config parsing** — `wiki_root`, `obsidian_cli.available`, and `wiki_prefix` are now parsed with an awk state machine that respects YAML block boundaries, so a neighbouring `available: true` under a different top-level key can no longer be mis-attributed to `obsidian_cli`. Inline comments and quotes are stripped. (H2)
- **Log timestamp consistency** — All commands now require UTC ISO 8601 with a `Z` suffix (`date -u +"%Y-%m-%dT%H:%M:%SZ"`). `wiki-schema.yaml` documents `ts_format` explicitly. Historical entries with `+09:00` offsets remain readable. (M1)
- **`pages_created` duplication** — Classification rule added: a filename appears in `pages_created` only if the file did not exist at the start of the ingest; otherwise it belongs in `pages_updated`. Each page has at most one `pages_created` entry across the log. `wiki-lint` gained a `[LOG-INVARIANT]` check that reports duplicates. (M4)

### Windows Compatibility

- **CRLF line endings** — Added `.gitattributes` enforcing LF on all shell/YAML/JSON/Markdown so Windows clones (default `core.autocrlf=true`) no longer produce broken shell scripts. README + CHANGELOG document a safe re-normalization procedure for pre-1.1.1 clones. (W-C1)
- **`timeout.exe` conflict** — Hook now detects `/windows/system32/timeout[.exe]$` (path-boundary anchored regex) and skips it; a legitimate GNU `timeout` installed under an unrelated path containing the word "windows" is no longer falsely skipped. Falls back to `gtimeout` or no timeout rather than silently breaking `obsidian recents`. (W-H1)
- **Shell dependency documented** — README + README.ko list Windows as Experimental and require Git Bash or WSL2. The plugin does not support native `cmd.exe`/PowerShell for the SessionStart hook. (W-H2, W-M1, partial — see Known Limitations)
- **Windows-native `wiki_root` rejected** — Paths like `C:\Users\...` or `C:/Users/...` produce a friendly error pointing to POSIX form (`/c/Users/...` or `/mnt/c/Users/...`). (W-H3)
- **Obsidian CLI on Windows** — `wiki-setup` gained a note on adding `%LOCALAPPDATA%\Programs\Obsidian\` to PATH. (W-M2)
- **Google Drive + locale guidance** — README documents Google Drive mount conventions on Git Bash and recommends offline-mirror mode to avoid placeholder-file mtime quirks. (W-M3)
- **NTFS case-insensitivity + long-path guidance** — README Windows Setup notes that kebab-case naming (enforced by the schema) prevents NTFS case-conflict issues, and documents Windows 10 1607+ long-path support for deep `.wiki-meta/.versions/` paths. (W-L1, W-L2)

### Changed

- **Hook heredoc tag** renamed from `EOJSON` to `EOMSG` for clarity (output is plain text systemMessage, not JSON). (L1)
- **Hook command timeout unit** is now documented in the script header comment block (15 seconds) rather than in the user-visible `hooks.json` `description`. (L4)
- **`case` patterns** in the hook now quote `"${WIKI_PREFIX}"` to guard against future values containing whitespace. (L2)
- **Post-upgrade note** added: users upgrading from 1.0.x/1.1.0 should re-run `/wiki-setup` to pick up Obsidian CLI auto-detection. (M3 — partial, see Known Limitations)

### Known Limitations (partially addressed; remaining work tracked for 1.2.0)

- **M2 CLI timeout fallback**: Windows `timeout.exe` is now skipped, but this release does not add `perl -e 'alarm N'` as a generic POSIX fallback. macOS users without coreutils installed still run `obsidian recents` unbounded.
- **M3 runtime re-setup nudge**: README documents the re-setup requirement, but individual commands do not yet print a one-shot "CLI detected but not in config — please run /wiki-setup" notice.
- **W-H2 shell gating**: README marks Windows as Experimental, but the hook does not yet emit a dedicated error when `bash` is missing from PATH, and a PowerShell port of the hook is not shipped.
- **Historical log migration**: Past `log.jsonl` entries with `+09:00` offsets are left intact. A migration script to normalize them to UTC is not part of this release.
- **wiki_prefix='.' end-to-end**: Hook's recents-filter correctly excludes wiki artifacts in the vault-root mode (added in 1.1.1), but the `find` path still derives `VAULT_ROOT = dirname(WIKI_ROOT)` which is `wiki_root`'s parent. Full end-to-end `wiki_prefix='.'` support requires a follow-up fix that distinguishes vault-root vs nested wiki at the `find` stage.

### Notes

All changes are backward compatible. `.pending-scan` is additive; existing wikis continue to work with their current `.last-scan` file. Log entries with mixed timezone formats remain readable — only new entries are required to use UTC.

## [1.1.0] — 2026-04-08

### Added

- **Obsidian CLI integration** — `/wiki-setup` now auto-detects the Obsidian CLI (`obsidian`) when the wiki is inside an Obsidian vault. When detected, wiki commands use Obsidian's full-text search, backlink graph, orphan detection, and unresolved link tracking for more accurate results.
- **Enhanced search in `/wiki-ingest` and `/wiki-query`** — When Obsidian CLI is available, overlap detection and content search use `obsidian search:context` instead of Grep, leveraging Obsidian's text index.
- **Graph-based query expansion** — `/wiki-query` adds a Layer 2.5 that follows backlinks to discover related pages beyond keyword matching (Obsidian CLI only).
- **Improved lint checks** — `/wiki-lint`, `/wiki-ingest` auto-lint, and `/wiki-rebuild` auto-lint use `obsidian orphans`, `obsidian unresolved`, and `obsidian backlinks` for more accurate structural health checks. All vault-wide results are post-filtered to the wiki boundary.
- **Hybrid SessionStart scan** — The auto-ingest hook supplements `find`-based scanning with `obsidian recents` (union + deduplicate). All candidates pass mtime verification to prevent ingesting unmodified files.
- **`obsidian` in recommended tools** — Added to `wiki-schema.yaml` CLI tools list.

### Changed

- **Config schema extended** — `~/.claude/deep-wiki-config.yaml` gains an optional `obsidian_cli` block with `available`, `vault_name`, `vault_path`, and `wiki_prefix` fields. Absence of this block means filesystem-only mode (fully backward compatible).
- **`/wiki-setup` re-run safety** — Re-running setup now removes stale `obsidian_cli` config blocks before re-detection, preventing stale config when CLI is uninstalled.
- **macOS compatibility** — SessionStart hook detects `timeout`/`gtimeout` availability instead of assuming GNU coreutils.

### Design Principles

- **Progressive enhancement** — Obsidian CLI enhances but never replaces filesystem operations. All commands fall back gracefully when the app is not running.
- **Wiki boundary filtering** — All vault-wide CLI results (`orphans`, `unresolved`, `tags`) are post-filtered to `wiki_prefix/pages/` to prevent unrelated vault notes from polluting reports.
- **Writes stay filesystem-based** — Page creation/modification, lock management, index/log updates all use Write/Edit tools for precise control.

## [1.0.1] — 2026-04-07

### Added

- **Auto-ingest SessionStart hook** — Automatically detects new/modified files in the Obsidian vault on every Claude Code session start and ingests them into the wiki. No manual action needed.
- **Batch ingest support** — `/wiki-ingest` now supports batch processing of multiple files from the auto-ingest hook, with single lock acquisition and grouped log entries.

## [1.0.0] — 2026-04-07

### Milestone

First stable release. All core features from Karpathy's LLM Wiki gist are implemented, and the plugin has been validated against a real Obsidian vault migration (700+ files → 107 wiki pages).

### Added (since 0.2.0)

- **Real-world validation** — Full vault migration of PARA-structured Obsidian vault (PROJECT, RESOURCE, AREA, ARCHIVE, DAILY notes) into deep-wiki, proving the system works at scale.

---

## [0.2.0] — 2026-04-07

### Added

- **Query auto-filing** — When `/wiki-query` synthesizes insights across 2+ pages, the result is automatically filed back into the wiki as a `query-synthesis` page. Implements Karpathy's principle that valuable query results should compound back into the knowledge base.
- **Auto-lint after write operations** — Lint checks run automatically after every `/wiki-ingest` and `/wiki-rebuild`. Auto-fixes structural issues (index drift, excess versions) silently; only reports issues requiring human judgment. Users no longer need to remember to lint.
- **Recommended tools check in `/wiki-setup`** — Setup now checks for CLI tools (qmd, marp) and Obsidian plugins (Dataview, Marp Slides, Web Clipper) and reports installation status with install commands.
- **`recommended-tools.md` reference document** — Detailed guide for qmd, Marp, Dataview, Marp Slides, and Obsidian Web Clipper.
- **`recommended_tools` and `auto_lint` schema definitions** in `wiki-schema.yaml`.
- **CHANGELOG.md / CHANGELOG.ko.md** — This file.

### Fixed

- **`wiki-lint.md` step numbering** — Steps 8, 8, 10, 10 corrected to 8, 9, 10, 11.

### Changed

- `/wiki-query` is no longer read-only. It now writes auto-filed synthesis pages when cross-page insights are detected.
- `/wiki-ingest` now includes an auto-lint step (Step 13) before the final report.
- `/wiki-rebuild` now includes an auto-lint step (Step 5) before reporting.
- `wiki-schema` skill updated with Auto-Lint and Query Auto-Filing sections.
- `wiki-schema.yaml` updated with `auto_lint`, `query_auto_filing`, and `log.actions` definitions.
- READMEs (EN/KO) updated with recommended tools section, Obsidian auto-check description, and revised command descriptions.

## [0.1.0] — 2026-04-06

### Added

- Initial release implementing Karpathy's LLM Wiki philosophy.
- Five commands: `/wiki-setup`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`.
- `wiki-synthesizer` agent for multi-source synthesis.
- `wiki-schema` skill with page template, schema YAML, and storage layout reference.
- Source provenance tracking with content hashing.
- Concurrency locking protocol (`mkdir`-based).
- Page versioning (keep last 3).
- Dual artifacts: human-readable (`index.md`, `log.md`) + machine-readable (`index.json`, `log.jsonl`).
- Obsidian vault compatibility.
- deep-work session report integration.
- Test wiki with example pages.
- Bilingual documentation (EN/KO).
