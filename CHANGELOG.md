# Changelog

All notable changes to deep-wiki are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.1] — 2026-07-07 (wiki-lint --fix lock + atomic .last-scan promotion)

### Fixed

- `/wiki-lint --fix` now acquires the wiki lock before mutating wiki state. Its `.pending-scan` drop and version prune previously ran with no `.wiki-lock`, so a concurrent hook-driven `/wiki-ingest` (holding the lock) could lost-update `index.json`, clobber the scan window, or race the `.versions/` prune — a breach of invariant #3 (lock atomicity). The `--fix` mutations now run inside a single self-contained lock block (acquire → EXIT-trap release → re-read + re-validate under the lock → mutate); on contention they soft-skip while the read-only diagnostics still print. Index-drift repair delegates to `/wiki-rebuild` only after that lock is released (its acquisition is non-reentrant).
- Made the hook-driven `.last-scan` promotion write atomic (temp file + `mv`), matching the repo's `.pending-scan` and `index.json` writers. The prior direct `echo > .last-scan` redirect could leave the file empty/truncated if interrupted mid-write (e.g. the 15s SessionStart hook budget on network-backed volumes).

### Changed

- Documented the three concurrency-lock trap patterns (single-block unconditional trap / multi-block failure-only trap + explicit release / contention soft-fail) in `storage-layout.md`, and split invariant #3 into *what* (acquire before any write, release before end of critical section) vs *how* (trap form → pattern catalog). Existing skill trap code is unchanged.
- The `/wiki-lint --fix` version prune now sorts backups by numeric version, so `.v10`/`.v11` are correctly retained over `.v2` (a lexicographic sort would have deleted the newest backups).

## [1.7.0] — 2026-05-22 (large-wiki reader race fix + index.md dashboard + inbox cleanup)

### Fixed

- Fixed a stdout-flush race in the index-envelope reader that could nondeterministically truncate its output on large wikis (~400+ pages), risking duplicate-page creation or silent page loss on index merge.

### Changed

- Redefined `index.md` as a lightweight, always-fresh dashboard (wiki overview, at-a-glance stats, recent activity, top tags, opt-in featured pages) instead of a full catalog rewrite each ingest, which was infeasible above ~100 pages. The full machine-readable catalog stays in `.wiki-meta/index.json`. The dashboard is marked with `<!-- deep-wiki-dashboard-v1.7.0 -->`; a pre-1.7.0 `index.md` is auto-backed-up to `.wiki-meta/.backups/index.md.pre-1.7.0` before the first overwrite.
- `/wiki-setup` now seeds a fresh wiki with the v1.7.0 dashboard shape.

### Added

- Added an inbox stale-cleanup step to `/wiki-ingest`: files older than 7 days that are not referenced by an unresolved `partial_fail` sentinel are moved to `.wiki-meta/.inbox/.quarantine/` (quarantined, not deleted) so a crashed-session source can still be recovered.

## [1.6.2] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- Added `.codex-plugin/plugin.json`, a Codex-native plugin manifest pointing at the same skill and hook surfaces as the Claude Code manifest.
- Added `AGENTS.md`, a Codex project guide covering runtime surfaces and verification.

### Changed

- README now documents Codex compatibility alongside the existing Claude Code surface.

## [1.6.1] — 2026-05-18 (Codex strict-YAML parse fix for wiki-setup description)

### Fixed

- Fixed the `wiki-setup` skill frontmatter description so Codex's strict YAML parser no longer rejects it and silently drops the skill at load time. The `A:`/`B:` colon-space pattern was rewritten to `option A —`/`option B —` and the description quoted; content is unchanged.

## [1.6.0] — 2026-05-18 (5 commands → user-invocable skills: cross-platform)

### Changed

- Promoted all 5 `/wiki-*` slash commands to `user-invocable: true` skills under `skills/wiki-{setup,ingest,query,lint,rebuild}/SKILL.md`, and removed the `commands/` directory. Each skill gains `## Invocation`, `## Inputs`, and `## Prerequisites` head sections. Command behavior (ingest / query / lint / rebuild / setup procedures) is unchanged.

### Migration

- **Claude Code users:** no change — `/wiki-setup`, `/wiki-ingest`, `/wiki-lint`, `/wiki-query`, `/wiki-rebuild` and the SessionStart auto-ingest hook continue to work; Claude Code auto-discovers the skills as slash commands.
- **Codex / Copilot CLI / Gemini CLI / Agent SDK users:** invoke as `Skill({ skill: "deep-wiki:wiki-ingest", args: "<source>" })` etc. Argument syntax is identical.

