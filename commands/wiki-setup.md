---
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion
description: Initialize deep-wiki configuration and scaffold an empty wiki. Run once to set up the wiki root path and create the initial directory structure.
argument-hint: "[wiki_root_path]"
---

# /wiki-setup — Initialize Deep-Wiki

Set up the deep-wiki knowledge base for first use.

## Steps

### 1. Determine Wiki Root

If an argument is provided, use it as the wiki root path. Otherwise, prompt the user:

> Where should the wiki be stored?
> A) Inside an Obsidian vault (provide path, e.g., ~/Obsidian/MyVault/wiki)
> B) A standalone directory (provide path, e.g., ~/wiki)

### 2. Create Config File

Write the configuration to `~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: <resolved_absolute_path>
```

### 3. Scaffold Wiki Structure

Create the directory structure at the wiki root:

```bash
mkdir -p "<wiki_root>/pages"
mkdir -p "<wiki_root>/.wiki-meta/sources"
mkdir -p "<wiki_root>/.wiki-meta/.versions"
```

Create the initial machine-readable files:

```bash
touch "<wiki_root>/log.jsonl"
```

```json
// <wiki_root>/.wiki-meta/index.json
{
  "pages": [],
  "generated_at": "<current_iso_timestamp>"
}
```

Create the initial human-readable wiki artifacts:

**`<wiki_root>/index.md`** — LLM-written catalog:

```markdown
# Wiki Index

This wiki is newly created and has no knowledge pages yet. Run `/wiki-ingest` to start building knowledge.

## Pages

- **Welcome** — Introduction to the wiki ([welcome.md](pages/welcome.md))
```

**`<wiki_root>/log.md`** — LLM-written chronicle:

```markdown
# Wiki Log

### <date> — Wiki Created
Initialized deep-wiki knowledge base. Ready for first ingest.
```

### 4. Create Seed Page

Create a welcome page at `pages/welcome.md` to prevent cold-start issues:

```markdown
---
title: "Welcome to Deep-Wiki"
sources: []
tags:
  - meta
aliases:
  - home
  - index
---

# Welcome to Deep-Wiki

This wiki is managed by Claude Code using the deep-wiki plugin.

## How It Works

- Use `/wiki-ingest` to add knowledge from sources (files, URLs, text)
- Use `/wiki-query` to search and ask questions
- Use `/wiki-lint` to check wiki health
- Use `/wiki-rebuild` to regenerate the index

Knowledge accumulates here over time, creating a persistent knowledge base.
```

### 5. Check Recommended Tools

#### 5a. CLI Tools

Check if the following CLI tools are installed:

```bash
which qmd 2>/dev/null   # markdown search engine (BM25 + vector search)
which marp 2>/dev/null   # markdown slide generator
```

Report the status of each tool and provide install commands for any that are missing:

| Tool | Purpose | Install |
|------|---------|---------|
| **qmd** | Local markdown search with BM25/vector search and LLM re-ranking. Can be used as an MCP server for tighter agent integration. | `npm install -g @tobilu/qmd` |
| **marp** | Generate slide presentations from markdown wiki pages. | `npm install -g @marp-team/marp-cli` |

#### 5b. Obsidian Plugin Check (if Obsidian vault)

If the wiki root is inside an Obsidian vault (i.e., a `.obsidian/` directory exists in a parent directory), check for recommended Obsidian plugins:

```bash
# Find the vault root (nearest ancestor with .obsidian/)
VAULT_ROOT="<detected_vault_root>"
PLUGINS_DIR="$VAULT_ROOT/.obsidian/plugins"
```

Check for these plugins:

| Plugin | Directory Name | Purpose |
|--------|---------------|---------|
| **Dataview** | `dataview` | Query page frontmatter to generate dynamic tables and lists from wiki metadata |
| **Marp Slides** | `marp-slides` | Render Marp slide decks directly in Obsidian |
| **Obsidian Web Clipper** | — (browser extension) | Browser extension to clip web articles as markdown for quick ingest |

For each missing plugin, print a recommendation:

```
Recommended Obsidian plugins:
  ✓ Dataview — installed
  ✗ Marp Slides — not found
    → Install from Obsidian Settings > Community Plugins > Browse > "Marp Slides"
  ℹ Obsidian Web Clipper — browser extension
    → Install from https://obsidian.md/clipper
```

If the wiki is NOT inside an Obsidian vault, skip this check entirely.

### 6. Log the Setup Event

Append to `log.jsonl`:

```json
{"ts":"<iso_timestamp>","action":"setup","source":"deep-wiki-init","pages_created":["welcome.md"],"pages_updated":[]}
```

### 7. Confirm

Report to the user:
- Wiki root location
- Created directory structure
- Next step: run `/wiki-ingest <source>` to start building the wiki
