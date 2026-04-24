# Changelog

All notable changes to deep-wiki are documented here.

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
