---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
description: Search the wiki and generate an answer grounded in wiki content. Ask questions about accumulated knowledge in the wiki.
argument-hint: "<question>"
---

# /wiki-query — Search and Answer from the Wiki

Search wiki pages and generate an answer grounded in the wiki's accumulated knowledge. When a query produces novel cross-page synthesis, the result is automatically filed back into the wiki.

## Prerequisites

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If missing, tell the user to run `/wiki-setup` first.

## Steps

### 1. Parse Question

Use the argument as the search query. If no argument, ask the user what they want to know.

### 2. Search Strategy

Perform a multi-layer search to find relevant pages:

**Layer 1 — Index scan:**
Read `.wiki-meta/index.json`. Match the query against page titles, tags, and aliases. Collect candidate page filenames.

**Layer 2 — Content search:**
Use Grep to search `pages/` directory for keywords from the query. Add matching files to candidates.

**Layer 3 — Read candidates:**
Read the top candidate pages (up to 10). Prioritize pages that matched in both Layer 1 and Layer 2.

### 3. Generate Answer

Synthesize an answer from the wiki pages:

- Ground every claim in specific wiki page content
- Cite sources using the format: `(from: page-title.md)`
- If the wiki has conflicting information across pages, note the conflict
- If the wiki does not contain enough information to answer, say so clearly and suggest running `/wiki-ingest` with relevant sources

### 4. Show Sources

After the answer, list the wiki pages consulted:

```
Sources consulted:
- react-hooks.md (matched: title)
- state-management.md (matched: content keyword "useState")
```

### 5. Auto-Filing — Write Back to Wiki

After generating the answer, evaluate whether the result should be filed back into the wiki. A result qualifies for auto-filing when **all** of the following are true:

1. The answer draws from **2 or more pages**
2. The synthesis produces **cross-page insight** — connections, comparisons, or conclusions not present in any single source page
3. The answer is **substantive** (not "the wiki doesn't have this" or a simple factual lookup that a single page already covers)

If the result qualifies:

**5a. Acquire Lock**

```bash
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "Wiki locked — skipping auto-file."; return; }
```

**5b. Check for Existing Page**

Search `index.json` for a page that already covers this topic (by title or alias). If found, **update** the existing page by merging the new synthesis. If not found, **create** a new page.

**5c. Write the Page**

- Filename: `query-<kebab-case-topic>.md` (e.g., `query-react-hooks-vs-classes.md`)
- Frontmatter:
  ```yaml
  ---
  title: "<descriptive title of the synthesis>"
  sources:
    - query-derived
  tags:
    - query-synthesis
    - <relevant tags from source pages>
  aliases: []
  ---
  ```
- Content: The synthesized answer with cross-references to the source pages
- Add a note at the top: `> This page was auto-generated from a wiki query and synthesizes content from multiple pages.`

**5d. Update Index and Log**

- Add/update the page entry in `.wiki-meta/index.json`
- Append to `log.jsonl`:
  ```json
  {"ts":"<iso_timestamp>","action":"query-filed","source":"query-derived","pages_created":["query-topic.md"],"pages_updated":[]}
  ```

**5e. Release Lock**

```bash
rmdir "<wiki_root>/.wiki-meta/.wiki-lock" 2>/dev/null
```

**5f. Notify User**

After the answer, briefly note:

```
📝 This synthesis was auto-filed as: query-react-hooks-vs-classes.md
```

If the result does NOT qualify for auto-filing, skip this step silently.

## Important Rules

- Do not add information from general knowledge — only answer from wiki content
- If the wiki is empty or has no relevant pages, be honest about it
- Keep answers concise and well-structured
- Auto-filing is silent when skipped — only notify the user when a page is actually created or updated
