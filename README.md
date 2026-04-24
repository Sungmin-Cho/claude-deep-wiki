# deep-wiki

**[한국어](README.ko.md)**

An LLM-managed markdown wiki for persistent knowledge accumulation — a Claude Code plugin implementation of [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) philosophy.

> *"Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation."*
> — Andrej Karpathy

### Role in Harness Engineering

deep-wiki serves as the **persistent knowledge layer** in the [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) ecosystem. In the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework's 2×2 matrix, it operates as an **Inferential Guide** — providing accumulated project knowledge that shapes the agent's understanding during Phase 1 Research, replacing the need for repeated RAG queries with a compounding knowledge base.

## The Idea

Instead of re-discovering knowledge each time (RAG), Claude Code **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files. When you add a new source, the LLM reads it, extracts key information, and integrates it into the existing wiki. The knowledge is compiled once and kept current, not re-derived on every query.

**The wiki is a persistent, compounding artifact.** The cross-references are already there. The contradictions have already been flagged. The synthesis already reflects everything you've read.

## Architecture

Based on Karpathy's three-layer model:

```
Raw Sources  →  Wiki (markdown pages)  →  Schema (management rules)
    ↑                   ↑                        ↑
 wiki-ingest        pages/               wiki-schema skill
```

| Layer | Description | Owner |
|-------|-------------|-------|
| **Raw Sources** | Immutable inputs — files, URLs, text, reports | You curate |
| **Wiki** | LLM-generated markdown pages with cross-references | LLM writes, you read |
| **Schema** | Rules governing how the wiki is structured and maintained | Co-evolved |

## Platform Support

| OS | Status | Notes |
|---|---|---|
| macOS | ✅ Primary | Developed and tested on Darwin 25+. |
| Linux | ✅ Supported | Requires bash 4+, GNU coreutils. |
| Windows | ⚠️ Experimental | Requires **Git Bash** or **WSL2**. Native `cmd.exe` / PowerShell not supported for the SessionStart hook. See "Windows Setup" below. |

### Windows Setup (Git Bash or WSL2)

1. Install Git for Windows (includes Git Bash) or enable WSL2.
2. Set `wiki_root` using POSIX paths — **never** Windows-native form:
   - ✅ `/c/Users/name/Obsidian/MyVault/wiki` (Git Bash)
   - ✅ `/mnt/c/Users/name/Obsidian/MyVault/wiki` (WSL2)
   - ❌ `C:\Users\name\Obsidian\MyVault\wiki` (rejected by the hook)
