---
name: wiki-schema
description: This skill defines the core schema and rules for managing a deep-wiki knowledge base. It should be activated whenever any wiki operation is performed — ingesting sources, querying pages, linting, rebuilding indexes, or validating page structure. Covers frontmatter requirements, kebab-case naming, markdown link conventions, source provenance files, index.json catalog, log.jsonl event log, concurrency locking, and page versioning.
user-invocable: false
---

# Wiki Schema — Core Rules for Wiki Management

Follow these rules for all wiki operations (ingest, query, lint, rebuild).

## Philosophy

Based on Karpathy's LLM Wiki model: instead of re-discovering knowledge each time (RAG), maintain a persistent markdown wiki where knowledge accumulates. The wiki is the artifact, not the conversation.

Three layers:
1. **Raw Sources** — Immutable inputs (files, URLs, text, reports)
2. **Wiki** — LLM-managed markdown pages (the accumulated knowledge)
3. **Schema** — This skill. Rules governing how the wiki is maintained.

## Wiki Root

The wiki root path is configured in the user's profile at `~/.claude/deep-wiki-config.yaml`. Read this file to determine the wiki location before any operation.

```yaml
# ~/.claude/deep-wiki-config.yaml
wiki_root: ~/path/to/wiki    # Required
```

## Storage Layout

```
<wiki_root>/
├── index.md                  # LLM-written human-readable catalog (wiki artifact)
├── log.md                    # LLM-written human-readable chronicle (wiki artifact)
├── .wiki-meta/
│   ├── index.json            # Machine-readable page catalog (derived, rebuildable)
│   ├── sources/              # Per-source provenance YAML files
│   └── .versions/            # Page backups before overwrite
├── log.jsonl                 # Append-only structured event log (machine-readable)
└── pages/                    # Wiki pages (flat structure, tag-based classification)
```

`index.md` and `log.md` are **wiki artifacts** — written by the LLM in natural language for human readers. `index.json` and `log.jsonl` are their machine-readable counterparts for programmatic use.

## Page Rules

### Structure

Every wiki page MUST have this frontmatter (see `templates/page-template.md`):

```yaml
---
title: "Page Title"
sources:
  - source-slug-1
tags:
  - tag-name
aliases: []
---
```

- `title`: Human-readable page title
- `sources`: List of source slugs that contributed content to this page
- `tags`: Classification tags (use instead of directory-based categories)
- `aliases`: Alternative names for this concept (prevents duplicate pages)

### Naming

- Use **kebab-case** filenames: `react-hooks.md`, `postgres-indexing.md`
- Flat structure within `pages/` — no subdirectories
- Before creating a new page, check `index.json` for existing pages with matching titles or aliases to prevent duplicates

### Linking

- Use standard markdown links: `[Page Title](page-name.md)`
- Do NOT use Obsidian wikilinks `[[...]]` in page content (portability)
- Cross-references go in the page body, NOT in frontmatter `related` fields

### Timestamps

- Do NOT put `created` or `updated` in frontmatter — these are tracked in `log.jsonl`
- To find when a page was created/updated, query `log.jsonl`

## Source Provenance

For each ingested source, create a YAML file at `.wiki-meta/sources/<slug>.yaml`:

```yaml
id: karpathy-llm-wiki
title: "Karpathy's LLM Wiki Gist"
ingested_at: "2026-04-06T15:00:00Z"
type: url
origin: "https://gist.github.com/karpathy/442a6bf..."
content_hash: "sha256:abc123..."
pages_created:
  - llm-wiki-philosophy.md
pages_updated: []
```

The `content_hash` field stores a hash of the source content at ingest time, enabling future re-ingest detection.

## Index

`.wiki-meta/index.json` is a machine-readable catalog:

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
  "generated_at": "2026-04-06T15:00:00Z"
}
```

This file is **derived** — it can always be rebuilt from page frontmatter using `/wiki-rebuild`. Update it during ingest, but never treat it as the source of truth.

## Event Log

`log.jsonl` is append-only. Each line is one event:

```json
{"ts":"2026-04-06T15:00:00Z","action":"ingest","source":"karpathy-llm-wiki","pages_created":["llm-wiki-philosophy.md"],"pages_updated":[]}
```

Actions: `ingest`, `update`, `lint`, `rebuild`, `delete`

## Concurrency

Acquire a `mkdir`-based directory lock at `.wiki-meta/.wiki-lock` before any write operation. Release on exit. See `references/storage-layout.md` for the full lock protocol and stale lock recovery.

## Versioning

Before overwriting an existing page, copy the current version to `.wiki-meta/.versions/<page-name>.v<N>.md`. Keep the last 3 versions. Prune older versions during auto-lint. See `references/storage-layout.md` for details.

## Auto-Lint

Lint runs **automatically** after every write operation (`wiki-ingest`, `wiki-rebuild`, and `wiki-query` auto-filing). Users do not need to invoke `/wiki-lint` manually — it is only needed for on-demand deep inspection or `--fix` on legacy issues.

Auto-lint checks: schema compliance, broken links, index drift, orphan detection. It auto-fixes structural issues (index drift, excess versions) silently and only reports issues requiring human judgment.

## Query Auto-Filing

When `/wiki-query` produces a synthesis that draws from 2+ pages and creates novel cross-page insights, the result is automatically filed back into the wiki as a `query-synthesis` tagged page. This implements Karpathy's principle that valuable query results should compound back into the wiki. Pages created this way use the `query-derived` source slug and `query-<topic>.md` naming convention.

## Additional Resources

### Schema Definition
- **`wiki-schema.yaml`** — Machine-readable schema for validation tools

### Templates
- **`templates/page-template.md`** — Required page structure template

### References
- **`references/storage-layout.md`** — Detailed storage structure rationale, source provenance format, and concurrency lock protocol
- **`references/recommended-tools.md`** — CLI tools (qmd, Marp) and Obsidian plugins (Dataview, Web Clipper) that enhance the wiki workflow
