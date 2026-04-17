# Changelog

All notable changes to deep-wiki are documented here.

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
- **Shell dependency documented** — README + README.ko list Windows as Experimental and require Git Bash or WSL2. The plugin does not support native `cmd.exe`/PowerShell for the SessionStart hook. (W-H2, partial — see Known Limitations)
- **Windows-native `wiki_root` rejected** — Paths like `C:\Users\...` or `C:/Users/...` produce a friendly error pointing to POSIX form (`/c/Users/...` or `/mnt/c/Users/...`). (W-H3)
- **Obsidian CLI on Windows** — `wiki-setup` gained a note on adding `%LOCALAPPDATA%\Programs\Obsidian\` to PATH. (W-M2)
- **Google Drive + locale guidance** — README documents Google Drive mount conventions on Git Bash and recommends offline-mirror mode to avoid placeholder-file mtime quirks. (W-M3)

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
