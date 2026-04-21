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

#### Obsidian CLI Liveness Check

If the config contains `obsidian_cli.available: true`, check if the Obsidian app is currently running:

```bash
obsidian version 2>/dev/null
```

- **Success** → Set `OBS_LIVE=true`. Read `wiki_prefix` from config for CLI path scoping.
- **Failure** → Set `OBS_LIVE=false`. Note in the final report: "Obsidian CLI unavailable (app not running) — using filesystem fallback."

If the config does not contain `obsidian_cli`, set `OBS_LIVE=false` (filesystem-only mode).

## Steps

### 1. Identify Source Type

Determine the source type from the argument **without reading file bodies or fetching URLs** — the agent is responsible for source I/O and hashing:

- **URL**: Starts with `http://` or `https://` → type `url`, origin = the URL.
- **Deep-work report**: Path resolves to a `report.md` inside a deep-work session folder (contains `.claude/deep-work/sessions/` or similar) → type `deep-work-report`, origin = resolved `report.md` path.
- **File path**: Exists on filesystem and is not a deep-work report → type `file`, origin = absolute path.
- **No argument (pasted text)**: Ask the user to paste text, generate a slug (from the first non-empty line or a timestamp), and record `{slug, pending_text, type: "text"}` — but do NOT write the inbox file yet. The inbox write happens in Step 6.5 after lock acquisition so concurrent sessions can't race on the same `.inbox/<slug>.txt` path.

Main does NOT fetch URL bodies or read source file contents at this step. It only classifies sources and defers pasted-text materialization until after the lock is held.

### 2. Read Existing Wiki State

Read `.wiki-meta/index.json` to know existing pages, titles, tags, and aliases. This is a small, low-context read used for the overlap filter in Step 4 and for index updates in Step 9.

### 3. Acquire Lock

```bash
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "ERROR: Wiki is locked by another session. Try again later."; exit 1; }
```

Set up cleanup: the lock MUST be released when done (success or failure).

### 4. Pre-filter Overlap Candidates

Identify existing pages that *might* overlap with the incoming sources. This is a coarse filter to narrow what the agent needs to read — the agent makes the final create-vs-update decision.

- From `index.json`, collect pages whose `title`, `aliases`, or `tags` match keywords extracted from the source (title, URL slug, deep-work session name, etc.).
- **If `OBS_LIVE`**, supplement with Obsidian search:
  ```bash
  obsidian search:context query="<keywords>" path="<wiki_prefix>/pages" format=json
  ```
- Deduplicate into a list of page filenames (basename only, e.g. `system-architecture.md`). This list may be empty for fresh topics.

Main MUST NOT read page bodies at this step — only metadata from `index.json` and the Obsidian index. Page bodies are for the agent.

### 5. Generate Source Slug

Create a kebab-case slug from the source title or URL:
- URL: `karpathy-llm-wiki-gist`
- File: `architecture-doc-2026`
- Deep-work: `deep-work-session-2026-04-06`

### 6. Snapshot Pre-batch State

Before dispatching to the agent, capture which pages exist in `pages/` right now. This snapshot is used in Step 8 to classify agent output into `pages_created` vs `pages_updated` authoritatively, regardless of what the agent itself reports.

```bash
PRE_BATCH_PAGES=$(ls "<wiki_root>/pages/" 2>/dev/null | sort)
```

### 6.5. Materialize Inbox Files (type: text only)

For each pasted-text source recorded in Step 1 (`type: text`), write its content to `<wiki_root>/.wiki-meta/.inbox/<slug>.txt` now — under the lock — and set its `origin` to the absolute path. Track each path in `INBOX_FILES` so the trap from Step 12 (and Error Handling) can delete exactly these files on exit.

```bash
mkdir -p "<wiki_root>/.wiki-meta/.inbox"
INBOX_FILES=()
# For each text source (pseudo-code):
#   printf '%s' "$pending_text" > "<wiki_root>/.wiki-meta/.inbox/$slug.txt"
#   INBOX_FILES+=("<wiki_root>/.wiki-meta/.inbox/$slug.txt")
```

Sources of other types (`url`, `file`, `deep-work-report`) are unchanged and have their `origin` already set from Step 1.

### 7. Dispatch to wiki-synthesizer (always)

Spawn the `wiki-synthesizer` agent via the Agent tool. This happens for **every** ingest — single-source, multi-source, URL, file, pasted text, or deep-work report alike. The main session does not read source content or page bodies; it only passes paths and the candidate list.

