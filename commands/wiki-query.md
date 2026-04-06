---
allowed-tools: Read, Bash, Glob, Grep
description: Search the wiki and generate an answer grounded in wiki content. Ask questions about accumulated knowledge in the wiki.
argument-hint: "<question>"
---

# /wiki-query — Search and Answer from the Wiki

Search wiki pages and generate an answer grounded in the wiki's accumulated knowledge.

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

## Important Rules

- This command is **read-only** — never modify wiki pages during a query
- Do not add information from general knowledge — only answer from wiki content
- If the wiki is empty or has no relevant pages, be honest about it
- Keep answers concise and well-structured
