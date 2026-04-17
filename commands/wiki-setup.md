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

**Platform note:** On Windows, the wiki_root path MUST be in POSIX form (e.g. `/c/Users/name/wiki` under Git Bash, `/mnt/c/Users/name/wiki` under WSL2). The SessionStart hook rejects Windows-native paths (`C:\...` or `C:/...`). If the user provides a Windows-native path, normalize it before writing to config.

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

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

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

#### 5c. Obsidian CLI Detection

> **Windows note:** The `obsidian` command must be on PATH within the shell running Claude Code. Typical install location: `%LOCALAPPDATA%\Programs\Obsidian\`. If `obsidian version` fails in Git Bash, the user must add the directory containing `obsidian.exe` to PATH before re-running setup.

If the wiki root is inside an Obsidian vault (detected in 5b), check for the Obsidian CLI:

**Step 1 — Detect CLI and running app:**

```bash
obsidian version 2>/dev/null
```

- If a version string is returned → CLI is installed and Obsidian app is running
- If the command fails or returns empty → CLI not installed or app not running → skip to step 6

**Step 2 — Get vault info:**

```bash
obsidian vault
```

Extract the vault name and path from the output. If the output format is unexpected, fall back to:
- `vault_path` = the `.obsidian/` parent directory already detected in Step 5b
- `vault_name` = the directory name of `vault_path`

**Step 3 — Compute `wiki_prefix`:**

Strip `vault_path` from `wiki_root` to get the vault-relative path:
- Example: vault_path=`/path/to/vault`, wiki_root=`/path/to/vault/deep-wiki` → prefix=`deep-wiki`
- **Edge case: wiki at vault root** — If `wiki_root == vault_path`, the prefix is empty. In this case, store `wiki_prefix: "."` and ensure all downstream path compositions use `pages/...` directly (not `./pages/...` or `/pages/...`). Callers must normalize: when `wiki_prefix` is `"."`, emit `pages/<page>.md` instead of `./<pages>/<page>.md`.

**Step 4 — Update config:**

If the config already contains an `obsidian_cli` block, **remove it first** (handles re-runs and CLI removal).

If CLI detection succeeded, append to `~/.claude/deep-wiki-config.yaml`:

```yaml
obsidian_cli:
  available: true
  vault_name: "<detected_vault_name>"
  vault_path: <detected_vault_path>
  wiki_prefix: "<computed_prefix>"
```

If CLI detection failed and an old `obsidian_cli` block exists, **delete it** to prevent stale config.

**Report in Step 7:**

If detected:
```
Obsidian CLI: ✓ detected (vault: "<vault_name>")
  → Wiki operations will use Obsidian CLI for search, backlinks, and orphan detection when available
```

If not detected:
```
Obsidian CLI: ✗ not detected
  → Using filesystem access only (enhanced search and graph features unavailable)
  → To enable: Obsidian 1.12.7+ required, then Settings → General → Command line interface
  → Troubleshooting: https://obsidian.md/help/cli#Troubleshooting
```

### 6. Log the Setup Event

Append to `log.jsonl`:

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

```json
{"ts":"<iso_timestamp>","action":"setup","source":"deep-wiki-init","pages_created":["welcome.md"],"pages_updated":[]}
```

### 7. Confirm

Report to the user:
- Wiki root location
- Created directory structure
- Next step: run `/wiki-ingest <source>` to start building the wiki