**Input and output contracts are defined in `agents/wiki-synthesizer.md` (Input contract / Output contract sections). That file is the single source of truth. This step summarizes what the caller does with the returned manifest; for field semantics, see the agent file.**

Input (summary):
- `wiki_root`
- `sources` — list of `{slug, origin, type}`
- `candidates` — filenames from Step 4 (hint only; agent widens when needed per its Rule 5)

Output (summary): structured entries for `created` / `updated` carrying `{file, title, tags, aliases, sources}`, plus `versioned`, `source_hashes` (per-slug sha256), and `failed` (may include `orphan_version`).

If `failed` is non-empty, continue with metadata updates for whatever succeeded and include the failures in the final report (Step 14). Always release the lock. **In auto-ingest mode, do NOT promote `.pending-scan → .last-scan` on any partial or full failure** — the next session's hook will re-detect the window. See Error Handling below.

### 8. Reconcile, Classify, and Write Source Provenance

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

**a. Reconcile against disk.** For each entry in the agent's `created` ∪ `updated`, verify `<wiki_root>/pages/<file>` actually exists (`test -f`). Any entry whose file is missing is moved to `failed` with reason `"agent reported written but file not present"`, and its `orphan_version` (if any) is carried over. This catches agent crashes or manifest lies without re-reading any page body.

**b. Validate filenames.** Every `file` value must match `^[a-z0-9][a-z0-9-]*\.md$`. Reject (move to `failed`) any entry with a filename containing path separators or escape sequences. Defense in depth against manifest corruption.