## [1.5.3] — 2026-05-13 (metadata — SKILL.md description length)

### Fixed

- Trimmed the `wiki-schema` skill frontmatter description below the Claude Code 1024-character cap (it had exceeded it, surfacing a load-time warning), preserving every trigger keyword. Metadata-only patch; no behavior change.

## [1.5.2] — 2026-05-12

### Added

- Added a `.pending-scan` recovery integration test for the SessionStart scan hook, pinning its behavior against artificially-dangled state (invalid / valid / stale / empty / corrupt content). Tests-only release; no behavior change.

## [1.5.1] — 2026-05-12

### Added

- Added a golden-fixture test suite for the SessionStart auto-ingest scan hook, pinning the detected count, file list, exit code, and `.pending-scan` preservation across an 8-scenario corpus (empty vault, new files, excluded directories, mtime filtering, tag/glob filters, missing config). Tests-only release; no behavior change.

## [1.5.0] — 2026-05-11 (M3 envelope adoption)

### Added

- `<wiki_root>/.wiki-meta/index.json` is now wrapped in the deep-suite M3 cross-plugin envelope. The legacy `{pages, generated_at}` shape is preserved verbatim inside `payload`. Each emit carries a ULID `run_id`, producer attribution (`producer = "deep-wiki"`, `producer_version`), a schema identity, and a git/tool-version provenance snapshot, enabling cross-plugin trace and schema-drift detection.
- Added envelope-aware reader and writer helpers: the reader emits the legacy shape on stdout (whether the file is envelope-wrapped or legacy), and the writer wraps a payload and atomically writes `index.json`. Identity guards reject foreign or corrupt envelopes.

### Compatibility

- **Forward-compatible:** the reader emits the legacy `{pages, generated_at}` shape, so existing `jq` pipelines (`.pages[].file`, `.generated_at`) keep working.
- **Backward-compatible:** legacy `index.json` files pass through unchanged — no `/wiki-rebuild` is required after upgrading. Running `/wiki-rebuild` (or the next `/wiki-ingest`) re-wraps the index in envelope form with no data loss.
- Mid-write interruption cannot leave a truncated `index.json` (atomic temp + rename). A foreign-producer envelope at the index path is rejected; recover with `/wiki-rebuild`, which regenerates from page frontmatter (the source of truth).

## [1.4.2] — 2026-05-07

### Fixed

- Fixed a false-positive concurrency abort where a synthesizer that emitted truncated `existing_page_body` caused every page update to abort. The main session now re-reads page bytes from disk as the authoritative baseline for the concurrency check and for synthesis context. On detected drift, the affected pages are re-synthesized from disk bytes (preserving the loud-failure property while recovering retry correctness), and a basename-traversal guard is applied before any page read.
- Fixed the all-dropped ingest path so that when every update entry is dropped (invalid basename / missing page / read failure), the source is no longer promoted as a clean skip; it now writes the `partial_fail` retry sentinel and participates in the 3-strike `ingest-fail` recovery.
- Extended the worker-mutation dirty-scan to also bracket the single-source analysis dispatch (test-mode only; zero production cost).

### Added

- Added `phase_timing_ms` (`stage_1_analysis`, `stage_2_fanout`, `stage_3_write`, `total`) to `log.jsonl` `ingest` lines for per-phase timing. Schema-additive — omitted from non-`ingest` actions and ignored by lint.

### Migration

- No external API changes from v1.4.1. Concurrency-check hash values are not byte-identical to v1.4.1, but abort/success decisions remain equivalent for spec-compliant agents.

## [1.4.1] — 2026-05-06 (synthesizer agent split — trust-boundary closure)

### Changed

- Split the unified `wiki-synthesizer` agent into three role-scoped files — `wiki-synthesizer-analysis` (single-source analysis) and `wiki-synthesizer-worker` (multi-source worker + collision merge), both **without `Write`** in their tool declaration, plus a dormant `wiki-synthesizer-inline` that preserves the v1.3.0 inline contract for future restoration. `/wiki-ingest` now dispatches these agents by qualified namespace (`deep-wiki:<agent>`). This closes the v1.4.0 failure mode in which a worker could be downgraded to a general-purpose agent and granted write access outside the Stage 3 lock.

### Added

