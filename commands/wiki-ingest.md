---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, Agent
description: Ingest a source into the wiki — reads the source, creates or updates wiki pages, and tracks provenance. Accepts file paths, URLs, pasted text, or deep-work session folders.
argument-hint: "<source_path_or_url> [--synthesize]"
---

# /wiki-ingest — Add Knowledge to the Wiki

Read a source, extract knowledge, and create or update wiki pages.

## Prerequisites

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If it does not exist, tell the user to run `/wiki-setup` first.

Load the `wiki-schema` skill for page structure rules.

## Steps

### 1. Identify Source Type

Determine the source type from the argument:

- **URL**: Starts with `http://` or `https://` — fetch with WebFetch. If WebFetch is unavailable, use Bash with `curl` as fallback
- **File path**: Exists on filesystem — read with Read tool
- **Deep-work report**: Path contains a deep-work session folder with `report.md` — read the report
- **No argument**: Ask the user to paste text or provide a path/URL

### 2. Read Existing Wiki State

Read `.wiki-meta/index.json` to know existing pages, titles, tags, and aliases. This prevents duplicate page creation.

### 3. Acquire Lock

```bash
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "ERROR: Wiki is locked by another session. Try again later."; exit 1; }
```

Set up cleanup: the lock MUST be released when done (success or failure).

### 4. Analyze Source

Read the source content and determine:

- What new concepts/topics are covered?
- Do any existing pages overlap? (check `index.json` titles and aliases)
- Should this create new pages or update existing ones?

### 5. Generate Source Slug

Create a kebab-case slug from the source title or URL:
- URL: `karpathy-llm-wiki-gist`
- File: `architecture-doc-2026`
- Deep-work: `deep-work-session-2026-04-06`

### 6. Version Existing Pages (if updating)

For each page that will be updated, copy the current version to `.wiki-meta/.versions/`:

```bash
cp "<wiki_root>/pages/<page>.md" "<wiki_root>/.wiki-meta/.versions/<page>.v<N>.md"
```

Increment N based on existing versions. Prune versions beyond the last 3.

### 7. Write Pages

For each new or updated page:

- Follow the page template from `wiki-schema` skill
- Include required frontmatter: `title`, `sources`, `tags`, `aliases`
- Add the current source slug to the `sources` list
- Write clear, factual content grounded in the source material
- When **creating a new page**, only include information present in the source
- When **updating an existing page**, synthesize across all contributing sources — cross-source insights and connections are encouraged as long as every claim traces to at least one source
- Link to related existing pages using standard markdown links
- If the new source contradicts existing content, note both perspectives with attribution: "According to [Source A], X. However, [Source B] states Y."

Merge new information with existing content. Do not discard existing content. The page should grow richer with each ingest — this is the core accumulation principle.

### 8. Write Source Provenance

Create `.wiki-meta/sources/<slug>.yaml`:

```yaml
id: <slug>
title: "<source_title>"
ingested_at: "<iso_timestamp>"
type: <url|file|text|deep-work-report>
origin: "<url_or_path>"
content_hash: "<sha256_of_content>"
pages_created:
  - <new_page_filenames>
pages_updated:
  - <updated_page_filenames>
```

Compute the content hash using: `echo -n "<content>" | shasum -a 256 | cut -d' ' -f1`

### 9. Update Index

Read the current `.wiki-meta/index.json`, add/update entries for affected pages, update `generated_at` timestamp, write back.

### 10. Append to Log

Append one line to `log.jsonl`:

```json
{"ts":"<iso_timestamp>","action":"ingest","source":"<slug>","pages_created":["..."],"pages_updated":["..."]}
```

### 11. Update Human-Readable Wiki Artifacts

**Index.md** — Rewrite `<wiki_root>/index.md` as an LLM-authored natural language catalog of the wiki. Organize by tag groups, describe what each page covers in one sentence, and note connections between pages. This is a wiki artifact, not machine output.

**Log.md** — Append a short human-readable entry to `<wiki_root>/log.md` describing what was ingested and what changed, in natural language. Example:

```markdown
### 2026-04-06 — Ingested: Karpathy's LLM Wiki Gist
Created "LLM Wiki Philosophy" and "RAG vs Wiki Approach" pages covering the 3-layer wiki model and comparison with RAG. Source: URL gist.
```

These files are wiki artifacts written by the LLM for human readers, alongside the machine-readable `index.json` and `log.jsonl`.

### 12. Release Lock

```bash
rmdir "<wiki_root>/.wiki-meta/.wiki-lock" 2>/dev/null
```

### 13. Auto-Lint

Run an automatic health check after the ingest completes. This ensures the wiki stays healthy without the user needing to manually invoke `/wiki-lint`.

Perform these lint checks silently:

1. **Schema compliance** — verify all affected pages have required frontmatter
2. **Broken links** — check links in new/updated pages
3. **Index drift** — verify `index.json` matches actual page files
4. **Orphan detection** — check if any new pages are unlinked

**Auto-fix** what can be fixed without human judgment:
- Add missing pages to `index.json`
- Remove ghost entries from `index.json`
- Prune excess page versions (keep last 3)

**Report issues** that require human judgment (only if found):
- Schema violations (missing frontmatter)
- Broken links
- Orphan pages

If no issues are found, stay silent — do not output a lint report for a clean wiki.

### 14. Report

Show the user:
- Source: what was ingested
- Pages created: list with titles
- Pages updated: list with what changed
- Total wiki pages: count from index.json
- Lint issues (only if any were found)

## Multi-Source Synthesis

When the `--synthesize` flag is provided, or when multiple sources are given:

Spawn the `wiki-synthesizer` agent to handle cross-source analysis in a separate context window. Pass the source content and existing relevant pages to the agent. The agent returns page content; this command handles all wiki metadata (index, log, provenance, lock).

## Auto-Ingest (SessionStart Hook)

When the deep-wiki plugin's SessionStart hook detects new or modified files in the Obsidian vault, it provides a list of files via systemMessage. In this case:

1. Read the file list from the hook message
2. Group related files by directory/topic
3. For each group, follow the standard ingest workflow (Steps 1-14)
4. Use the `--synthesize` flag internally if multiple files cover related topics
5. After all files are processed, update `.wiki-meta/.last-scan` with the current timestamp

**Batch behavior:**
- Process files sequentially by group, not one-by-one
- Acquire the lock once for the entire batch, not per-file
- Append one log entry per source group, not per-file
- Run auto-lint once at the end, not after each file
- Keep the report concise — summarize what was ingested, not individual file details

## Error Handling

- If the lock cannot be acquired, report the error and stop
- If source cannot be read, report the error and stop
- Always release the lock in case of errors (use trap in bash operations)
- If a page write fails, release the lock and report which pages were/weren't written