**c. Classify authoritatively.** Using `PRE_BATCH_PAGES` from Step 6 as the authority (NOT the agent's self-report), split the union of surviving `created` ∪ `updated` entries into two canonical groups by `file`:

- `CREATED_ENTRIES` — entries whose `file` was absent from `PRE_BATCH_PAGES`
- `UPDATED_ENTRIES` — entries whose `file` was present in `PRE_BATCH_PAGES`

If the agent's self-classification disagrees (e.g. agent claimed `created` for a pre-existing file), trust the snapshot and note the discrepancy in the final report.

> **Classification rule:** A page filename belongs in `pages_created` ONLY if the page did not exist in `pages/` at the start of this ingest. If the page already existed (even if this is the first time *this source* contributed to it), classify it under `pages_updated`. Rationale: `log.jsonl` is used to reconstruct per-page creation history; a page must have exactly one `pages_created` entry across the entire log.

**d. Write per-source provenance.** For **each** source in the batch, create `<wiki_root>/.wiki-meta/sources/<slug>.yaml`:

```yaml
id: <slug>
title: "<source_title>"
ingested_at: "<iso_timestamp>"
type: <url|file|text|deep-work-report>
origin: "<url_or_path>"
content_hash: "<source_hashes[slug] from agent manifest>"
pages_created:
  - <files in CREATED_ENTRIES whose entry.sources contains this slug>
pages_updated:
  - <files in UPDATED_ENTRIES whose entry.sources contains this slug>
```

Per-slug `pages_created`/`pages_updated` filtering uses each entry's `sources` list — a page only lists a slug if that slug actually contributed to it. This preserves per-source provenance in multi-source batches (`wiki-lint`'s source-provenance invariant continues to hold: every page's frontmatter `sources:` slug has a matching `.wiki-meta/sources/<slug>.yaml` whose `pages_*` includes that page).

`content_hash` comes directly from the agent's `source_hashes` map — the caller does NOT re-fetch the URL or re-read the file. This guarantees the hash reflects exactly the bytes the agent ingested.

### 9. Update Index

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Read the current `.wiki-meta/index.json`. For each entry in `CREATED_ENTRIES` ∪ `UPDATED_ENTRIES`, use the entry's `{file, title, tags, aliases}` directly — do NOT re-read the page body. `CREATED_ENTRIES` produce new index entries; `UPDATED_ENTRIES` overwrite existing ones. Update `generated_at` to the current UTC timestamp, write back.

### 10. Append to Log

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Append one log line **per source in the batch**, using the per-slug filtered lists from Step 8d:

```json
{"ts":"<iso_timestamp>","action":"ingest","source":"<slug>","pages_created":[...filtered_for_slug],"pages_updated":[...filtered_for_slug]}
```

For a single-source ingest this is one line; for multi-source batch it is one line per source, identical `ts`. This matches the per-source yaml written in Step 8d — any page whose frontmatter `sources:` field lists a given slug MUST appear under that slug's log line (`pages_created` or `pages_updated`).

### 11. Update Human-Readable Wiki Artifacts

**Index.md** — Rewrite `<wiki_root>/index.md` as an LLM-authored natural language catalog of the wiki. Organize by tag groups, describe what each page covers in one sentence, and note connections between pages. This is a wiki artifact, not machine output.

**Log.md** — Append a short human-readable entry to `<wiki_root>/log.md` describing what was ingested and what changed, in natural language. Example:

```markdown
### 2026-04-06 — Ingested: Karpathy's LLM Wiki Gist
Created "LLM Wiki Philosophy" and "RAG vs Wiki Approach" pages covering the 3-layer wiki model and comparison with RAG. Source: URL gist.
```

These files are wiki artifacts written by the LLM for human readers, alongside the machine-readable `index.json` and `log.jsonl`.

### 12. Release Lock (and Inbox Cleanup)

On the success path: delete each inbox file this invocation wrote (tracked in `INBOX_FILES` from Step 6.5), then release the lock.

```bash
# Delete only the inbox files this invocation created — never a wildcard,
# to avoid deleting files from a concurrent session that holds the lock next.
for f in "${INBOX_FILES[@]}"; do rm -f "$f"; done
rmdir "<wiki_root>/.wiki-meta/.wiki-lock" 2>/dev/null
```

The same two operations (inbox cleanup + rmdir) must also run on any error exit — register them in a bash `trap` set up at lock-acquisition time. See Error Handling.

### 13. Auto-Lint

Run an automatic health check after the ingest completes. This ensures the wiki stays healthy without the user needing to manually invoke `/wiki-lint`.

Perform these lint checks silently:

1. **Schema compliance** — verify all affected pages have required frontmatter
2. **Broken links** — check links in new/updated pages
3. **Index drift** — verify `index.json` matches actual page files
4. **Orphan detection** — check if any new pages are unlinked

**If `OBS_LIVE`**, enhance checks 2 and 4 with Obsidian CLI:

```bash
# Orphan detection — use Obsidian's link graph (more accurate than regex)
# NOTE: orphans returns vault-wide results, format=json not supported
obsidian orphans 2>/dev/null
# → Parse line-by-line, keep ONLY entries starting with "<wiki_prefix>/pages/"
# → Discard all other vault notes. On parse failure, fall back to regex scan.

# Broken link detection — use Obsidian's unresolved link tracking
obsidian unresolved format=json 2>/dev/null
# → Filter: keep only entries where source OR target is under "<wiki_prefix>/pages/"

# Backlink analysis for new/updated pages
obsidian backlinks path="<wiki_prefix>/pages/<page>.md" format=json
```

> **Wiki boundary filtering is mandatory.** `obsidian orphans` and `obsidian unresolved` return vault-wide results. Always post-filter against `<wiki_prefix>/pages/` to avoid reporting unrelated vault notes as wiki issues.

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

## Agent Delegation (always on)

Every ingest — single-source, multi-source, URL, file, or deep-work report — dispatches to the `wiki-synthesizer` agent at Step 7. The agent owns source reading, page-body reading, create-vs-update judgment, page writing, and version backup; this command owns lock, pre-batch snapshot, metadata (index.json, log.jsonl, sources/*.yaml), human artifacts (index.md, log.md), and auto-lint. This separation keeps page content out of main's context window, which matters especially for batch auto-ingests (see below).

The `--synthesize` flag remains accepted for backward compatibility but is now a **hint only**: it signals the caller expects cross-source synthesis, which the agent already performs for any batch with multiple sources. No branching logic is gated on this flag.

## Auto-Ingest (SessionStart Hook)

When the deep-wiki plugin's SessionStart hook detects new or modified files in the Obsidian vault, it writes a *pending* scan timestamp to `.wiki-meta/.pending-scan` (NOT `.last-scan`) and emits a systemMessage listing the candidates. This command is responsible for promoting the pending timestamp to committed only after the batch succeeds.

In this case:

1. Read the file list from the hook message
2. **Capture the pending timestamp at the start of the batch**:
   ```bash
   BATCH_PENDING=$(cat "<wiki_root>/.wiki-meta/.pending-scan" 2>/dev/null || true)
   ```
   This "snapshot" lets us detect concurrent hook activity: if another session's hook runs and overwrites `.pending-scan` during our batch, we must NOT promote a timestamp later than what we actually covered.
3. Group related files by directory/topic
4. For each group, follow the standard ingest workflow (Steps 1-14). Each group is a full ingest cycle minus lock acquisition — critically, `PRE_BATCH_PAGES` (Step 6) is captured **per group** (NOT once for the whole batch), so pages created by an earlier group are correctly classified as `pages_updated` if a later group touches them.
5. Each group is dispatched to `wiki-synthesizer` as a multi-source batch (Step 7) — no flag needed
6. **After all files are processed successfully, and before the `rmdir` that releases the `.wiki-lock` directory** (i.e. between writing the last page/log entry and releasing the lock), promote `.pending-scan` → `.last-scan` with race and size guards:
   ```bash
   PENDING_FILE="<wiki_root>/.wiki-meta/.pending-scan"
   LAST_FILE="<wiki_root>/.wiki-meta/.last-scan"
   if [ -s "$PENDING_FILE" ]; then
     CURRENT_PENDING=$(cat "$PENDING_FILE")
     # TS_RE mirrors hooks/scripts/scan-vault-changes.sh — keep in sync.
     TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
     if [[ "$CURRENT_PENDING" =~ $TS_RE ]]; then
       if [ -n "$BATCH_PENDING" ] && [ "$CURRENT_PENDING" = "$BATCH_PENDING" ]; then
         # No concurrent hook overwrote .pending-scan during this batch;
         # safe to commit the full pending window.
         mv "$PENDING_FILE" "$LAST_FILE"
       else
         # Another hook ran during our batch. We processed files up to
         # BATCH_PENDING only — commit that, leave the newer pending
         # timestamp in place so the next session processes the remainder.
         # Validate BATCH_PENDING against TS_RE before writing: it was
         # captured with `cat ... || true` (no validation), so garbage
         # residue in .pending-scan could otherwise be written raw to
         # .last-scan until the next hook's read-side regex rejects it.
         if [[ "$BATCH_PENDING" =~ $TS_RE ]]; then
           echo "$BATCH_PENDING" > "$LAST_FILE"
         fi
       fi
     fi
   fi
   ```
   **Promotion ordering**: this promotion block MUST run before the `rmdir "<wiki_root>/.wiki-meta/.wiki-lock"` call, so that a crashing session cannot leave `.last-scan` advanced past what was actually ingested. If ingest partially fails or is skipped, do NOT promote — `.pending-scan` remains and the next session's hook will re-detect the same window (no data loss).

**Manual ingest (no hook):** If `/wiki-ingest` is invoked directly (no preceding SessionStart hook), `$BATCH_PENDING` is empty and the promotion block is a no-op. This is intentional — `.last-scan` advances only via hook-driven batches. Manual ingests process whatever source path the user specifies and do not modify scan-window tracking.

**Batch behavior:**
- Process files sequentially by group, not one-by-one
- Acquire the lock once for the entire batch, not per-file
- Append one log entry per source group, not per-file
- Run auto-lint once at the end, not after each file
- Keep the report concise — summarize what was ingested, not individual file details

## Error Handling

- If the lock cannot be acquired, report the error and stop
- If the `wiki-synthesizer` agent cannot be spawned or returns an unparseable response, release the lock and report the error. Do NOT promote `.pending-scan` — the next session will re-detect the window. "Unparseable" means one of: (a) not valid JSON, (b) missing any of `created`/`updated`/`versioned`/`source_hashes`/`failed` at the top level, (c) entries in `created`/`updated` missing required fields (`file`/`title`/`tags`/`aliases`/`sources`), (d) `source_hashes` missing a slug the caller passed in
- Always release the lock in case of errors (use trap in bash operations)
- **Inbox cleanup (type: text)**: The trap that releases the lock also deletes each file in `INBOX_FILES` (populated in Step 6.5). Never use `.inbox/*.txt` wildcards — stale inbox files from a prior crashed session belong to that session and may still be needed for recovery. This cleanup runs on success AND failure so pasted text never lingers on disk
- **Orphan versions**: If any `failed` entry carries an `orphan_version`, surface it in the Step 14 report so the user knows a backup exists for a page that did NOT get overwritten. Auto-lint's retention prune (Step 13) handles actual cleanup — no special action here
- If the agent returns `failed` entries (partial success): proceed with metadata updates for the succeeded pages and include the failures in the Step 14 report. **Do NOT promote `.pending-scan` on any partial or full failure** — the next session's hook will re-detect and re-process the window (no data loss). This matches the original "process all files successfully before promoting" semantics