- Added a frontmatter lint (`scripts/lint-agent-tools.sh`) that fails if a future change re-adds `Write` to an active agent, plus a test-mode-gated in-root dirty-file scan after each agent dispatch (zero production cost).

### Removed

- Removed the old unified `wiki-synthesizer.md` agent (no compatibility shim).

### Migration

- Single-source and multi-source ingest produce the same pages, provenance, and log events as v1.4.0 (not byte-identical). External callers that dispatched `subagent_type: "wiki-synthesizer"` directly must switch to `deep-wiki:wiki-synthesizer-analysis` (single-source) or `deep-wiki:wiki-synthesizer-worker` (multi-source / collision merge); `/wiki-ingest` itself was migrated as part of this release.

### Known limitations

- Trust-boundary closure is layered defense-in-depth at the agent-metadata level plus a static lint and an in-root runtime guard — not comprehensive enforcement. The in-root scan covers `<wiki_root>/`-internal mutations only, not off-root writes (e.g. `/tmp/`). Process-level sandboxing is deferred to a later release.

## [1.4.0] — 2026-05-05 (A5 page-level fanout)

### Added

- Single-source `/wiki-ingest` now parallelizes page-body generation across N `wiki-page-writer` workers. A new analysis stage emits a `page_plan` describing which pages to create/update (with inline bodies for sub-threshold runs); a fanout stage dispatches one worker per page (default threshold: 3 pages); and the main session aggregates drafts and atomic-writes them under lock with a mandatory concurrency check. Karpathy's "10–15 page touches per source" property is preserved — fanout changes *who* writes pages, not how many.
- Added the `wiki-page-writer` agent (no file I/O; main owns writes under lock).
- Added a `partial_fail` sentinel in per-source provenance YAML, written when any page in a fanout run fails; the next session forces a repair even if source bytes are unchanged, and the sentinel is cleared on a clean re-ingest.
- Added a `pages_failed` field to `log.jsonl` `ingest` lines.
- Added the `ingest-fail` lifecycle action, emitted after 3 consecutive all-workers-fail batches on the same scan window to release the stuck window.
- Added optional `<wiki>/.wiki-meta/.config.json` knobs: `a5_fanout_threshold` (default 3) and `a5_worker_timeout_sec` (default 90, advisory). Absence means defaults — no migration needed.

### Migration

- Single-source semantics are preserved but not byte-identical (analysis-mode adds ~10–25% wall-clock variance). The multi-source path is unchanged from v1.3.0. All v1.2.0+/v1.3.0 invariants are preserved.

### Notes

- Initial real-vault dogfood measured ~17 min wall-clock under the runtime's observed ~3-concurrent-subagent cap (not the originally targeted ≤5 min, which assumed unbounded parallelism). The mechanism works as designed; per-stage timing characterization arrived in v1.4.2 (`phase_timing_ms`).

## [1.3.0] — 2026-05-02

### Added

- Multi-source `/wiki-ingest` now fans out across up to 3 parallel `wiki-synthesizer` workers (worker mode). Workers do full LLM analysis but no file writes; the main session aggregates drafts and performs all writes sequentially under the existing single lock. Cross-worker page collisions trigger a second-pass merge so the multi-source merge invariant is preserved. Expected wall-clock reduction for 3+ source batches: ~30–50%.
- Added the `ingest-fail` lifecycle action and a `.failed-sources.tsv` retry manifest plus a `.pending-scan-retry-count` counter, enabling 3-strike stuck-window recovery for multi-source batches.

### Changed

- The SessionStart hook's `auto_ingest.ignore_globs` parser now accepts block, inline (`["a", "b"]`), and dotted (`auto_ingest.ignore_globs: [...]`) forms; the same broadening applies to the lint orphan-ignore parser. This also fixes a latent bug that silently dropped block-form list items after the first.

### Fixed

- `/wiki-lint` broken-link detection no longer false-flags links inside tab-indented code blocks, and correctly resets list-continuation state after two blank lines (CommonMark).

### Migration

- Single-source `/wiki-ingest` is byte-identical to v1.2.1. Multi-source produces identical final state when there is no cross-worker collision; only wall-clock changes. Existing `auto_ingest:` block-form configs work unchanged.

### Trade-offs

- Multi-source fanout dispatches up to 3 workers in parallel, each loading the synthesizer spec (~2–3× spec context cost for 3-source batches); the global lock is held for the full analysis duration on the multi-source path. Single-source is unaffected.

## [1.2.1] — 2026-05-02

### Fixed

