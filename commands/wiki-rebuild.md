---
allowed-tools: Read, Write, Bash, Glob, Grep
description: Regenerate derived wiki files (index.json) from page frontmatter. Use when the index is out of sync or corrupted.
argument-hint:
---

# /wiki-rebuild — Regenerate Wiki Index

Rebuild derived artifacts from the source-of-truth page files.

## Prerequisites

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If missing, tell the user to run `/wiki-setup` first.

## Steps

### 1. Acquire Lock

```bash
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "ERROR: Wiki is locked by another session."; exit 1; }
```

### 2. Scan All Pages

Read every `.md` file in `pages/`. For each page, parse the YAML frontmatter to extract:
- `title`
- `tags`
- `aliases`
- filename

### 3. Regenerate index.json

Build a new `index.json` from the scanned data:

```json
{
  "pages": [
    {
      "file": "react-hooks.md",
      "title": "React Hooks",
      "tags": ["programming", "react"],
      "aliases": ["hooks", "useState"]
    }
  ],
  "generated_at": "<current_iso_timestamp>"
}
```

Sort pages alphabetically by filename.

### 4. Append to Log

```json
{"ts":"<iso_timestamp>","action":"rebuild","source":"manual","pages_created":[],"pages_updated":[]}
```

### 5. Auto-Lint

After rebuilding, run an automatic health check (same as wiki-ingest auto-lint):

1. **Schema compliance** — verify all pages have required frontmatter
2. **Broken links** — check links across all pages
3. **Orphan detection** — find pages with no inbound links

Auto-fix structural issues silently (prune excess versions, remove ghost index entries). Only report issues that need human judgment.

### 6. Release Lock and Report

Release the lock directory. Report:
- Total pages indexed
- Any pages with missing or malformed frontmatter (could not be indexed)
- Comparison: previous page count vs. current count
- Lint issues (only if any were found)
