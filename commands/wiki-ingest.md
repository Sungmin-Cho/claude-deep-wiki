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

**(v1.2.0+) Derive `slug` for every source at end of Step 1** (IW4 review fix — formerly Step 5's responsibility, moved here so Step 1.5's hash-skip can locate `<wiki>/.wiki-meta/sources/<slug>.yaml`). Apply Step 5's algorithm now: URL → `karpathy-llm-wiki-gist`-style kebab from the URL slug; file path → kebab from `basename` minus `.md`; deep-work session → `deep-work-session-<YYYY-MM-DD>`. Each tuple in `$SOURCES` MUST carry `{slug, origin, type}` (or your equivalent encoding) by the time Step 1.5 runs. Step 5 is now a no-op for sources already carrying a `slug` (kept in the spec only for backward-readability with v1.1.x docs).

Main does NOT fetch URL bodies or read source file contents at this step. It only classifies sources, derives slugs, and defers pasted-text materialization until after the lock is held.

### 1.5. Re-Ingest Hash Skip (v1.2.0+)

For each source identified in Step 1 with `type ∈ {file, deep-work-report}`, check whether its current bytes' sha256 matches `<wiki_root>/.wiki-meta/sources/<slug>.yaml:content_hash`. If a match is found, **drop the source from the batch** and append one log entry recording the skip.

> **Slug derivation prerequisite (NC1 review note):** the pre-v1.2.0 `/wiki-ingest` generated slugs only in Step 5 (after this Step 1.5). The hash-skip lookup needs a slug to find the existing yaml — therefore **move slug generation to the END of Step 1** (apply the same kebab-case algorithm Step 5 uses: URL → `karpathy-llm-wiki-gist`, file path → `architecture-doc-2026`, deep-work session → `deep-work-session-2026-04-06`). Each source descriptor in `$SOURCES` MUST carry a `slug` field by the time this Step 1.5 runs. Step 5 then becomes a no-op (or emits the same pre-computed slugs to a downstream variable). Slug derivation is deterministic on `origin`, so this re-ordering does not change provenance semantics.

