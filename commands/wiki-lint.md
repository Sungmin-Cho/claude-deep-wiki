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

#### Obsidian CLI Liveness Check

If the config contains `obsidian_cli.available: true`, check if the Obsidian app is running:

```bash
obsidian version 2>/dev/null
```

- **Success** → `OBS_LIVE=true`, read `wiki_prefix` from config.
- **Failure** → `OBS_LIVE=false`, use filesystem-only checks.

## Steps

### 1. Gather Wiki Stats (Status Dashboard)

Report these metrics first:

- **Total pages**: Count of `.md` files in `pages/`
- **Total sources**: Count of `.yaml` files in `.wiki-meta/sources/`
- **Log entries**: Line count of `log.jsonl`
- **Last activity**: Most recent `ts` in `log.jsonl`
- **Tags**: Unique tags across all pages with counts
- **Version backups**: Count of files in `.wiki-meta/.versions/`

**If `OBS_LIVE`**, enhance tag statistics:

```bash
obsidian tags counts sort=count format=json
```

> **Wiki boundary filter required.** The tags command may return vault-wide results (`path=` may not support folder scoping). Post-filter the output to include only tags from files under `<wiki_prefix>/pages/`.

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

**If `OBS_LIVE`**, use Obsidian's link graph for more accurate orphan detection:

```bash
obsidian orphans 2>/dev/null
```

> **Wiki boundary filter required.** This command returns vault-wide results and does not support `path=` scoping or `format=json`. Parse line-by-line and keep **only** entries starting with `<wiki_prefix>/pages/`. Discard all other vault notes. On parse failure, fall back to the regex-based scan above.

### 4. Broken Link Detection

For each markdown link `[text](target.md)` found in pages:
- Check if `target.md` exists in `pages/`
- Report any broken links with the source page and target

**If `OBS_LIVE`**, supplement with Obsidian's unresolved link tracking:

```bash
obsidian unresolved format=json 2>/dev/null
```

> **Wiki boundary filter required.** This returns vault-wide results. Keep only entries where the source **or** target is under `<wiki_prefix>/pages/`. Discard unrelated vault entries.

### 5. Duplicate/Alias Conflict Detection

Check `index.json` for:
- Pages with identical titles
- Pages where one page's title matches another page's alias
- Suggest merge candidates

### 6. Log Invariant Check — `pages_created` Duplication

Parse `log.jsonl` and flag any page filename that appears in `pages_created` **more than once** across all entries. By invariant, each page is "created" exactly once over the entire history; duplicates indicate a prior ingest misclassified an update as a create.

Example jq query (reference):
```bash
jq -r 'select(.action=="ingest" or .action=="query-filed")
       | .pages_created[]? | select(type=="string")' "<wiki_root>/log.jsonl" \
  | sort | uniq -c | awk '$1 > 1 { print $2, "appears " $1 " times in pages_created" }'
```

Report findings as `[LOG-INVARIANT]` — no auto-fix (historical log is append-only). Fix forward in future ingests by respecting the pages_created classification rule.

### 7. Source Provenance Check

For each page, check that every slug in `sources:` frontmatter has a corresponding `.wiki-meta/sources/<slug>.yaml` file. Report missing source provenance.

### 8. Semantic Contradiction Detection

Read pages that share the same tags or source slugs. For each group of related pages, check if any statements directly contradict each other. Focus on:

- Factual claims that conflict (e.g., "X uses approach A" vs "X uses approach B")
- Definitions that disagree across pages
- Temporal contradictions (a claim that was true at one time but superseded)

For each detected contradiction, report:
- The two pages involved
- The conflicting statements
- The source slugs behind each claim

This is a semantic check — read the actual page content, not just metadata. Flag contradictions as `[CONTRADICTION]` in the report. If the wiki has many pages, prioritize pages with overlapping tags.

### 9. Stale Version Pruning Check

Count versions in `.wiki-meta/.versions/` per page. Report pages with more than 3 versions (candidates for pruning).

### 10. Index Drift Detection

Compare `index.json` entries against actual page files:
- Pages in index but not on disk (ghost entries)
- Pages on disk but not in index (unindexed pages)

If drift is found, suggest running `/wiki-rebuild`.

### 11. Report

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

### 12. Auto-Fix (if --fix flag)

If the user passed `--fix`:
- Prune excess versions (keep last 3)
- Add missing pages to index.json
- Remove ghost entries from index.json
- Do NOT auto-fix content issues (schema violations, orphans, broken links) — these require human judgment