- Disambiguate slug collisions when two file sources share a basename, closing a silent cross-attribution risk on coincidental hash matches.
- Force an `ingest-repair` when `log.jsonl` is absent or a slug has no terminal log entry despite a present provenance YAML. (When triggered by log truncation, the repair line emits `pages_created:[]`; the per-source YAML remains the authoritative provenance record.)
- Exclude `http(s)://` targets ending in `.md` from `/wiki-lint` broken-link detection, eliminating false positives from external URLs.
- Make `/wiki-lint` code-block stripping block-context-aware so real indented code is stripped while links inside list items stay subject to detection.
- Preserve per-source attribution when two sources independently create the same page in one batch (both contributing slugs record it), while keeping the log invariant via intra-batch dedup.

### Changed

- README cloud-mirror guidance now warns that a non-vault local `wiki_root` makes the SessionStart hook watch `$HOME`, and corrects the note that removing the `auto_ingest:` block does not pause auto-ingest (set `ignore_globs: ['**']` or disable the hook instead).

## [1.2.0] — 2026-04-30

### Added

- Added an optional `auto_ingest` block to the config (`ignore_globs`, `require_tag`) so the SessionStart hook can filter high-volume, low-value paths before invoking `/wiki-ingest`. Backward compatible — absence keeps prior behavior.
- Added a re-ingest hash skip: `/wiki-ingest` compares each source's sha256 against the stored `content_hash` and drops unchanged sources before lock acquisition, recording a new `ingest-skip` log action. Hash match alone is insufficient — wiki-side state integrity is also verified, and any failure falls through to a normal ingest recorded as the new `ingest-repair` action.
- Added a documented cloud-storage mirror-and-sync workflow to the README (keep `wiki_root` on local disk; additive rsync to the vault on a schedule; manual reverse-rsync before editing on other devices).

### Changed

- Synthesizer candidate filtering now scores against frontmatter, deep-reads the top few candidates, and verifies the rest with a parallel Grep batch — measured ~20% per-page wall-clock reduction in the first dogfood.
- `/wiki-lint` gains a `[SCAN-WINDOW]` invariant check (invalid timestamps, `PENDING < LAST` regression, stalled auto-ingest) with portable tri-branch date parsing; `--fix` drops stale/invalid `.pending-scan` while the >48h case requires manual judgment.
- `/wiki-lint` `[ORPHAN]` classification now exempts pages tagged `leaf` and pages matching configured `lint.orphan_ignore` globs.
- `/wiki-lint` `[BROKEN]` detection strips fenced code blocks before scanning for `.md` link patterns.
- `/wiki-ingest` reclassifies within-batch duplicate page creates so only the first counts as created, restoring the "exactly once across log" invariant for new ingests.

### Migration

- No action required. To opt into the perf gains, add an `auto_ingest:` block, run `/wiki-lint --fix` once to clear stale `.pending-scan` and prune excess version backups, and optionally move `wiki_root` to local disk.

## [1.1.4] — 2026-04-24

### Fixed

- `content_hash` is now validated against `^[0-9a-f]{64}$` and recomputed from the source when the synthesizer returns a non-hex sentinel, so re-ingest detection and provenance auditing are reliable again (they had been unreliable since v1.1.2).
- The `.pending-scan → .last-scan` promotion no longer moves `.last-scan` backward when a stale pending file is left behind, preventing duplicate `log.jsonl` entries on the next hook run.

### Migration

- No action required. Existing `sources/<slug>.yaml` files with placeholder `content_hash` values are left as historical records; any re-ingest produces a valid digest going forward.

## [1.1.3] — 2026-04-24

### Changed

- The `wiki-synthesizer` agent now issues tool calls in parallel within each workflow phase (source read / candidate survey / backup batch / page write), cutting wall-clock time for multi-page ingests. Pure prompt change — no contract, schema, or lock/provenance behavior is modified.

### Notes

- The README now documents that a cloud-synced `wiki_root` adds a per-write latency tax (each write wakes the sync daemon); recommendation is to keep `wiki_root` on local disk.

## [1.1.2] — 2026-04-21

### Changed