```bash
# Pre-condition: each source descriptor already has a slug, computed at end of
# Step 1 using Step 5's algorithm (NC1 fix). The encoding shown below is one
# possible tuple serialization — adjust to your /wiki-ingest implementation.
for src in "${SOURCES[@]}"; do
  slug="${src%%|*}"             # 'slug|origin|type' tuple — set in Step 1
  origin="${src#*|}"; origin="${origin%|*}"
  type="${src##*|}"

  # URL and text types have unstable bytes between hook and ingest; skip the skip-check for them
  case "$type" in
    url|text) continue ;;
  esac

  yaml="$WIKI_ROOT/.wiki-meta/sources/$slug.yaml"
  [ ! -f "$yaml" ] && continue   # First-time ingest — proceed normally

  prev_hash=$(grep '^content_hash:' "$yaml" | sed -E 's/^content_hash:[[:space:]]*"?(sha256:)?([0-9a-f]{64})"?.*$/\2/')
  # bash 3.2: =~ requires [[ ]]; single [ ] does not support it (runtime error).
  [[ "$prev_hash" =~ ^[0-9a-f]{64}$ ]] || continue   # Pre-v1.1.4 sentinel → fall through to recompute path

  # shasum on macOS/BSD; sha256sum on Linux. Mirror of Step 8d's dual-form.
  curr_hash=$( { shasum -a 256 "$origin" 2>/dev/null || sha256sum "$origin" 2>/dev/null; } | awk '{print $1}')
  [ -z "$curr_hash" ] && continue

  if [ "$curr_hash" = "$prev_hash" ]; then
    # IC1 review fix (v1.2.1+): bytes hash match ALONE is not sufficient to skip.
    # The wiki may be in a broken state from a prior partial-failure or external
    # edit (sync conflict, manual deletion). Verify wiki-side integrity before
    # declaring this source skippable. If ANY check fails, fall through to
    # normal ingest as a self-repair path (logged as `ingest-repair`, NOT
    # `ingest-skip`) — this lets the next ingest restore the wiki state for
    # this source even though its bytes have not changed.
    state_ok=true
    repair_reason=""

    # Check 1: every page this source has contributed to (pages_created ∪
    # pages_updated in the YAML) still exists in <wiki>/pages/.
    pages_in_yaml=$(awk '
      /^pages_created:[[:space:]]*$/ { in_list=1; next }
      /^pages_updated:[[:space:]]*$/ { in_list=1; next }
      /^[a-zA-Z]/ { in_list=0 }
      in_list && /^[[:space:]]+-[[:space:]]*/ {
        v=$0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); gsub(/["]/, "", v); print v
      }
    ' "$yaml" | sort -u)
    for page in $pages_in_yaml; do
      [ -z "$page" ] && continue
      if [ ! -f "$WIKI_ROOT/pages/$page" ]; then
        state_ok=false
        repair_reason="missing-page:$page"
        break
      fi
      # Check 2: each surviving page's frontmatter `sources:` still lists this slug.
      if ! awk -v slug="$slug" '
        BEGIN{found=0}
        /^---[[:space:]]*$/ { fm++; if(fm==2) exit }
        fm==1 && /^sources:[[:space:]]*$/ { in_src=1; next }
        fm==1 && in_src && /^[[:space:]]+-[[:space:]]*/ {
          v=$0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); gsub(/["]/, "", v)
          if (v == slug) found=1
        }
        fm==1 && in_src && !/^[[:space:]]+-/ { in_src=0 }
        END { exit (found ? 0 : 1) }
      ' "$WIKI_ROOT/pages/$page" 2>/dev/null; then
        state_ok=false
        repair_reason="page-missing-slug:$page"
        break
      fi
    done

    # Check 3: most recent log.jsonl entry for this slug must be a clean
    # terminal action (ingest, ingest-skip, ingest-repair). Anything else
    # (or absence) suggests a partial failure/interruption — re-ingest to
    # close the gap rather than skip.
    if $state_ok && [ -f "$WIKI_ROOT/log.jsonl" ]; then
      last_action=$(grep -F "\"source\":\"$slug\"" "$WIKI_ROOT/log.jsonl" 2>/dev/null \
        | tail -1 \
        | sed -E 's/.*"action":"([^"]+)".*/\1/')
      case "$last_action" in
        ingest|ingest-skip|ingest-repair) ;;        # clean terminal
        '') ;;                                      # no log entry (first ingest); allow skip
        *)
          state_ok=false
          repair_reason="last-action-not-terminal:$last_action"
          ;;
      esac
    fi

    if $state_ok; then
      # Skip safe — bytes unchanged AND wiki state intact.
      SKIPPED+=("$slug")
      # remove from $SOURCES — implementation-dependent on encoding
    else
      # Fall through to normal ingest as self-repair. Track the reason for
      # the `ingest-repair` log line emitted alongside the normal ingest.
      REPAIR+=("$slug:$repair_reason")
    fi
  fi
done
```

After filtering: if `SOURCES` is now empty (entirely skip-eligible — note: a `REPAIR` slug forces fall-through and means SOURCES is NOT empty), **briefly acquire the wiki lock (Step 3 protocol — `mkdir <wiki>/.wiki-meta/.wiki-lock` + trap)**, append **one `log.jsonl` line per skipped slug** using the canonical schema (NC2 review note — `wiki-lint` Step 1 reads `.ts` for "Last activity", Step 6 LOG-INVARIANT reads `.pages_created[]`; any new action MUST preserve `{ts, action, source, pages_created, pages_updated}` shape):

```jsonc
{"ts":"<iso>","action":"ingest-skip","source":"<slug>","pages_created":[],"pages_updated":[],"skip_reason":"content_hash unchanged"}
```

Use the same UTC ISO 8601 `Z` timestamp for every line in the batch (matches multi-source ingest emission rule from `commands/wiki-ingest.md` Step 10). Then run the v1.1.4 `.pending-scan → .last-scan` promotion block (same block that runs at the end of a normal ingest), release the lock, and report "All N sources skipped — bytes unchanged since last ingest". Content processing (Steps 2–13) is bypassed; only lock acquisition, skip-log append, and scan-window promotion are observed so:

- concurrent writers cannot race on `log.jsonl`,
- `.pending-scan` does not become permanently stale (which would cause the next hook to redetect the same N files and skip-log them again indefinitely),
- the auto-ingest contract "every detected window is either ingested or recorded as such" is preserved.

