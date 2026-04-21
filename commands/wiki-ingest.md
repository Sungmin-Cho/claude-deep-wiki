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

Determine the source type from the argument **without reading the content** — the agent is responsible for source I/O:

- **URL**: Starts with `http://` or `https://` → type `url`. For deep-work session folders, the folder path contains `report.md` → type `deep-work-report`. If the path looks like a deep-work session (contains `.claude/deep-work/sessions/` or similar), resolve to its `report.md`.
- **File path**: Exists on filesystem → type `file`
- **Deep-work report**: Path resolves to a `report.md` inside a deep-work session folder → type `deep-work-report`
- **No argument**: Ask the user to paste text or provide a path/URL

Main does NOT fetch URL bodies or read file contents at this step. It only classifies the source so the correct `type` can be written to provenance later.

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

Before dispatching to the agent, capture which pages exist in `pages/` right now. This snapshot is used in Step 9 to classify agent output into `pages_created` vs `pages_updated` authoritatively, regardless of what the agent itself reports.

```bash
PRE_BATCH_PAGES=$(ls "<wiki_root>/pages/" 2>/dev/null | sort)
```

### 7. Dispatch to wiki-synthesizer (always)

Spawn the `wiki-synthesizer` agent via the Agent tool. This happens for **every** ingest — single-source, multi-source, URL, file, or deep-work report alike. The main session does not read source content or page bodies; it only passes paths and the candidate list.

Pass the following input to the agent:

- `wiki_root` — absolute wiki root path
- `sources` — list of `{slug, origin, type}` descriptors (one per source in this batch)
- `candidates` — filenames from Step 4

The agent reads sources, reads candidates, decides create-vs-update per topic, versions any page it will overwrite into `.wiki-meta/.versions/<name>.v<N>.md`, and writes pages under `pages/`. It returns a JSON manifest:

```json
{
  "created":   ["..."],
  "updated":   ["..."],
  "versioned": [".wiki-meta/.versions/..."],
  "failed":    [{"file": "...", "reason": "..."}]
}
```

If `failed` is non-empty, continue with metadata updates for whatever succeeded and include the failures in the final report (Step 14). Always release the lock. **In auto-ingest mode, do NOT promote `.pending-scan → .last-scan` on any partial or full failure** — the next session's hook will re-detect the window. See Error Handling below.

### 8. Classify Agent Output and Write Source Provenance

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

**Classify first.** Using `PRE_BATCH_PAGES` from Step 6 as the authority (NOT the agent's self-report), split the union of the agent's `created` and `updated` into two canonical lists:

- `CREATED` — filenames absent from `PRE_BATCH_PAGES`
- `UPDATED` — filenames present in `PRE_BATCH_PAGES`

If the agent's self-classification disagrees (e.g. agent claimed `created` for a pre-existing file), trust the snapshot and note the discrepancy in the final report.

> **Classification rule:** A page filename belongs in `pages_created` ONLY if the page did not exist in `pages/` at the start of this ingest. If the page already existed (even if this is the first time *this source* contributed to it), classify it under `pages_updated`. Rationale: `log.jsonl` is used to reconstruct per-page creation history; a page must have exactly one `pages_created` entry across the entire log.

**Write provenance.** Create `.wiki-meta/sources/<slug>.yaml`:

```yaml
id: <slug>
title: "<source_title>"
ingested_at: "<iso_timestamp>"
type: <url|file|text|deep-work-report>
origin: "<url_or_path>"
content_hash: "<sha256_of_content>"
pages_created:
  - <CREATED filenames>
pages_updated:
  - <UPDATED filenames>
```

Compute the content hash without loading source content into main's context — pipe directly to `shasum`:

- File: `shasum -a 256 "<path>" | cut -d' ' -f1`
- URL: `curl -sL "<url>" | shasum -a 256 | cut -d' ' -f1`
- Inline text: `printf '%s' "<text>" | shasum -a 256 | cut -d' ' -f1`

### 9. Update Index

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Read the current `.wiki-meta/index.json`, add entries for each filename in `CREATED` and update entries for each in `UPDATED`, update `generated_at` timestamp, write back.

### 10. Append to Log

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Append one line to `log.jsonl` using the classified `CREATED` / `UPDATED` lists from Step 8:

```json
{"ts":"<iso_timestamp>","action":"ingest","source":"<slug>","pages_created":[...CREATED],"pages_updated":[...UPDATED]}
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
- If the `wiki-synthesizer` agent cannot be spawned or returns an unparseable response, release the lock and report the error. Do NOT promote `.pending-scan` — the next session will re-detect the window
- Always release the lock in case of errors (use trap in bash operations)
- If the agent returns `failed` entries (partial success): proceed with metadata updates for the succeeded pages and include the failures in the Step 14 report. **Do NOT promote `.pending-scan` on any partial or full failure** — the next session's hook will re-detect and re-process the window (no data loss). This matches the original "process all files successfully before promoting" semantics