- `/wiki-ingest` now always delegates page I/O to the `wiki-synthesizer` subagent (previously inline for most ingests), keeping only the small metadata footprint in the main session and materially reducing context pressure for SessionStart auto-ingests.
- Version backup (pre-overwrite snapshot to `.versions/`) moved into the synthesizer; retention pruning stays in auto-lint.
- The agent input/output contract is now formal/structured: it returns `created`/`updated` entries with `{file, title, tags, aliases, sources}` plus `versioned`, `source_hashes`, and `failed`. The caller reconciles each reported write against actual filesystem state, validates filenames, and is authoritative for `pages_created` vs `pages_updated`.
- `index.json` updates use manifest frontmatter directly (no page re-reads); per-source provenance in multi-source batches is now authoritative rather than inferred; `content_hash` is computed by the agent at fetch/read time.
- Pasted-text ingest is materialized to a `.inbox/` file before dispatch (deleted with the lock release). Overlap detection is strengthened to widen the search beyond the candidate hint, and a post-write reconciliation moves any reported-but-missing file to `failed`.
- The `--synthesize` flag is demoted to a no-op hint (synthesis is now the default); the agent's tool scope gains `WebFetch` for `type: url` sources.

### Migration

- No action required. The main observable change is reduced context usage during ingest and correct per-source provenance for multi-source batches.

## [1.1.1] — 2026-04-17

### Security

- `.gitignore` now covers `.claude/settings.local.json` and `.claude/.sensor-detection-cache.json`, which can grant repo-scoped permissions that should not propagate to other contributors.
- Replaced destructive `git rm --cached -r . && git reset --hard` guidance in the upgrade docs with a safe `git add --renormalize` flow.

### Fixed

- The SessionStart hook no longer crashes on macOS bash 3.2 when the detected-files array is empty.
- The hook writes the detected-at timestamp atomically to `.pending-scan`, and `/wiki-ingest` promotes pending → committed only after a successful batch, so concurrent hook runs cannot advance `.last-scan` past what was actually ingested.
- When the wiki lives at the vault root (`wiki_prefix: "."`), the hook excludes wiki artifacts from the scan so the wiki cannot ingest itself.
- YAML config parsing now respects block boundaries (a neighbouring `available: true` can no longer be mis-attributed to `obsidian_cli`).
- All commands now require UTC ISO 8601 timestamps with a `Z` suffix; historical `+09:00` entries remain readable.
- A `[LOG-INVARIANT]` lint check reports duplicate `pages_created` entries; a filename appears in `pages_created` at most once across the log.

### Changed

- Windows is documented as Experimental, requiring Git Bash or WSL2 (native `cmd.exe`/PowerShell unsupported for the hook). Windows-native `wiki_root` paths are rejected with a friendly POSIX-form hint; `timeout.exe` is detected and skipped (falling back to `gtimeout` or no timeout); `.gitattributes` enforces LF endings; and the README documents Google Drive mount conventions, NTFS case-insensitivity, and long-path support.

### Notes

- All changes are backward compatible. `.pending-scan` is additive; mixed-timezone log entries remain readable (only new entries require UTC).

## [1.1.0] — 2026-04-08

### Added

- Obsidian CLI integration — `/wiki-setup` auto-detects the Obsidian CLI when the wiki is inside a vault, and wiki commands then use Obsidian's full-text search, backlink graph, orphan detection, and unresolved-link tracking for more accurate results.
- `/wiki-query` adds graph-based query expansion (follows backlinks to discover related pages; Obsidian CLI only).
- The SessionStart scan supplements `find` with `obsidian recents` (union + dedupe, with mtime verification).

### Changed

- The config schema gains an optional `obsidian_cli` block; absence means filesystem-only mode (fully backward compatible).
- Re-running `/wiki-setup` removes stale `obsidian_cli` config before re-detection.
- The SessionStart hook detects `timeout`/`gtimeout` availability instead of assuming GNU coreutils.

### Design principles

- Progressive enhancement: the Obsidian CLI enhances but never replaces filesystem operations, and all vault-wide CLI results are filtered to the wiki boundary. Writes stay filesystem-based.

## [1.0.1] — 2026-04-07

### Added

- Auto-ingest SessionStart hook — automatically detects new/modified files in the Obsidian vault on every session start and ingests them. No manual action needed.
- Batch ingest support — `/wiki-ingest` processes multiple files from the auto-ingest hook with a single lock acquisition and grouped log entries.

## [1.0.0] — 2026-04-07

### Milestone

First stable release. All core features from Karpathy's LLM Wiki gist are implemented, and the plugin has been validated against a real Obsidian vault migration (700+ files → 107 wiki pages).

### Added (since 0.2.0)

- Real-world validation — full migration of a PARA-structured Obsidian vault into deep-wiki, proving the system works at scale.

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