If at least one source remains, proceed to Step 2 with the reduced `SOURCES` list (skipped slugs in `SKIPPED`, repair slugs in `REPAIR`). At the end of Step 10 (Append to Log), **emit one extra log line per slug in `SKIPPED` and `REPAIR`** using the same `ts` as the rest of the batch (IW3 review fix — mixed-batch audit completeness):

```jsonc
{"ts":"<iso>","action":"ingest-skip","source":"<slug>","pages_created":[],"pages_updated":[],"skip_reason":"content_hash unchanged"}
{"ts":"<iso>","action":"ingest-repair","source":"<slug>","pages_created":[],"pages_updated":[<all pages this self-repair touched>],"repair_reason":"<from REPAIR array>"}
```

> **Critical (R3C1 review fix, v1.2.1+):** For slugs in `REPAIR`, the `ingest-repair` line **REPLACES** the normal Step 10 `ingest` line — do NOT emit both for the same slug, and do NOT classify any page as `pages_created` in the `ingest-repair` line (always `[]`). All pages this self-repair cycle touched go to `pages_updated` regardless of what `PRE_BATCH_PAGES` (Step 6) would otherwise classify. **Rationale:** a self-repair re-creates a page that historically already had its `pages_created` entry from the original `ingest`; emitting another `pages_created` would duplicate the filename across log history and trip `wiki-lint` Step 6 LOG-INVARIANT (which scans all entries with no action filter). The repair is a *restoration* of a page lifecycle, not a *new* creation.

The skipped slugs go into the final report (Step 14) as a separate "Unchanged (skipped)" section, and repaired slugs as "Repaired (state drift detected)".

