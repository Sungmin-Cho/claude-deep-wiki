# deep-wiki

**[한국어](README.ko.md)**

An LLM-managed markdown wiki for persistent knowledge accumulation — a Claude Code plugin implementation of [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) philosophy.

> *"Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation."*
> — Andrej Karpathy

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

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and configured

### Install via Git

```bash
# 1. Clone the plugin repository
git clone https://github.com/Sungmin-Cho/claude-deep-wiki.git

# 2. Add it as a local marketplace
claude plugin marketplace add /path/to/claude-deep-wiki

# 3. Install the plugin
claude plugin install deep-wiki@<marketplace-name>
```

Alternatively, if you already have a local marketplace configured:

```bash
# 1. Clone into your local marketplace plugins directory
git clone https://github.com/Sungmin-Cho/claude-deep-wiki.git ~/.claude/local-marketplace/plugins/deep-wiki

# 2. Add the plugin entry to your marketplace.json
# 3. Update and install
claude plugin marketplace update <marketplace-name>
claude plugin install deep-wiki@<marketplace-name>
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
```

## Recommended Tools

Tools referenced in [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that enhance the wiki workflow.

### CLI Tools

| Tool | Purpose | Install |
|------|---------|---------|
| **qmd** | Local markdown search engine with BM25/vector search and LLM re-ranking. Also works as an MCP server. | `npm install -g @tobilu/qmd` |
| **marp** | Generate slide presentations (HTML/PDF/PPTX) from markdown wiki pages. | `npm install -g @marp-team/marp-cli` |

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

When `/wiki-setup` detects that the wiki is inside an Obsidian vault, it automatically checks for recommended plugins and reports their status.

**Recommended Obsidian plugins:**
- **Graph view** — see the shape of your wiki, hubs, and orphans
- **Dataview** — query page frontmatter (tags, sources) for dynamic tables
- **Marp Slides** — render Marp slide decks directly in Obsidian
- **Obsidian Web Clipper** — browser extension to clip web articles as markdown for quick ingest (install from https://obsidian.md/clipper)

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