3. If Obsidian CLI is installed, ensure `obsidian version` succeeds in Git Bash (you may need to add the Obsidian install directory, typically under `%LOCALAPPDATA%\Programs\Obsidian\`, to `PATH`).
4. Google Drive mounted volumes (e.g. `G:\내 드라이브\...`) work in Git Bash as `/g/내 드라이브/...`. Prefer offline-mirrored mode to avoid placeholder-file mtime quirks.
5. Enable long-path support on Windows 10 1607+ if your wiki path approaches 260 characters (required for `.wiki-meta/.versions/<long-name>.vN.md` depth).

> Known Windows-only limitations: NTFS is case-insensitive (kebab-case naming enforced by the schema avoids conflicts); some Unix-only commands in command docs (`which`, `mkdir -p`) require bash.

### Upgrading from 1.0.x / 1.1.0 → 1.1.1

1. **Re-run `/wiki-setup`** if you did not do so after installing Obsidian CLI — v1.1.0's CLI integration requires an `obsidian_cli` block in `~/.claude/deep-wiki-config.yaml` that setup writes automatically.
2. **If you cloned on Windows before 1.1.1** (i.e. before `.gitattributes` was added), your shell scripts may have been CRLF-converted. Re-normalize from a **clean working tree**:
   ```bash
   # Ensure nothing is uncommitted first:
   git status                    # must show no changes
   # If you have in-progress work, stash it:
   git stash --include-untracked
   # Re-normalize:
   git add --renormalize .
   git commit -m "chore: normalize line endings"
   # Restore in-progress work:
   git stash pop
   ```
   > ⚠️ Do **not** use `git rm --cached -r . && git reset --hard` — it destroys all uncommitted changes in the worktree.

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and configured

### Via Deep Suite marketplace (recommended)

```bash
# 1. Add the marketplace
/plugin marketplace add Sungmin-Cho/claude-deep-suite

# 2. Install the plugin
/plugin install deep-wiki@Sungmin-Cho-claude-deep-suite
```

### Standalone

```bash
# 1. Add this repo as a marketplace
/plugin marketplace add Sungmin-Cho/claude-deep-wiki

# 2. Install
/plugin install deep-wiki@Sungmin-Cho-claude-deep-wiki
```

## Quick Start

```bash
# 1. Initialize the wiki
/deep-wiki:wiki-setup ~/Obsidian/MyVault/wiki

# 2. Ingest sources into the wiki
/deep-wiki:wiki-ingest https://example.com/article
/deep-wiki:wiki-ingest ./document.pdf
/deep-wiki:wiki-ingest  # paste text directly

# 3. Query the wiki
/deep-wiki:wiki-query What are the rules of React hooks?

# 4. Health check
/deep-wiki:wiki-lint
```

## Commands

| Command | Description |
|---------|-------------|
| `/wiki-setup` | Initialize wiki and create directory structure |
| `/wiki-ingest` | Read a source (URL, file, text) and create/update wiki pages |
| `/wiki-query` | Search the wiki and generate grounded answers; auto-files cross-page syntheses back into the wiki |
| `/wiki-lint` | Health check — schema violations, orphan pages, broken links, contradictions (also runs automatically after ingest/rebuild) |
| `/wiki-rebuild` | Regenerate index.json from page frontmatter |

### Operations in Detail

**Ingest** — Drop a new source and tell the LLM to process it. The LLM reads the source, writes summary pages, updates the index, updates relevant pages across the wiki, and appends to the log. A single source might touch multiple wiki pages. New information is merged with existing content — pages grow richer with each ingest. **Auto-lint runs after every ingest** to keep the wiki healthy.

**Query** — Ask questions against the wiki. The LLM searches for relevant pages using a three-layer strategy (index scan → content search → candidate reading) and synthesizes an answer grounded in wiki content, with citations. **When a query synthesizes insights across 2+ pages, the result is automatically filed back into the wiki** — the knowledge compounds.

**Lint** — Health-check the wiki. Looks for: schema violations, contradictions between pages, orphan pages with no inbound links, broken links, stale versions, and index drift. Optionally auto-fixes structural issues with `--fix`. **Runs automatically after ingest and rebuild** — you only need to invoke it manually for deep inspections.

**Rebuild** — Regenerate `index.json` from page frontmatter. Use when the index is out of sync or corrupted. Auto-lint runs after rebuild.

## Storage Structure

```
<wiki_root>/
├── index.md                  # LLM-written catalog (human-readable)
├── log.md                    # LLM-written chronicle (human-readable)
├── .wiki-meta/
│   ├── index.json            # Machine-readable page catalog (derived)
│   ├── sources/              # Per-source provenance YAML files
│   └── .versions/            # Page backups before overwrite (last 3)
├── log.jsonl                 # Append-only structured event log
└── pages/                    # Wiki pages (flat, tag-based classification)
```

Key design decisions:
- **Flat pages directory** — no subdirectories. Tags replace categories (more flexible, no broken links from moves).
- **Dual artifacts** — `index.md`/`log.md` are LLM-written for humans; `index.json`/`log.jsonl` are machine-readable counterparts.
- **`.wiki-meta/` is hidden** — invisible in Obsidian's graph view and file explorer.

## Configuration

`~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: ~/Obsidian/MyVault/wiki

# Auto-detected by /wiki-setup when Obsidian CLI is available (optional)
obsidian_cli:
  available: true
  vault_name: "My Vault"
  vault_path: ~/Obsidian/MyVault
  wiki_prefix: "wiki"
```

> **⚠️ Cloud-synced `wiki_root` is slow.** Placing the wiki on iCloud Drive, Google Drive, Dropbox, or similar sync-daemon-backed paths adds hundreds of ms per `Write` because every page write wakes the sync daemon. For interactive ingest speed, keep `wiki_root` on local disk and let the sync client propagate changes in the background; alternatively, use offline-mirror / "available offline" mode for the wiki folder so writes hit the local replica first. This is an environment-level concern outside the plugin's control.

## Recommended Tools

Tools referenced in [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that enhance the wiki workflow.

### CLI Tools

| Tool | Purpose | Install |
|------|---------|---------|
| **qmd** | Local markdown search engine with BM25/vector search and LLM re-ranking. Also works as an MCP server. | `npm install -g @tobilu/qmd` |
| **marp** | Generate slide presentations (HTML/PDF/PPTX) from markdown wiki pages. | `npm install -g @marp-team/marp-cli` |
| **obsidian** | Obsidian CLI — search, backlinks, tags, properties via running Obsidian app. Auto-detected by `/wiki-setup`. | [Obsidian CLI](https://github.com/anthropics/obsidian-cli) |

```bash
# Index your wiki with qmd
qmd collection add ~/Obsidian/MyVault/wiki/pages

# Generate slides from a wiki page
marp wiki-page.md -o slides.html

# Run qmd as MCP server for agent integration
qmd mcp --http
```

> `/wiki-setup` automatically checks whether these tools are installed and shows install commands for any that are missing.

## Obsidian Compatibility

- Create the wiki inside an Obsidian vault to leverage graph view, backlinks, and search
- Works as a pure markdown directory without Obsidian
- `.wiki-meta/` is automatically hidden from Obsidian
- Standard markdown links (not wikilinks) ensure portability

When `/wiki-setup` detects that the wiki is inside an Obsidian vault, it automatically checks for recommended plugins and reports their status. If the Obsidian CLI is installed and the app is running, it also enables enhanced features:

### Obsidian CLI Integration

When detected by `/wiki-setup`, the Obsidian CLI enhances wiki operations:

| Feature | CLI Command | Fallback |
|---------|------------|----------|
| Content search | `obsidian search:context` | Grep |
| Orphan detection | `obsidian orphans` | Regex link scan |
| Broken link detection | `obsidian unresolved` | File existence check |
| Backlink analysis | `obsidian backlinks` | Not available |
| Tag statistics | `obsidian tags counts` | Frontmatter parsing |

All vault-wide CLI results are filtered to the wiki boundary. The CLI is optional — all commands work without it via filesystem fallback.

**Recommended Obsidian plugins:**
- **Graph view** — see the shape of your wiki, hubs, and orphans
- **Dataview** — query page frontmatter (tags, sources) for dynamic tables
- **Marp Slides** — render Marp slide decks directly in Obsidian
- **Obsidian Web Clipper** — browser extension to clip web articles as markdown for quick ingest (install from https://obsidian.md/clipper)

## Auto-Ingest (SessionStart Hook)

The plugin includes a SessionStart hook that **automatically detects new or modified files** in the Obsidian vault every time a Claude Code session starts. No manual action needed — just write notes as usual, and the wiki stays up to date.

**How it works:**
1. On session start, the hook scans the vault for `.md` files modified since the last scan
2. If Obsidian CLI is available, `obsidian recents` supplements the scan (union + deduplicate, with mtime verification)
3. If new files are found, Claude is instructed to auto-ingest them
4. Files are grouped by topic and batch-processed
5. The wiki is updated with new knowledge, and auto-lint runs afterward

**Excluded from scanning:** To-do files, VPN passwords, `.obsidian/` internals, the wiki itself.

## deep-work Integration

Ingest deep-work session reports into the wiki:

```bash
/deep-wiki:wiki-ingest /path/to/deep-work/session/report.md
```

## Philosophy

This plugin implements the pattern described in Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

> *"The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages. Humans abandon wikis because the maintenance burden grows faster than the value. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass."*

The human's job is to curate sources, direct the analysis, ask good questions, and think about what it all means. The LLM's job is everything else.

## License

MIT