> **Why URL/text types are exempt:** URL bytes can drift between the SessionStart fetch (none — main doesn't fetch in Step 1) and the agent's WebFetch, and pasted text is by definition new content. Only file/deep-work-report sources have stable byte semantics that justify the skip.

> **Why this is safe:** the agent has no observable side effect on the wiki when given an empty source list. Skipping a source is equivalent to never having included it. Per-source provenance for skipped slugs is already authoritative on disk.

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
- Deduplicate into a list of candidate descriptors `{file, title, tags, aliases}` (not just filenames). The agent uses these for Phase 1 skim without an extra Read of `index.json`.
- **Obsidian search enrichment (I4 review note):** when `OBS_LIVE=true` and `obsidian search:context` surfaces a candidate filename that is NOT present in the `index.json` title/alias/tag pre-filter, the caller MUST look up that filename in `index.json` and emit a `{file, title, tags, aliases}` descriptor for it. If the filename is also missing from `index.json` (rare wiki/Obsidian out-of-sync edge case), pass `{file, title: "", tags: [], aliases: []}` so the synthesizer at least sees the filename and can decide to deep-read.

Main MUST NOT read page bodies at this step — only metadata from `index.json` and the Obsidian index. Page bodies are for the agent.

### 5. Generate Source Slug

> **(v1.2.0+) This step is now a no-op for SOURCES already carrying a `slug` field** (slug derivation moved to end of Step 1 per IW4). Kept here for v1.1.x backward-readability. If for any reason `$SOURCES[i].slug` is missing at this point, derive it now using the algorithm below.

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
- `candidates` — descriptors from Step 4 `{file, title, tags, aliases}` (hint only; agent widens when needed per its Rule 5)

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

> **Classification rule (IW5 review fix, v1.2.0+):** A page filename belongs in `pages_created` ONLY if **(a)** the page did not exist in `pages/` at the start of this ingest, AND **(b)** it has not already been classified as `created` earlier in this same batch (intra-batch dedup — see Step 8c.1). If the page already existed (even if this is the first time *this source* contributed to it), or if a prior source in this same batch already produced it as `created`, classify under `pages_updated`. Rationale: `log.jsonl` is used to reconstruct per-page creation history; a page must have exactly one `pages_created` entry across the entire log AND within any single multi-source batch.

**c.1. Within-batch deduplication of `CREATED_ENTRIES` (v1.2.0+).**

If two or more entries in `CREATED_ENTRIES` share the same `file` value, this means two sources in this same batch each independently produced the same page name. The first sequential entry remains in `CREATED_ENTRIES` (as the originator); subsequent duplicates are moved to `UPDATED_ENTRIES`. This matches the `log.jsonl` invariant ("each page filename appears in `pages_created` at most once across the entire log") even within a multi-source batch where the agent's per-source attribution would otherwise emit it N times.

```bash
# Pseudo-logic — bash 3.2 호환 (macOS 기본 /bin/bash). 연관 배열(declare -A)은 bash 4+ 전용이며
# v1.1.4 D1 fix가 이미 같은 이유로 TSV 패턴을 도입했음 — 같은 원칙을 따른다.
SEEN_CREATED=""    # newline-delimited "이미 created로 분류된 파일명" 집합
NEW_CREATED=()
EXTRA_UPDATED=()
for entry in "${CREATED_ENTRIES[@]}"; do
  file="$(jq -r '.file' <<<"$entry")"
  if printf '%s\n' "$SEEN_CREATED" | grep -Fxq "$file"; then
    EXTRA_UPDATED+=("$entry")
  else
    SEEN_CREATED="$SEEN_CREATED"$'\n'"$file"
    NEW_CREATED+=("$entry")
  fi
done
CREATED_ENTRIES=("${NEW_CREATED[@]}")
UPDATED_ENTRIES+=("${EXTRA_UPDATED[@]}")
```

The classification change emits a one-line note in the Step 14 report ("N entries reclassified from created to updated due to same-batch dedup") so the user can spot legitimate "two sources created the same NEW page" cases that this guard masks. **Per-source provenance trade-off (W6):** the per-source `sources/<slug>.yaml` is generated from each entry's `sources` list (Step 8e) — `slug2`'s yaml will record `pages_updated:[X.md]` even though `slug2` co-created the page. Operators who care about co-creation attribution should keep `pages_created` in BOTH per-source yamls (drive dedup at log-emission time only). v1.2.0 takes the simpler path (dedup at classification) for log-invariant strictness; full per-source-preserving variant is tracked as a v1.3.0 candidate.

**d. Normalize `source_hashes`.** The agent returns `source_hashes` with one entry per source slug (the caller rejected the manifest in Step 7 / Error Handling if any passed-in slug was missing). The *values*, however, may not all be valid sha256 digests: the default `wiki-synthesizer` agent has no shell/hashing capability (its tool scope is `Read, Write, Glob, Grep, WebFetch`), so it returns a sentinel placeholder value for each slug. The caller is responsible for normalizing these to real digests before Step 8e.

For each slug, validate its value against `^[0-9a-f]{64}$` (case-insensitive — authoritative agent-computed digest). If it matches, use it verbatim as the `content_hash`. If it does NOT match (sentinel, empty, wrong length, non-hex chars, etc.), recompute from the source's `origin`:

- **`type: file` / `type: deep-work-report`** — hash the file bytes:
  ```bash
  shasum -a 256 "$origin" | awk '{print $1}'   # macOS / BSD
  sha256sum "$origin" | awk '{print $1}'       # Linux (use whichever is present)
  ```
- **`type: text`** — hash the inbox file at `<wiki_root>/.wiki-meta/.inbox/<slug>.txt`. This runs BEFORE Step 12's inbox cleanup so the file is still present.
- **`type: url`** — `curl -sSL "$origin" | shasum -a 256 | awk '{print $1}'`. URL content may drift between the agent's `WebFetch` and this recompute; this is best-effort for the agent-without-hashing case and is acceptable for static resources. Dynamic URLs are inherently unstable under any hashing strategy.

Replace the agent's `source_hashes` with this normalized map for the rest of the step. Log (at debug level, not in the final report) which slugs were recomputed, so future agents that *do* provide authoritative hashes can be detected by auditing logs.

This preserves v1.1.2's invariant that `content_hash` reflects bytes *that could be ingested*, even when the agent itself cannot hash. If a future agent runtime grants the agent a hashing capability (e.g. narrowly scoped Bash), its digests will pass the regex and flow through verbatim — backward compatible.

**e. Write per-source provenance.** For **each** source in the batch, create `<wiki_root>/.wiki-meta/sources/<slug>.yaml`:

```yaml
id: <slug>
title: "<source_title>"
ingested_at: "<iso_timestamp>"
type: <url|file|text|deep-work-report>
origin: "<url_or_path>"
content_hash: "sha256:<normalized_hashes[slug] from Step 8d>"
pages_created:
  - <files in CREATED_ENTRIES whose entry.sources contains this slug>
pages_updated:
  - <files in UPDATED_ENTRIES whose entry.sources contains this slug>
```

Per-slug `pages_created`/`pages_updated` filtering uses each entry's `sources` list — a page only lists a slug if that slug actually contributed to it. This preserves per-source provenance in multi-source batches (`wiki-lint`'s source-provenance invariant continues to hold: every page's frontmatter `sources:` slug has a matching `.wiki-meta/sources/<slug>.yaml` whose `pages_*` includes that page).

`content_hash` comes from the Step 8d normalized map. When the agent could compute its own sha256, this exactly matches the bytes it ingested. When the agent could not, main's post-hoc hash reflects the bytes *available on disk / at the URL* at reconciliation time — for `type: file` and `type: text` this is effectively identical (the file does not change between the agent's read and main's hash in a single ingest), and for `type: url` it is best-effort.

### 9. Update Index

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Read the current `.wiki-meta/index.json`. For each entry in `CREATED_ENTRIES` ∪ `UPDATED_ENTRIES`, use the entry's `{file, title, tags, aliases}` directly — do NOT re-read the page body. `CREATED_ENTRIES` produce new index entries; `UPDATED_ENTRIES` overwrite existing ones. Update `generated_at` to the current UTC timestamp, write back.

### 10. Append to Log

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Append one log line **per source in the batch**, using the per-slug filtered lists from Step 8e:

```json
{"ts":"<iso_timestamp>","action":"ingest","source":"<slug>","pages_created":[...filtered_for_slug],"pages_updated":[...filtered_for_slug]}
```

For a single-source ingest this is one line; for multi-source batch it is one line per source, identical `ts`. This matches the per-source yaml written in Step 8e — any page whose frontmatter `sources:` field lists a given slug MUST appear under that slug's log line (`pages_created` or `pages_updated`).

> **(v1.2.1+, R3C1 + IW3 review fixes) Slugs in `SKIPPED` and `REPAIR` from Step 1.5 emit different action types and bypass the normal `ingest` line:**
>
> - For each slug in `SKIPPED` (bytes unchanged AND wiki state intact): emit `{"ts":"<iso>","action":"ingest-skip","source":"<slug>","pages_created":[],"pages_updated":[],"skip_reason":"content_hash unchanged"}`. Same `ts` as the rest of the batch.
> - For each slug in `REPAIR` (bytes unchanged BUT wiki state drift forced fall-through): emit `{"ts":"<iso>","action":"ingest-repair","source":"<slug>","pages_created":[],"pages_updated":[<all touched pages for this slug>],"repair_reason":"<from REPAIR array>"}` **INSTEAD OF** the normal `ingest` line. `pages_created` MUST be `[]`; all touched pages go to `pages_updated`. This preserves wiki-lint Step 6 LOG-INVARIANT (each filename appears in `pages_created` exactly once across history; the historical `ingest` line is the canonical creation record, the `ingest-repair` line records the lifecycle restoration).
>
> The Step 8e per-source yaml is updated normally for both `SKIPPED` (no-op — yaml is already authoritative) and `REPAIR` slugs (yaml's `pages_created`/`pages_updated` reflect the current cycle's restoration; the `pages_created` field there does NOT need to match the log line's `pages_created:[]` — yaml is per-source historical record, log line is event record).

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
6. **After all files are processed successfully, and before the `rmdir` that releases the `.wiki-lock` directory** (i.e. between writing the last page/log entry and releasing the lock), promote `.pending-scan` → `.last-scan` with race, size, and regression guards:
   ```bash
   PENDING_FILE="<wiki_root>/.wiki-meta/.pending-scan"
   LAST_FILE="<wiki_root>/.wiki-meta/.last-scan"
   # TS_RE mirrors hooks/scripts/scan-vault-changes.sh — keep in sync.
   TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
   if [ -n "$BATCH_PENDING" ] && [ -s "$PENDING_FILE" ]; then
     CURRENT_PENDING=$(cat "$PENDING_FILE")
     CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
     # Validate inputs. If either fails the regex, bail without touching files.
     if [[ "$CURRENT_PENDING" =~ $TS_RE ]] && [[ "$BATCH_PENDING" =~ $TS_RE ]]; then
       # Step A — advance .last-scan to BATCH_PENDING, but NEVER regress it.
       # Cases this handles:
       #   (a) Normal — no concurrent hook: BATCH_PENDING == CURRENT_PENDING,
       #       CURRENT_LAST < BATCH_PENDING ⇒ advance LAST to BATCH_PENDING.
       #   (b) Concurrent hook wrote newer pending during this batch:
       #       CURRENT_PENDING > BATCH_PENDING > CURRENT_LAST ⇒ still advance
       #       LAST to BATCH_PENDING (the window we actually covered); leave
       #       the newer pending for the next session.
       #   (c) Stale pending left by a prior interrupted session:
       #       CURRENT_LAST > BATCH_PENDING ⇒ do NOT regress LAST. Skip the
       #       advance; Step B will drop the now-obsolete pending.
       if [[ -z "$CURRENT_LAST" ]] || ! [[ "$CURRENT_LAST" =~ $TS_RE ]] || ! [[ "$CURRENT_LAST" > "$BATCH_PENDING" ]]; then
         echo "$BATCH_PENDING" > "$LAST_FILE"
       fi
       # Step B — drop .pending-scan if its window is already covered by LAST.
       # Re-read LAST since Step A may have just advanced it.
       # Keep PENDING only when it is strictly newer than LAST (case (b) above —
       # the remainder window a concurrent hook detected that this batch did
       # not cover). In case (a) PENDING == LAST and is dropped; in case (c)
       # PENDING < LAST and is dropped.
       CURRENT_LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "")
       if [[ "$CURRENT_LAST" =~ $TS_RE ]] && ! [[ "$CURRENT_PENDING" > "$CURRENT_LAST" ]]; then
         rm -f "$PENDING_FILE"
       fi
     fi
   fi
   ```
   **Lexicographic comparison note**: `[[ "$A" > "$B" ]]` compares strings lexicographically in bash. Because the UTC ISO 8601 `Z`-suffix format is fixed-width and sortable as text, `[[ "2026-04-20T00:00:00Z" > "2026-04-17T06:57:34Z" ]]` evaluates as the numeric "newer than" comparison we want — this holds for every well-formed TS_RE value and is why the script does not parse timestamps numerically.

   **Regression guard rationale**: without this guard, a prior session that left a stale `.pending-scan` (older than the current `.last-scan`) would cause the next ingest to regress `.last-scan` — the next hook would then re-detect every file modified since the stale pending timestamp, producing duplicate `log.jsonl` entries and wasted wall-clock. The guard is strictly defensive; under normal hook/ingest interleaving (case (a) or (b) above) the behavior is unchanged from prior releases.

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
- If the `wiki-synthesizer` agent cannot be spawned or returns an unparseable response, release the lock and report the error. Do NOT promote `.pending-scan` — the next session will re-detect the window. "Unparseable" means one of: (a) not valid JSON, (b) missing any of `created`/`updated`/`versioned`/`source_hashes`/`failed` at the top level, (c) entries in `created`/`updated` missing required fields (`file`/`title`/`tags`/`aliases`/`sources`), (d) `source_hashes` missing a slug the caller passed in. Note that invalid-format `source_hashes` *values* (sentinels, empty strings, non-hex) are NOT fatal — Step 8d normalizes them via main-side recompute. Only a missing key for a slug the caller passed in is fatal.
- Always release the lock in case of errors (use trap in bash operations)
- **Inbox cleanup (type: text)**: The trap that releases the lock also deletes each file in `INBOX_FILES` (populated in Step 6.5). Never use `.inbox/*.txt` wildcards — stale inbox files from a prior crashed session belong to that session and may still be needed for recovery. This cleanup runs on success AND failure so pasted text never lingers on disk
- **Orphan versions**: If any `failed` entry carries an `orphan_version`, surface it in the Step 14 report so the user knows a backup exists for a page that did NOT get overwritten. Auto-lint's retention prune (Step 13) handles actual cleanup — no special action here
- If the agent returns `failed` entries (partial success): proceed with metadata updates for the succeeded pages and include the failures in the Step 14 report. **Do NOT promote `.pending-scan` on any partial or full failure** — the next session's hook will re-detect and re-process the window (no data loss). This matches the original "process all files successfully before promoting" semantics
