---
allowed-tools: Read, Bash, Glob, Grep
description: Check wiki health — find contradictions, orphan pages, broken links, schema violations, and stale content. Includes a status dashboard.
argument-hint: "[--fix]"
---

# /wiki-lint — Wiki Health Check

Inspect the wiki for structural issues, inconsistencies, and schema violations.

## Prerequisites

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If missing, tell the user to run `/wiki-setup` first.

Load the `wiki-schema` skill for validation rules. Read `wiki-schema.yaml` for the machine-readable schema definition.

## Steps

### 1. Gather Wiki Stats (Status Dashboard)

Report these metrics first:

- **Total pages**: Count of `.md` files in `pages/`
- **Total sources**: Count of `.yaml` files in `.wiki-meta/sources/`
- **Log entries**: Line count of `log.jsonl`
- **Last activity**: Most recent `ts` in `log.jsonl`
- **Tags**: Unique tags across all pages with counts
- **Version backups**: Count of files in `.wiki-meta/.versions/`

### 2. Schema Compliance Check

For each page in `pages/`, verify required frontmatter fields:

- `title` — must be present and non-empty
- `sources` — must be present (list, can be empty for manually created pages)
- `tags` — must be present and non-empty

Report pages that fail schema compliance.

### 3. Orphan Page Detection

An orphan page is one that:
- Is not linked from any other page (search all pages for `(<filename>)` pattern)
- Has no inbound references

Exclude `welcome.md` from orphan detection (it is the entry point).

### 4. Broken Link Detection

For each markdown link `[text](target.md)` found in pages:
- Check if `target.md` exists in `pages/`
- Report any broken links with the source page and target

### 5. Duplicate/Alias Conflict Detection

Check `index.json` for:
- Pages with identical titles
- Pages where one page's title matches another page's alias
- Suggest merge candidates

### 6. Source Provenance Check

For each page, check that every slug in `sources:` frontmatter has a corresponding `.wiki-meta/sources/<slug>.yaml` file. Report missing source provenance.

### 7. Semantic Contradiction Detection

Read pages that share the same tags or source slugs. For each group of related pages, check if any statements directly contradict each other. Focus on:

- Factual claims that conflict (e.g., "X uses approach A" vs "X uses approach B")
- Definitions that disagree across pages
- Temporal contradictions (a claim that was true at one time but superseded)

For each detected contradiction, report:
- The two pages involved
- The conflicting statements
- The source slugs behind each claim

This is a semantic check — read the actual page content, not just metadata. Flag contradictions as `[CONTRADICTION]` in the report. If the wiki has many pages, prioritize pages with overlapping tags.

### 8. Stale Version Pruning Check

Count versions in `.wiki-meta/.versions/` per page. Report pages with more than 3 versions (candidates for pruning).

### 9. Index Drift Detection

Compare `index.json` entries against actual page files:
- Pages in index but not on disk (ghost entries)
- Pages on disk but not in index (unindexed pages)

If drift is found, suggest running `/wiki-rebuild`.

### 10. Report

Present a structured report:

```
## Wiki Health Report

### Dashboard
- Pages: 42 | Sources: 15 | Last activity: 2026-04-06

### Issues Found
- [SCHEMA] 2 pages missing required frontmatter
- [ORPHAN] 3 pages have no inbound links
- [BROKEN] 1 broken link found
- [CONTRADICTION] 1 semantic contradiction between page-x.md and page-y.md
- [DRIFT] index.json is out of sync (2 unindexed pages)

### Recommendations
- Run /wiki-rebuild to fix index drift
- Review orphan pages: page-a.md, page-b.md, page-c.md
```

### 11. Auto-Fix (if --fix flag)

If the user passed `--fix`:
- Prune excess versions (keep last 3)
- Add missing pages to index.json
- Remove ghost entries from index.json
- Do NOT auto-fix content issues (schema violations, orphans, broken links) — these require human judgment
