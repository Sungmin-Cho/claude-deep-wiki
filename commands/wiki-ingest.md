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

#### Optional A5 fanout config (v1.4.0+)

Optional file `<wiki>/.wiki-meta/.config.json` overrides A5 page-fanout
defaults. Schema:

```json
{
  "a5_fanout_threshold": 3,
  "a5_worker_timeout_sec": 90
}
```

- `a5_fanout_threshold` (default 3) — single-source page_plan size at
  which A5 fanout activates. `< threshold` uses Step 7.5.A inline_bodies
  sub-threshold path; `>= threshold` dispatches Step 7.6 parallel
  page-writers. Set to a very large number (e.g. 9999) to effectively
  disable A5 fanout (always sub-threshold path).
- `a5_worker_timeout_sec` (default 90) — aspirational per-worker timeout
  (see W9 disclaimer at Step 7.6.E).

Absence of `.config.json` means defaults — no migration needed.

```bash
# v1.4.0 — load optional .config.json
CONFIG="<wiki>/.wiki-meta/.config.json"
A5_FANOUT_THRESHOLD=3
A5_WORKER_TIMEOUT_SEC=90

if [ -f "$CONFIG" ]; then
  # Bash 3.2 portable JSON read — use python3 if available, else jq.
  if command -v python3 >/dev/null 2>&1; then
    val=$(python3 -c "import json,sys;d=json.load(open('$CONFIG'));print(d.get('a5_fanout_threshold',3))" 2>/dev/null)
    [ -n "$val" ] && A5_FANOUT_THRESHOLD="$val"
    val=$(python3 -c "import json,sys;d=json.load(open('$CONFIG'));print(d.get('a5_worker_timeout_sec',90))" 2>/dev/null)
    [ -n "$val" ] && A5_WORKER_TIMEOUT_SEC="$val"
  elif command -v jq >/dev/null 2>&1; then
    val=$(jq -r '.a5_fanout_threshold // 3' "$CONFIG" 2>/dev/null)
    [ -n "$val" ] && [ "$val" != "null" ] && A5_FANOUT_THRESHOLD="$val"
    val=$(jq -r '.a5_worker_timeout_sec // 90' "$CONFIG" 2>/dev/null)
    [ -n "$val" ] && [ "$val" != "null" ] && A5_WORKER_TIMEOUT_SEC="$val"
  else
    # W10 fix (round-1 review, Opus W10) — neither python3 nor jq found in PATH.
    # Bash 3.2 cannot portably parse JSON; emit stderr warning so the user knows
    # their .config.json overrides were silently ignored. Defaults still apply
    # (no fail-stop — A5 still runs with safe defaults).
    echo "WARNING: $CONFIG exists but no python3 or jq found in PATH;" >&2
    echo "         a5_fanout_threshold + a5_worker_timeout_sec overrides ignored." >&2
    echo "         Using defaults: threshold=$A5_FANOUT_THRESHOLD, timeout=${A5_WORKER_TIMEOUT_SEC}s." >&2
    echo "         Install jq (brew install jq / apt install jq) or ensure python3 is available to apply overrides." >&2
  fi
fi
```

> **W9 fix (round-1 review, Opus W9) — `a5_worker_timeout_sec` is aspirational:**
> The Claude Code Agent tool API does NOT expose a per-call timeout knob. The
> 90s value is a SOFT TARGET used for: (1) documentation of the worker design
> intent (Stage 1's `intent_summary` complexity budget — workers shouldn't need
> more than ~90s of LLM thinking for one page), (2) future-compat in case the
> runtime exposes timeouts later. The runtime's actual default (~5 minutes per
> Agent call) is the hard limit until the user kills the parent session.
> Implementer notes: do NOT write code that depends on 90s being enforced
> (e.g., do not `kill -SIGTERM` workers at 90s — there is no PID exposed). The
> "all workers fail" path (Step 7.7.B) covers runaway-worker scenarios after
> the runtime kills hung agents at its own ~5min limit. Spec §10.2 telemetry
> (deferred to v1.4.x) will record actual per-worker durations to inform
> whether to lobby for a runtime timeout knob.

## Steps

### 1. Identify Source Type

> **B3 v1.4.2 phase_timing_ms capture** — capture `INGEST_T0_MS=$(_ts_ms)` at the very entry of Step 1 (before source-type detection runs), so the `total` field of `phase_timing_ms` covers the entire `/wiki-ingest` wall-clock from argument parse to log emit. The `_ts_ms` helper is defined in "Step 7 — Shared utility: phase timing telemetry" below; spec ordering is not strict — implementer may inline `_ts_ms` definition before Step 1 or treat it as a forward declaration.

Determine the source type from the argument **without reading file bodies or fetching URLs** — the agent is responsible for source I/O and hashing:

- **URL**: Starts with `http://` or `https://` → type `url`, origin = the URL.
- **Deep-work report**: Path resolves to a `report.md` inside a deep-work session folder (contains `.claude/deep-work/sessions/` or similar) → type `deep-work-report`, origin = resolved `report.md` path.
- **File path**: Exists on filesystem and is not a deep-work report → type `file`, origin = absolute path.
- **No argument (pasted text)**: Ask the user to paste text, generate a slug (from the first non-empty line or a timestamp), and record `{slug, pending_text, type: "text"}` — but do NOT write the inbox file yet. The inbox write happens in Step 6.5 after lock acquisition so concurrent sessions can't race on the same `.inbox/<slug>.txt` path.

**(v1.2.0+) Derive `slug` for every source at end of Step 1** (IW4 review fix — formerly Step 5's responsibility, moved here so Step 1.5's hash-skip can locate `<wiki>/.wiki-meta/sources/<slug>.yaml`). Apply Step 5's algorithm now: URL → `karpathy-llm-wiki-gist`-style kebab from the URL slug; file path → kebab from `basename` minus `.md`; deep-work session → `deep-work-session-<YYYY-MM-DD>`. Each tuple in `$SOURCES` MUST carry `{slug, origin, type}` (or your equivalent encoding) by the time Step 1.5 runs. Step 5 is now a no-op for sources already carrying a `slug` (kept in the spec only for backward-readability with v1.1.x docs).

> **Slug collision (R3W1 review fix, v1.2.1+):** the kebab algorithm above derives the slug from `basename` for files. Two distinct sources whose paths share a basename (`/A/foo.md` and `/B/foo.md`) produce the same slug. Without disambiguation, Step 1.5's hash-skip lookup would consult the **other** source's yaml (a coincidental bytes-hash match would silently cross-attribute provenance), AND — critically — a fresh batch where neither source has been ingested before would write the same `sources/<slug>.yaml` twice and emit collapsed log lines. Resolve at slug-derivation time with an allocator that tracks BOTH the in-batch claim ledger AND the on-disk yamls.

```bash
# Slug allocator (CR-A v1.2.1+ — closes the same-batch fresh-collision gap that
# the on-disk-only check missed). For each source:
#   1. If another in-batch source already claimed this exact (slug, origin) pair,
#      re-use it (same source appearing twice in one batch — degenerate, no-op).
#   2. If another in-batch source already claimed this slug for a DIFFERENT origin,
#      bump to <slug>-2, <slug>-3, ... until both the in-batch claim ledger AND
#      the on-disk yaml (if any) are clear or origin-match.
#   3. If on-disk yaml exists for the candidate slug with a different origin
#      (rotation across sessions), bump similarly.
#   4. Record the final (slug, origin) in CLAIMED_SLUGS so subsequent sources
#      in this batch see the claim.
# Bash 3.2-safe: newline-delimited string ledger (no associative arrays).
CLAIMED_SLUGS=""        # newline-delimited "slug|origin" entries claimed in this batch
NEW_SOURCES=()
for src in "${SOURCES[@]}"; do
  slug="${src%%|*}"; origin_and_rest="${src#*|}"
  origin="${origin_and_rest%|*}"; type="${origin_and_rest##*|}"

  while true; do
    # 1. In-batch ledger check
    in_batch_match=false
    in_batch_collision=false
    if [ -n "$CLAIMED_SLUGS" ]; then
      while IFS='|' read -r claimed_slug claimed_origin; do
        [ -z "$claimed_slug" ] && continue
        if [ "$claimed_slug" = "$slug" ]; then
          if [ "$claimed_origin" = "$origin" ]; then
            in_batch_match=true       # same source repeated — keep slug
          else
            in_batch_collision=true   # different origin claimed it — bump
          fi
          break
        fi
      done <<EOF_LEDGER
$CLAIMED_SLUGS
EOF_LEDGER
    fi
    $in_batch_match && break  # done — same source already claimed

    # 2. On-disk yaml check (single-quote-aware strip mirrors RW4 below)
    on_disk_collision=false
    yaml="$WIKI_ROOT/.wiki-meta/sources/${slug}.yaml"
    if [ -f "$yaml" ]; then
      # v1.3.0 (1.1, Cycle-1 CV-3 + Cycle-2 C2V-2): three-form delimiter-aware
      # awk parser. Each form anchored independently; first match wins.
      # Embedded opposite-kind quotes preserved (e.g., "/path/with'quote.md" →
      # /path/with'quote.md). Embedded SAME-kind quotes still truncate at the
      # inner quote — this is a YAML limitation, not a parser bug. The YAML spec
      # requires escaping same-kind embedded quotes via the alternate quote form.
      # v1.3.0 closes only the embedded-opposite-kind case (the common one).
      # `\47` is literal single-quote in awk (portable across POSIX awks).
      prev_origin=$(grep '^origin:' "$yaml" | awk '
        # Form 1: double-quoted — capture between first " and LAST "
        /^origin:[[:space:]]*"/ {
          sub(/^origin:[[:space:]]*"/, "")
          sub(/"[[:space:]]*$/, "")
          print; exit
        }
        # Form 2: single-quoted — capture between first \47 and LAST \47
        /^origin:[[:space:]]*\47/ {
          sub(/^origin:[[:space:]]*\47/, "")
          sub(/\47[[:space:]]*$/, "")
          print; exit
        }
        # Form 3: unquoted — capture remainder, trim whitespace
        /^origin:[[:space:]]*/ {
          sub(/^origin:[[:space:]]*/, "")
          sub(/[[:space:]]*$/, "")
          print; exit
        }
      ')
      if [ -n "$prev_origin" ] && [ "$prev_origin" != "$origin" ]; then
        on_disk_collision=true
      fi
    fi

    if ! $in_batch_collision && ! $on_disk_collision; then
      break  # slug is clear (no claim conflict, no yaml conflict)
    fi

    # 3. Bump: increment trailing -N suffix or append -2.
    if [[ "$slug" =~ ^(.+)-([0-9]+)$ ]]; then
      base="${BASH_REMATCH[1]}"; n="${BASH_REMATCH[2]}"
      slug="${base}-$((n + 1))"
    else
      slug="${slug}-2"
    fi
    [ ${#slug} -gt 200 ] && {
      echo "ERROR: slug allocator exceeded 200 chars (pathological collision); aborting." >&2
      exit 1
    }
  done

  CLAIMED_SLUGS="$CLAIMED_SLUGS"$'\n'"${slug}|${origin}"
  # W2-δ v1.2.1+: skip NEW_SOURCES append when the same (slug, origin) pair
  # was already claimed in this batch (degenerate same-source-twice case —
  # e.g., `/wiki-ingest fileA.md fileA.md`). Without this skip, Step 1.5 would
  # process the same source twice, producing one `ingest` and one `ingest-skip`
  # log line for the same (slug, ts) — operational noise. The `$in_batch_match`
  # flag is true only when the ledger had a pre-existing entry with matching
  # origin; the non-matching-origin case (true collision) sets `in_batch_collision`
  # and bumps the slug, so this `continue` does not affect that path.
  $in_batch_match && continue
  NEW_SOURCES+=("${slug}|${origin}|${type}")
done
SOURCES=("${NEW_SOURCES[@]}")
```

Once the allocator runs, every source descriptor's `slug` is unique against (a) every other source claimed earlier in this same batch with a different origin, and (b) every existing on-disk per-source yaml whose origin differs. Step 1.5 then reads the correct yaml (or no yaml, if the disambiguator-slot is fresh) and performs hash-skip without cross-attribution risk. Re-ingest of a previously-disambiguated source (same origin → same yaml on disk) returns the same slug — idempotent.

> **Allocator semantics notes (W2-γ + I1 v1.2.1+):**
>
> - **`exit 1` on 200-char overflow:** the safety cap aborts the entire `/wiki-ingest` invocation (bash `exit 1` from a sub-loop propagates to the calling spec context). The 200-char threshold is well above any realistic basename length; exceeding it implies adversarial input or a corrupt `.wiki-meta/sources/` directory. The user-facing error message is intentionally terse — `inspect <wiki>/.wiki-meta/sources/ for corruption and re-run` is the expected next step. If the spec ever needs softer fallback (e.g., truncate to `<base>-overflow`), revisit at v1.3.0+.
> - **Order-dependence within first batch:** when two sources have natural slug-N collision (e.g., `/A/chapter-1.md` + `/B/chapter-1.md` both → `chapter-1`), the final slug assignment depends on iteration order — the second source bumps to `chapter-2`. Subsequent re-ingests in any order produce the same yaml layout because the on-disk yamls anchor each origin to its assigned slug. Idempotence is *across sessions*, not *across in-batch ordering*. Same trade-off as v1.1.x. No action required.

Main does NOT fetch URL bodies or read source file contents at this step. It only classifies sources, derives slugs, and defers pasted-text materialization until after the lock is held.

### 1.5. Re-Ingest Hash Skip (v1.2.0+)

For each source identified in Step 1 with `type ∈ {file, deep-work-report}`, check whether its current bytes' sha256 matches `<wiki_root>/.wiki-meta/sources/<slug>.yaml:content_hash`. If a match is found, **drop the source from the batch** and append one log entry recording the skip.

> **Slug derivation prerequisite (NC1 review note):** the pre-v1.2.0 `/wiki-ingest` generated slugs only in Step 5 (after this Step 1.5). The hash-skip lookup needs a slug to find the existing yaml — therefore **move slug generation to the END of Step 1** (apply the same kebab-case algorithm Step 5 uses: URL → `karpathy-llm-wiki-gist`, file path → `architecture-doc-2026`, deep-work session → `deep-work-session-2026-04-06`). Each source descriptor in `$SOURCES` MUST carry a `slug` field by the time this Step 1.5 runs. Step 5 then becomes a no-op (or emits the same pre-computed slugs to a downstream variable). Slug derivation is deterministic on `origin`, so this re-ordering does not change provenance semantics.

```bash
# Pre-condition: each source descriptor already has a slug, computed at end of
# Step 1 using Step 5's algorithm (NC1 fix). The encoding shown below is one
# possible tuple serialization — adjust to your /wiki-ingest implementation.
SKIPPED=()
REPAIR=()
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

  # v1.4.0 A1 — partial_fail sentinel takes precedence over bytes-hash.
  # If a prior ingest left a partial_fail block (Stage 2 worker fail, Stage 3
  # write fail, or C3 concurrency abort), force REPAIR with the
  # `partial-fail-recovery` reason regardless of bytes match. The bytes-hash
  # check below would falsely emit `ingest-skip` and the failed pages would
  # never be retried. The state-machine awk in Step 7.6.F (Case ii) is what
  # removes this sentinel on the first fully-successful retry.
  if grep -q '^partial_fail:' "$yaml"; then
    REPAIR+=("$slug:partial-fail-recovery")
    continue
  fi

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
      /^pages_created:[[:space:]]*\[/ {
        body=$0; sub(/^pages_created:[[:space:]]*\[/, "", body); sub(/\][[:space:]]*$/, "", body)
        n = split(body, arr, ",")
        for (i = 1; i <= n; i++) {
          gsub(/^[[:space:]"\x27]+|[[:space:]"\x27]+$/, "", arr[i])
          if (arr[i] != "") print arr[i]
        }
        next
      }
      /^pages_updated:[[:space:]]*\[/ {
        body=$0; sub(/^pages_updated:[[:space:]]*\[/, "", body); sub(/\][[:space:]]*$/, "", body)
        n = split(body, arr, ",")
        for (i = 1; i <= n; i++) {
          gsub(/^[[:space:]"\x27]+|[[:space:]"\x27]+$/, "", arr[i])
          if (arr[i] != "") print arr[i]
        }
        next
      }
      /^pages_created:[[:space:]]*$/ { in_list=1; next }
      /^pages_updated:[[:space:]]*$/ { in_list=1; next }
      /^[a-zA-Z]/ { in_list=0 }
      in_list && /^[[:space:]]+-[[:space:]]*/ {
        v=$0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); gsub(/^["\x27]+|["\x27]+$/, "", v); print v
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
          v=$0; sub(/^[[:space:]]+-[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); gsub(/^["\x27]+|["\x27]+$/, "", v)
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

    # Check 3: log.jsonl must exist AND most recent entry for this slug must be
    # a clean terminal action (ingest, ingest-skip, ingest-repair). Anything else,
    # absence of log entry, or absence of log.jsonl entirely all indicate that the
    # wiki state has drifted from what the per-source yaml claims — re-ingest as
    # self-repair rather than skip. (R3W2 review fix, v1.2.1+)
    if $state_ok; then
      if [ ! -f "$WIKI_ROOT/log.jsonl" ]; then
        state_ok=false
        repair_reason="log-jsonl-missing"
      else
        last_action=$(grep -F "\"source\":\"$slug\"" "$WIKI_ROOT/log.jsonl" 2>/dev/null \
          | tail -1 \
          | sed -E 's/.*"action":"([^"]+)".*/\1/')
        case "$last_action" in
          ingest|ingest-skip|ingest-repair) ;;        # clean terminal — skip is safe
          '')
            state_ok=false
            repair_reason="no-prior-terminal-log"
            ;;
          *)
            state_ok=false
            repair_reason="last-action-not-terminal:$last_action"
            ;;
        esac
      fi
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

> **Note (W-α v1.2.1+, no-creation-traceability after R3W2 self-repair):** when R3W2 fires due to `log-jsonl-missing` or `no-prior-terminal-log`, the resulting `ingest-repair` line emits `pages_created:[]` per Step 10 R3C1 spec — the historical `ingest` line that originally classified those pages as `pages_created` is gone (log was truncated/lost), and the repair cycle does NOT synthesize a replacement. Going forward, those page filenames will not appear under any log line's `pages_created`. **This is acceptable** because (a) wiki-lint Step 6 LOG-INVARIANT only flags duplicates, not absences — the wiki stays clean; (b) per-source yaml is the authoritative provenance record, not the log — and yaml is verified intact by Checks 1+2 before reaching here; (c) the alternative (synthesize a new `ingest` line for vanished history) would lie about timing and is out of patch scope. If creation-traceability through the log matters for your workflow, restore log.jsonl from a backup before re-ingesting affected sources, or accept the gap.

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

**v1.5.0+ envelope-aware read:** `index.json` is M3 envelope-wrapped (cf.
claude-deep-suite/docs/envelope-migration.md §1). Use `read-index-envelope.js`
to get the legacy `{pages, generated_at}` shape regardless of whether the
file is envelope-wrapped (v1.5.0+) or legacy (pre-1.5.0). The reader enforces
an identity guard (producer=deep-wiki, artifact_kind=index, schema.name=index)
and rejects foreign envelopes or corrupt payloads (exit 1 with stderr reason)
— Step 2 should propagate that failure.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
INDEX_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
              "${WIKI_ROOT}/.wiki-meta/index.json")
# INDEX_JSON now contains { "pages": [...], "generated_at": "..." } regardless
# of v1.5.0 envelope wrap. Existing jq pipelines (.pages[].file etc.) work
# unchanged on $INDEX_JSON.
```

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

### 7. Dispatch to wiki-synthesizer-{analysis|worker} (split agents, v1.4.1+)

> **v1.4.0+ change:** synthesizer invocation branches on source count AND
> on `len(page_plan)` for single-source. See "Step 7.5 — Synthesizer
> dispatch (v1.4.0+: single-source A5 / multi-source A4)" below for the
> full flow. The text below remains valid as a high-level summary; the
> single-source path now invokes the synthesizer in `mode: "analysis"`
> (page_plan emit) rather than `mode: "inline"` (v1.3.0 single-source).
> Multi-source path is unchanged from v1.3.0 (A4 fanout, Approach B).

Spawn the appropriate split agent via the Agent tool: `deep-wiki:wiki-synthesizer-analysis` for single-source ingests (v1.4.0+ A5 page-fanout) OR `deep-wiki:wiki-synthesizer-worker` for multi-source ingests (v1.3.0+ A4 fanout). This happens for **every** ingest — single-source, multi-source, URL, file, pasted text, or deep-work report alike. The main session does not read source content or page bodies; it only passes paths and the candidate list.

**Input and output contracts are defined in `agents/wiki-synthesizer-analysis.md` (Input contract / Analysis output contract sections — single-source path) and `agents/wiki-synthesizer-worker.md` (Input contract / Worker output contract sections — multi-source path). Those files are the single source of truth. This step summarizes what the caller does with the returned manifest; for field semantics, see the agent files.**

Input (summary):
- `wiki_root`
- `sources` — list of `{slug, origin, type}`
- `candidates` — descriptors from Step 4 `{file, title, tags, aliases}` (hint only; agent widens when needed per its Rule 5)

Output (summary): structured entries for `created` / `updated` carrying `{file, title, tags, aliases, sources}`, plus `versioned`, `source_hashes` (per-slug sha256), and `failed` (may include `orphan_version`).

If `failed` is non-empty, continue with metadata updates for whatever succeeded and include the failures in the final report (Step 14). Always release the lock. **In auto-ingest mode, do NOT promote `.pending-scan → .last-scan` on any partial or full failure** — the next session's hook will re-detect the window. See Error Handling below.

### Step 7 — Shared utility: §3.9 worker mutation detection (`WIKI_TEST_MODE=1` gated)

The following 3 shell functions implement the §3.9 post-dispatch dirty-file scan (per plan §3.9, cycle-3 N1.1/N1.2/N1.3 fixes; v1.4.2 added Stage 1 single-source bracketing per F2 handoff fix). They are invoked at **4 dispatch sites** (Step 7.5 single-source Stage 1 analysis / Step 7.5.M-A multi-source A4 / Step 7.5.M-B Case B2 collision second-pass / Step 7.6.B-post A5 fanout) to detect worker / synthesizer LLM mutations of `<wiki_root>/` files outside the lock-protected atomic-write windows. Production runs skip (zero cost); re-dogfood + sandbox tests opt in via `WIKI_TEST_MODE=1`.

```bash
# _post_dispatch_dirty_scan — invoked at 4 sites (Step 7.5 Stage 1 single-source analysis [v1.4.2 F2] / Step 7.5.M-A / 7.5.M-B / 7.6.B-post)
# Args: $1 = phase label ("A5-analysis" | "A4-fanout" | "A4-second-pass" | "A5-fanout")
# Reads/sets globals: PRE_DISPATCH_HASH (pre-snapshot), PARTIAL_FAIL, FAILED_REASON
# Side effect: if mismatch, sets PARTIAL_FAIL=true and triggers abort

_compute_wiki_hash() {
  # Single-line digest of <WIKI_ROOT>/pages + <WIKI_ROOT>/.wiki-meta tree.
  # Bash 3.2 portable: no mapfile, no declare -A, no &>/dev/null.
  # Pre-hash stored in shell variable, NOT in scanned tree (cycle-3 N1.1 fix).
  if [ -d "$WIKI_ROOT/pages" ] || [ -d "$WIKI_ROOT/.wiki-meta" ]; then
    find "$WIKI_ROOT/pages" "$WIKI_ROOT/.wiki-meta" -type f 2>/dev/null \
      | sort \
      | { while IFS= read -r f; do
            { shasum -a 256 -- "$f" 2>/dev/null \
              || sha256sum -- "$f" 2>/dev/null; } \
            | awk '{print $1, $2}'
          done; } \
      | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } \
      | awk '{print $1}'
  else
    # First-ingest case: empty/non-existent paths produce a deterministic empty digest.
    printf '' | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | awk '{print $1}'
  fi
}

_post_dispatch_pre_snapshot() {
  if [ "${WIKI_TEST_MODE:-0}" = "1" ]; then
    PRE_DISPATCH_HASH=$(_compute_wiki_hash)
  fi
}

_post_dispatch_dirty_scan() {
  # $1 = phase label
  local phase="${1:-unknown}"
  if [ "${WIKI_TEST_MODE:-0}" != "1" ]; then return 0; fi
  local post_hash
  post_hash=$(_compute_wiki_hash)
  if [ -n "${PRE_DISPATCH_HASH:-}" ] && [ "$PRE_DISPATCH_HASH" != "$post_hash" ]; then
    echo "FATAL: $phase worker mutated wiki_root (pre=$PRE_DISPATCH_HASH, post=$post_hash)" >&2
    PARTIAL_FAIL=true
    FAILED_REASON="worker_mutation_detected ($phase)"
    # Trigger Step 7.7.A worker-mutation failure handling here:
    # - Emit partial_fail sentinel for all source slugs in the batch
    # - Log worker_mutation_detected event with phase label
    # - Abort the ingest (do NOT promote .pending-scan)
    return 1
  fi
  return 0
}
```

**Acceptance gate (cycle-3 N1.1 clean no-op):** `_post_dispatch_pre_snapshot` + `_post_dispatch_dirty_scan` MUST pass when no worker mutation occurs between them — pre-hash and post-hash equal, function returns 0. Any non-clean baseline indicates §3.9 is broken (e.g., scan walking files modified by main's bookkeeping during the window) and MUST not ship.

### Step 7 — Shared utility: phase timing telemetry (`phase_timing_ms` capture, v1.4.2 B3)

`/wiki-ingest` runs in three macro-phases (Stage 1 analysis / Stage 2 fanout / Stage 3 atomic write). v1.4.0 dogfood (14-page plan, 295-page wiki) measured ~17 minutes wall-clock with anecdotal Stage 1 ~7 min + Stage 2 ~10 min splits — but no per-phase timing was recorded in `log.jsonl`, so the breakdown was unverifiable post-hoc. v1.4.2 closes this gap with a `phase_timing_ms` field in the `ingest` log line (Step 10), schema-additive.

**Helper function** (defined alongside §3.9 utilities; Bash 3.2 portable; ms precision via Python with second-precision fallback):

```bash
# _ts_ms — emit current epoch milliseconds.
# python3 is preferred (sub-second precision; available on macOS + Linux).
# date +%s000 fallback yields second precision (Bash 3.2 + BSD date safe).
_ts_ms() {
  python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null \
    || printf '%s000' "$(date +%s)"
}
```

**Capture points** (timestamps stored in shell variables; phase-end triggers a delta against phase-start):

| Variable | Capture point |
|---|---|
| `INGEST_T0_MS` | Step 1 entry (immediately after `/wiki-ingest` parses arguments) |
| `STAGE_1_START_MS` | Single-source: before `_post_dispatch_pre_snapshot` at Step 7.5 (F2 site). Multi-source: before `_post_dispatch_pre_snapshot` at Step 7.5.M-A. |
| `STAGE_1_END_MS` | Single-source: after `_post_dispatch_dirty_scan "A5-analysis"` at Step 7.5. Multi-source: after `_post_dispatch_dirty_scan "A4-fanout"` at Step 7.5.M-B (which delimits worker fanout's analysis return). |
| `STAGE_2_START_MS` | A5 fanout single-source ONLY: before `_post_dispatch_pre_snapshot` at Step 7.6.A page-writer dispatch. Multi-source: re-uses `STAGE_1_END_MS` (workers are Stage 1 in A4 path; no separate Stage 2 fanout). Sub-threshold inline + empty-plan: 0 (no Stage 2). |
| `STAGE_2_END_MS` | A5 fanout single-source: after worker output validation at Step 7.6.B end. Multi-source: not separately captured (re-uses STAGE_1_END for A4-collision-merge end too — implementer may extend with `STAGE_2_END_MS` for second-pass collision resolution). |
| `STAGE_3_START_MS` | At `mkdir <wiki>/.wiki-meta/.wiki-lock` line (Step 7.6.C single-source / Step 7.5.M-C multi-source). |
| `LOG_EMIT_MS` | Inside Step 10 immediately before the log.jsonl line is appended (becomes Stage 3 end-of-write watermark; auto-lint + lock release after Step 10 are excluded from `stage_3_write` since they're idempotent post-write maintenance). |

**Field schema** (added to log.jsonl `ingest` line — schema-additive; the `wiki-lint` Step 6 LOG-INVARIANT scan ignores unknown top-level fields):

```jsonc
{
  "ts": "...",
  "action": "ingest",
  "source": "...",
  "pages_created": [],
  "pages_updated": [...],
  "phase_timing_ms": {
    "stage_1_analysis": 420000,    // STAGE_1_END_MS - STAGE_1_START_MS
    "stage_2_fanout": 600000,      // STAGE_2_END_MS - STAGE_2_START_MS (or 0 when sub-threshold/empty/multi-source)
    "stage_3_write": 2000,         // LOG_EMIT_MS - STAGE_3_START_MS
    "total": 1022000               // LOG_EMIT_MS - INGEST_T0_MS
  }
}
```

**Path coverage:**

> **B3.1 fix (v1.4.2 post-impl review):** Step 10 (Append to Log) emits `phase_timing_ms` ONLY on `ingest` lifecycle action lines. The skip / repair / fail paths emit DIFFERENT actions (`ingest-skip` / `ingest-repair` / `ingest-fail`) via their own log-emit sites that bypass Step 10's compute block. The matrix below distinguishes "phase timing emitted" from "path that bypasses Step 10". Implementer MUST NOT extend Step 1.5 / Step 7.8 / Step 7.5.M-D log-emit sites with phase_timing_ms — the field is intentionally limited to terminal-success `ingest` lines.
>
> - **`total` is wall-clock superset, not the sum of stages.** The gap (`total - stage_1 - stage_2 - stage_3`) covers Step 1 setup, F1 disk-read loop, branch decisions, and pre-lock prep — typically <1% of total wall-clock for non-trivial ingests. Listed for telemetry consumers per I1 finding.

| Path | Action emitted | phase_timing_ms emitted? | stage_1 | stage_2 | stage_3 |
|---|---|---|---|---|---|
| Single-source A5 fanout | `ingest` | ✅ yes | LLM dispatch + dirty-scan brackets | parallel `wiki-page-writer` workers | lock + atomic write loop + Step 8-10 |
| Single-source sub-threshold inline (no F1 drift) | `ingest` | ✅ yes | LLM dispatch + dirty-scan brackets | 0 (inline_bodies, no Stage 2) | lock + atomic write + Step 8-10 |
| Single-source sub-threshold drift (F1.1 force-fanout) | `ingest` | ✅ yes | as Stage 1 | as Stage 2 (forced fanout) | as Stage 3 |
| **Single-source F1 all-dropped (Step 7.5.B `do_all_failed_under_lock`, count<3)** | **`ingest`** | **✅ yes (R3.W-1 fix)** | **LLM dispatch + dirty-scan brackets** | **0 (no Stage 2 — F1 dropped before fanout)** | **lock + yaml baseline+sentinel + log emit (no atomic write loop). STAGE_3_START_MS_FAIL captured by caller; PT_STAGE_3_MS scopes to lock+yaml+log only.** |
| Multi-source A4 fanout | `ingest` (one line per source, identical timing) | ✅ yes | worker-fanout analysis | 0 for clean first-pass; non-zero on Step 7.5.M-B Case B2 second-pass | Step 7.5.M-C atomic write |
| Single-source empty page_plan terminal-skip (Step 7.8) | `ingest-skip` | ❌ omitted (different log path; Step 7.8 emits its own line) | n/a | n/a | n/a |
| Re-ingest hash-skip (Step 1.5) | `ingest-skip` | ❌ omitted (Step 1.5 emits its own line) | n/a | n/a | n/a |
| Ingest-repair self-healing | `ingest-repair` | ❌ omitted (per Step 10 omission rule) | n/a | n/a | n/a |
| Ingest-fail 3-strike abort (Step 7.5.M-D OR Step 7.5.B count≥3) | `ingest-fail` | ❌ omitted on Step 7.5.M-D's own emit; ✅ emitted on Step 7.5.B's R3.P2.2 escape (since the emit goes through `emit_log_line` at Step 7.5.B itself, with full PHASE_TIMING_JSON computed). | partial (Stage 1 ran) | 0 | lock+yaml+log emit only |

**Bash 3.2 portability**: `_ts_ms` python3 fallback chain works on macOS BSD + Linux (no `date +%s.%N` non-portability). Numeric arithmetic uses POSIX `$((LOG_EMIT_MS - STAGE_3_START_MS))` (works in Bash 3.2). The phase_timing_ms JSON object can be assembled with simple `printf` interpolation; no `jq` dependency added.

**Production cost:** ~6 `_ts_ms` calls per ingest (≤ 12 ms total on macOS — Python startup is the dominant cost; on warm cache ~2ms each). Negligible compared to LLM phases (minutes). Skip option not provided — telemetry is always-on (cf. v1.4.0 lesson where dogfood wall-clock was anecdotal).

**Production cost trade-off:** zero by default (env-gated). Sandbox/dogfood adds one filesystem walk per dispatch site per ingest (~300 stat calls + sha256 hashes; sub-second on local SSD). Production trusts V-0/V-1/V-2/V-3 chain alone (per cycle-3 N3.4 reframing).

**Limitations** (refined cycle-3 N1.5 — honest framing): catches Stage-2-direct mutation; does NOT cover post-Stage-3-close race, atomic-rename via /tmp/, or symbolic links. See plan §3.9 limitations subsection for v1.4.1.x follow-up candidates.

**Bash 3.2 portability** (per CLAUDE.md): no `declare -A`, no `mapfile`, no `${var,,}`. The `local` keyword IS Bash 3.2-compatible (built-in to functions). `shasum -a 256 || sha256sum` dual fallback (R-P1 fix per plan).

### 7.5. Synthesizer dispatch (v1.4.0+: single-source A5 / multi-source A4)

**Lock scope (v1.3.0+, fixes Cycle-1 SS-1 + Plan #2.1 Cycle-2 C2-W2 —
branch-scoped):** the existing global lock
(`mkdir <wiki>/.wiki-meta/.wiki-lock`) acquisition timing now depends
on the branch:

- **Multi-source path (≥2 sources):** lock acquired **BEFORE worker
  dispatch** (Phase 0/Step 7.5.M-A entry) and held through Phase 3 (atomic
  writes). Approach B's correctness depends on workers seeing a stable
  wiki state snapshot during their analysis. Lock held for the full LLM
  analysis duration (~minutes), blocking concurrent `/wiki-ingest`
  sessions. Rare in practice (single-user vault).
- **Single-source path (1 source):** lock acquired in Phase 3 only —
  exactly as v1.2.1. Preserves byte-identical single-source behavior
  (no extra blocking, no contention drift, no timing change). The
  single-source fast path does not have the cross-worker-snapshot
  consistency need.
- **0-source path:** no lock at all (immediate exit).

The Cycle-2 review (C2-W2) flagged that an unconditional Phase-0 lock
contradicted the "byte-identical to v1.2.1 single-source" claim.
Branch-scoping resolves the contradiction: single-source remains
byte-identical (lock timing AND state); multi-source gets the new lock
scope it needs for B5 invariant on fanout. See spec §2.5 for full
trade-offs.

After Step 1.5 (re-ingest hash skip) finalizes the source set, the agent
decides between empty-batch exit, single-source A5 path (with sub-branches
for empty page_plan / sub-threshold inline / fanout), and multi-worker A4
fanout based on source count.

**Four-branch decision (v1.4.0+ — extends v1.3.0 three-branch with
single-source A5 sub-branches):**

> **W11 fix (round-1 review, Opus W11) — pseudocode style:**
> The block below uses Python-style `if/elif/else` and `for entry in ...`
> syntax for readability. The LLM interpreter maps these to bash 3.2
> equivalents during `/wiki-ingest` execution — e.g.,
> `if sources_count == 0:` becomes `if [ "$sources_count" -eq 0 ]; then`,
> `for entry in page_plan:` becomes
> `for i in "${!page_plan[@]}"; do entry="${page_plan[$i]}"; ... done`
> (with the usual JSON parsing per the Step 7.6 P3 disclaimer).
> Implementer must respect CLAUDE.md "Bash 3.2 portability" rules
> (no `declare -A`, no `mapfile`, etc.). Dotted field access
> (`entry.action`, `entry.existing_body_hash`, `entry.existing_page_body`)
> follows the same convention as Step 7.6.

```
sources_count = len(SOURCES)

if sources_count == 0:
    exit "No sources to ingest." [v1.3.0 unchanged — no lock]

if sources_count == 1:
    # R3.C-3 fix (v1.4.2 3rd-round /deep-review) — explicit init of
    # FAILED_PAGES + FAILED_PAGE_FILES before F1 gate runs. F1 was the
    # first append site for these arrays at top-level (outside any
    # function scope). Without explicit init, set -u would abort on
    # `${FAILED_PAGE_FILES[@]}` expansion in `do_all_failed_under_lock`,
    # and set +u would yield `pages_failed: [""]` (the W1 round-2 bug
    # shape). Initialize empty here. Same convention applied to
    # FAILED_WORKERS (Step 7.6.B's gate population — already initialized
    # in its own block, line 1383).
    FAILED_PAGES=()
    FAILED_PAGE_FILES=()
    FAILED_PAGE_REASONS=()
    F1_DRIFT_DETECTED=false   # F1.1 fix moved here for early visibility.

    # v1.4.0 single-source A5 path: always invoke analysis mode first.
    # Post-review fix — fixes round-4 missed: W1 — pass A5_FANOUT_THRESHOLD
    # so the synthesizer's analysis mode knows which page_plan size triggers
    # inline_bodies emit. Without this, the synthesizer falls back to its
    # internal default (3) and ignores user-set .config.json overrides; with
    # threshold=9999 + 5-page plan, Stage 1 would NOT emit inline_bodies
    # (5 ≥ 3 → fanout under default), main then chooses sub-threshold
    # branch (5 < 9999) and aborts on lex-set mismatch.
    # F2 fix (v1.4.2 — handoff §1.F2) — §3.9 4th invocation site.
    # Bracket the single-source Stage 1 analysis dispatch with pre-snapshot
    # + post-scan to match the 3 existing sites (Step 7.5.M-A multi-source
    # A4, Step 7.5.M-B Case B2 collision second-pass, Step 7.6.B-post A5
    # fanout). Without this, a misresolved or downgraded
    # `wiki-synthesizer-analysis` subagent (V-0 fail mode — `general-purpose`
    # substitution with Read+Write+Edit access) could mutate `<wiki_root>/`
    # during Stage 1 analysis, undetected by §3.9. Pre-snapshot here
    # captures baseline before Stage 1 runs; post-scan after Stage 1
    # returns + before page_plan branching catches Stage 1 mutation
    # regardless of sub-threshold vs A5 fanout downstream branch.
    STAGE_1_START_MS=$(_ts_ms)    # B3 v1.4.2 — phase_timing_ms capture
    _post_dispatch_pre_snapshot   # Sets PRE_DISPATCH_HASH if WIKI_TEST_MODE=1
    invoke deep-wiki:wiki-synthesizer-analysis a5_fanout_threshold=$A5_FANOUT_THRESHOLD  # qualified namespace per V-0 empirical finding (handoff §0); mode arg dropped (agent identity replaces it)
    page_plan = synthesizer.page_plan
    inline_bodies = synthesizer.inline_bodies
    source_hashes = synthesizer.source_hashes
    _post_dispatch_dirty_scan "A5-analysis" || abort_ingest  # F2 v1.4.2 fix — bracket Stage 1 LLM execution window
    STAGE_1_END_MS=$(_ts_ms)      # B3 v1.4.2 — Stage 1 wall-clock end

    # F1 fix (v1.4.2 — handoff §1.F1; post-review fixups F1.1+F1.2+F1.3
    # from /deep-review post-impl drift check) — main re-reads existing
    # page bytes from DISK as the authoritative C3 hash baseline. v1.4.1
    # dogfood found the Stage 1 LLM occasionally emits dramatically-
    # truncated existing_page_body (e.g., 12.3KB disk → 0.7KB emit, 20KB
    # disk → 0.6KB emit), which previously corrupted main's hash compute
    # → Step 7.6.C C3 always saw "concurrent ingest detected" against the
    # actual disk bytes → every update aborted. Disk-read closes the gap.
    # The synthesizer's existing_page_body is no longer consumed for
    # Stage 2 worker / inline-write context — main's disk-read is
    # authoritative for both the C3 hash baseline AND downstream context.
    # Synth bytes flow only into the WARN telemetry comparison.
    # (Subsumes prior P6 hash-from-emit compute — no separate compute pass.)
    #
    # Concurrent-detection scope: hash comparison is consistent within
    # Stage 3 (both F1 capture and C3 re-check use `$(cat …)` byte-stripping),
    # so a concurrent /wiki-ingest commit between this F1 read and Stage 3
    # lock acquire is detected by C3. Pre-v1.4.2 hash baseline came from
    # synthesizer's read at fetch-time; v1.4.2 baseline comes from main's
    # post-Stage-1 disk read. Both protect the window between baseline
    # capture and Stage 3 lock — same shape, narrower window. Stage 3
    # success/abort decisions are equivalent for spec-compliant agents.
    for entry in page_plan:   # F1_DRIFT_DETECTED initialized at sources_count == 1 entry block (above)
        if entry.action == "update":
            # F1.3 fix (basename traversal guard) — apply the same
            # `^[a-z0-9][a-z0-9-]*\.md$` regex Step 7.6.B Gate 3.5 + Step
            # 7.6.C defense-in-depth use, BEFORE constructing page_path
            # or reading from disk. A prompt-injected entry.file like
            # "../../etc/passwd" would otherwise read outside <wiki_root>/pages
            # and place those bytes into existing_page_body for downstream
            # Stage 2 / inline-write context.
            if ! printf '%s' "${entry.file}" | grep -qE '^[a-z0-9][a-z0-9-]*\.md$'; then
                FAILED_PAGES+=({file: "${entry.file}", reason: "page_plan update entry has invalid kebab-case basename — refused at F1 v1.4.2 disk-read guard (path traversal protection; same regex as Step 7.6.B Gate 3.5 / Step 7.6.C defense-in-depth)"})
                FAILED_PAGE_FILES+=("${entry.file}")  # R3.C-3 fix — parallel-array per Step 7.6 disclaimer (line 1392-1404). do_all_failed_under_lock + Step 7.6.F sentinel readers project FAILED_PAGE_FILES; the FAILED_PAGES tuple is bash-internal only.
                PARTIAL_FAIL=true
                page_plan_drop "${entry.file}"
                inline_bodies_drop "${entry.file}"
                continue
            fi

            page_path="$WIKI_ROOT/pages/${entry.file}"
            if [ ! -f "$page_path" ]; then
                # Synthesizer claimed update but file is absent on disk —
                # Stage 1 hallucination or post-Stage-1 deletion. Treat as
                # FAILED so the page does not enter Stage 2/3.
                FAILED_PAGES+=({file: "${entry.file}", reason: "page_plan update entry but page absent on disk (F1 v1.4.2 disk-authoritative gate)"})
                FAILED_PAGE_FILES+=("${entry.file}")  # R3.C-3 fix — parallel-array.
                PARTIAL_FAIL=true
                # Drop entry from page_plan (and from inline_bodies if
                # sub-threshold). Implementer note: Bash 3.2 portable
                # array filter — write to temp array then reassign. The
                # markdown-spec pseudocode below (`page_plan_drop`,
                # `inline_bodies_drop`) is shorthand for that filter.
                page_plan_drop "${entry.file}"
                inline_bodies_drop "${entry.file}"
                continue
            fi
            # Disk read (full bytes, no offset/limit — POSIX cat is
            # equivalent to Read with no limit and is bash-portable).
            disk_body=$(cat "$page_path") || {
                FAILED_PAGES+=({file: "${entry.file}", reason: "disk read failed during F1 v1.4.2 disk-authoritative gate"})
                FAILED_PAGE_FILES+=("${entry.file}")  # R3.C-3 fix — parallel-array.
                PARTIAL_FAIL=true
                page_plan_drop "${entry.file}"
                inline_bodies_drop "${entry.file}"
                continue
            }
            # R2.F1.6 fix (v1.4.2 2nd-round /deep-review — 2/3 reviewer
            # agreement: Codex review P1 + Codex adversarial high) —
            # concurrent-ingest baseline race. Pre-fixup F1 size-delta
            # heuristic only escalated when |disk-emit| > 4 bytes. That
            # left a window: between Stage 1's read (T0) and main's F1
            # cat (T1), a concurrent /wiki-ingest could commit a same-
            # size byte change (or a truncation-pattern matching change)
            # that F1 silently absorbs as the new C3 baseline. Stage 3
            # then passes C3 (against post-concurrent-commit disk) and
            # writes our session's body — silently overwriting the
            # concurrent commit. Fix: replace size-delta with HASH-COMPARE.
            # Any byte-level difference between synth's emit and disk
            # bytes triggers F1_DRIFT_DETECTED → force A5 fanout, which
            # re-synthesizes from current disk via Stage 2 workers
            # (concurrent commit's content is preserved in the worker's
            # input; our session's source contribution merges on top).
            # Hash both with the same `$(cat …)` byte-stripped form for
            # symmetric comparison. WARN telemetry retained for
            # operator visibility.
            synth_hash=$({ printf '%s' "${entry.existing_page_body}" | shasum -a 256 2>/dev/null \
                           || printf '%s' "${entry.existing_page_body}" | sha256sum 2>/dev/null; } \
                         | awk '{print $1}')
            disk_hash=$({ printf '%s' "$disk_body" | shasum -a 256 2>/dev/null \
                          || printf '%s' "$disk_body" | sha256sum 2>/dev/null; } \
                        | awk '{print $1}')
            if [ "$synth_hash" != "$disk_hash" ]; then
                # Drift detected (truncation OR concurrent-ingest commit
                # in T0→T1 window — F1 cannot distinguish, both demand
                # re-synthesis).
                emit_size=$(printf '%s' "${entry.existing_page_body}" | wc -c | awk '{print $1}')
                disk_size=$(printf '%s' "$disk_body" | wc -c | awk '{print $1}')
                delta=$((disk_size - emit_size))
                [ "$delta" -lt 0 ] && delta=$((-delta))
                echo "WARN: synthesizer existing_page_body drift for ${entry.file} (emit=${emit_size}B, disk=${disk_size}B, delta=${delta}B, synth_hash=${synth_hash:0:12}, disk_hash=${disk_hash:0:12}); main using disk bytes + escalating to A5 fanout (F1 v1.4.2 fix; R2.F1.6 hash-compare). Cause: synthesizer truncation OR concurrent /wiki-ingest commit during Stage 1 LLM execution." >&2
                F1_DRIFT_DETECTED=true   # F1.1 fix — force A5 fanout below
            fi
            # Authoritative replacement — main's hash baseline + Stage 2
            # worker / A5 fanout context (NOT inline-write — see F1.1
            # branch override below). Synthesizer's existing_page_body is
            # discarded; only its hash flowed into the drift detection
            # above.
            entry.existing_page_body="$disk_body"
            entry.existing_body_hash="$disk_hash"   # Reuse disk_hash (same value as old recompute path, no double-shasum).
        # action == "create" entries keep existing_body_hash = null (no prior body to hash).

    if len(page_plan) == 0 and len(FAILED_PAGES) == 0:
        # A8 — empty plan terminal-skip flow (Step 7.8 below).
        # Synthesizer judged no pages need update AND F1 gate dropped no
        # entries → genuine no-op. Promotes the source as accounted for
        # (yaml updated, ingest-skip log line emitted).
        do_ingest_skip_terminal_under_lock(SOURCES[0], source_hashes)
        exit "1 source skipped — analysis judged no pages need update."

    elif len(page_plan) == 0 and len(FAILED_PAGES) > 0:
        # R2.F1.7 fix (v1.4.2 2nd-round /deep-review — 2/3 reviewer
        # agreement: Codex review P2 + Codex adversarial high) — F1 gate
        # dropped ALL update entries (e.g., every entry was basename-
        # invalid OR every page absent on disk OR every disk read failed).
        # Pre-fixup len(page_plan)==0 routed through `do_ingest_skip_
        # terminal_under_lock`, which emits an `ingest-skip` log line and
        # promotes the source as accounted for via yaml update — but
        # writes NO `partial_fail` sentinel. The source then never retries
        # on next session, hiding a real failure as a clean skip. Fix:
        # gate Step 7.8 terminal-skip on FAILED_PAGES being EMPTY.
        # When non-empty (this branch), route through partial-failure
        # finalization: acquire lock, write partial_fail sentinel for
        # the source slug, emit one `ingest` log line with
        # `pages_created: []`, `pages_updated: []`,
        # `pages_failed: [<F1-dropped files>]`, do NOT promote
        # `.pending-scan`. Mirrors Step 7.7.B "all-fail" path semantics.
        # phase_timing_ms is emitted (the action is `ingest`, not
        # `ingest-skip`) so the operator audit trail shows wall-clock
        # spent on the failed F1 gate.
        #
        # R3.P2.1 fix (3rd-round 2/3 review) — pass extracted slug
        # explicitly. SOURCES[0] is the descriptor encoding (slug|origin|type);
        # do_all_failed_under_lock's first arg is the SLUG used as the
        # yaml path key. Without extraction, sources/<slug|origin|type>.yaml
        # would be the wrong path → partial_fail sentinel never lands at
        # the canonical location → Step 1.5's partial-fail-recovery
        # cascading detection misses on next session.
        # R3.W-1 fix — capture STAGE_3_START_MS_FAIL so the function's
        # phase_timing_ms.stage_3_write value scopes to lock+yaml+log only.
        STAGE_3_START_MS_FAIL=$(_ts_ms)
        slug="${SOURCES[0]%%|*}"
        # R3.C-3 fix — pass FAILED_PAGE_FILES parallel array explicitly
        # (function reads it for pages_failed_json projection).
        do_all_failed_under_lock("$slug", FAILED_PAGES, FAILED_PAGE_FILES, source_hashes)
        exit "1 source: all entries failed F1 disk-authoritative gate (basename / missing / disk-fail). partial_fail sentinel written; .pending-scan NOT promoted; next session will retry (or 3-strike escape via ingest-fail)."

    elif len(page_plan) < a5_fanout_threshold and ! F1_DRIFT_DETECTED:
        # A5 sub-threshold — Stage 1 already emitted bodies in inline_bodies.
        # No Stage 2 worker dispatch. Skip to Stage 3 atomic write.
        do_atomic_write_from_inline_bodies(page_plan, inline_bodies, source_hashes)

    elif len(page_plan) < a5_fanout_threshold and F1_DRIFT_DETECTED:
        # F1.1 fix (v1.4.2 post-impl review — 2/3 reviewer agreement) —
        # drift detected on a sub-threshold update entry. Stage 1's
        # inline_bodies were generated from the truncated existing_page_body
        # the synthesizer captured BEFORE main re-read disk. Writing those
        # inline_bodies would silently corrupt unrelated sections (the
        # synthesizer's merge logic for Rule 5 + preserve_sections relied
        # on seeing the full prior page; with truncated context, those
        # sections are missing from the generated body). Pre-v1.4.2 caught
        # this LOUDLY via C3 abort. v1.4.2 base disk-read recovers the C3
        # baseline but does NOT restore the Stage 1 synthesis. Force the
        # A5 fanout path so Stage 2 page-writer workers re-synthesize each
        # affected page from the disk-bytes existing_page_body main just
        # captured. Inline_bodies are discarded (workers ignore them).
        echo "INFO: F1 drift detected on sub-threshold path — escalating to A5 fanout so Stage 2 workers re-synthesize from disk-bytes context (preserves pre-v1.4.2 LOUD-failure property for affected pages while recovering retry-correctness)" >&2
        inline_bodies=[]   # Discard stale Stage 1 bodies; workers will regenerate.
        do_a5_fanout(page_plan, source_hashes)

    else:
        # A5 fanout active (page_plan ≥ threshold, OR drift forced fanout above) — Step 7.6 below.
        do_a5_fanout(page_plan, source_hashes)

if sources_count >= 2:
    do_v1_3_0_a4_fanout()  # unchanged (existing Step 7.5.M-A through 7.5.M-D)
```

The single-source A5 path branches further on `len(page_plan)` after the
analysis-mode synthesizer returns; see Step 7.5.A (sub-threshold), Step 7.6
(A5 fanout) and Step 7.8 (empty-plan terminal-skip) for the per-branch
flow. The multi-source path is unchanged from v1.3.0 — Step 7.5.M-A through
Step 7.5.M-D below contain the A4 fanout logic verbatim. The `≥2 sources`
branch acquires the global lock NOW (Phase 0 for fanout) before entering
Step 7.5.M-A.

##### Step 7.5.B — `do_all_failed_under_lock` (R2.F1.7 fix v1.4.2 + 3rd-round R3 fixups)

`do_all_failed_under_lock(slug, FAILED_PAGES, FAILED_PAGE_FILES, source_hashes)` mirrors the
Step 7.7.B "all workers failed" partial-failure finalization, adapted for
the F1-gate-drops-all-entries case (no Stage 2 dispatch occurred — drops
happened at Step 7.5 single-source branch). Signature: caller passes the
extracted source slug (R3.P2.1 — NOT the descriptor tuple), the populated
FAILED_PAGES + FAILED_PAGE_FILES parallel arrays (R3.C-3 fix), and
source_hashes.

```bash
do_all_failed_under_lock(slug, FAILED_PAGES, FAILED_PAGE_FILES, source_hashes) {
  # R3.C-1 fix (3rd-round /deep-review Opus) — soft-fail on lock contention.
  # Pre-fixup `mkdir … || exit 1` would terminate the whole /wiki-ingest
  # script before the caller's user-facing exit message + before any
  # diagnostic output. For the F1 all-dropped path specifically, a benign
  # concurrent /wiki-ingest holding the lock would silently lose the
  # partial_fail signal — the very failure mode R2.F1.7 was meant to close.
  # New behavior: WARN, return non-zero. .pending-scan remains unpromoted
  # (still no promotion since this path never reaches the promotion step),
  # so retry semantics still hold via SessionStart hook re-detection on
  # next session. Caller's exit message surfaces normally.
  if ! mkdir "<wiki>/.wiki-meta/.wiki-lock" 2>/dev/null; then
    echo "WARN: Wiki locked; F1 all-dropped path could not write partial_fail sentinel for $slug. Source state preserved as-is — .pending-scan NOT promoted, next session re-detects + retries F1 gate." >&2
    return 1
  fi
  trap 'rmdir "<wiki>/.wiki-meta/.wiki-lock" 2>/dev/null || true' EXIT

  yaml="<wiki>/.wiki-meta/sources/${slug}.yaml"

  # R3.C-2 fix (3rd-round /deep-review Opus) — first-ingest baseline yaml
  # materialization. Step 7.7.B's R4-Adv-Adv-2 fix (line ~2009-2035)
  # explicitly handles the case where sources/<slug>.yaml does NOT exist
  # yet (brand-new source whose first ingest hits all-fail). do_all_failed_
  # under_lock claims to mirror Step 7.7.B but pre-R3 was missing this
  # block — first-ingest all-F1-dropped case would produce a yaml that
  # contains only the partial_fail block but lacks id/type/origin/
  # content_hash/pages_created/pages_updated, breaking Step 1.5 +
  # downstream consumers. Fix: cross-reference and inline the same
  # baseline block.
  if [ ! -f "$yaml" ]; then
    # Mirror Step 7.7.B R4-Adv-Adv-2 (line ~2017-2035): materialize a
    # baseline yaml using Step 8e's schema with empty page arrays before
    # the partial_fail sentinel write. The source descriptor is rebuilt
    # from the slug + the SOURCES[0] tuple held in caller scope (the
    # caller invokes this only for sources_count == 1 paths, so SOURCES[0]
    # is the canonical descriptor for $slug).
    src_origin="${SOURCES[0]#*|}"; src_origin="${src_origin%|*}"
    src_type="${SOURCES[0]##*|}"
    cat > "$yaml" <<YAML_EOF
id: $slug
type: $src_type
origin: $src_origin
content_hash: ${source_hashes[$slug]:-main-computes}
pages_created: []
pages_updated: []
ingested_at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
YAML_EOF
  fi

  # 1. Source provenance yaml — append `partial_fail: {ts, failed_pages,
  #    reason}` sentinel block so Step 1.5's partial-fail-recovery
  #    cascading detects on next session and forces REPAIR.
  #    Reason value: "all f1 dropped" (R3.W-2 fix — taxonomy-consistent
  #    space-separated form, per the canonical vocabulary at Step 7.6.F
  #    line ~1923).
  partial_fail_block=$(cat <<PFAIL_EOF
partial_fail:
  ts: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
  reason: "all f1 dropped"
  failed_pages: [$(printf '"%s",' "${FAILED_PAGE_FILES[@]}" | sed 's/,$//')]
PFAIL_EOF
)
  printf '%s\n' "$partial_fail_block" >> "$yaml"

  # R3.P2.2 fix (3rd-round 2/3 review) — 3-strike retry counter.
  # Mirrors Step 7.5.M-D's pattern (multi-source all-workers-fail).
  # Counter format: "<window_epoch>:<count>" stored in
  # <wiki>/.wiki-meta/.pending-scan-retry-count. Without this counter,
  # an auto-ingest scan window with a persistent F1-all-dropped source
  # (e.g., synthesizer keeps hallucinating absent pages) loops
  # indefinitely. Same 3-strike escape as v1.3.0 ingest-fail action:
  # on 3rd consecutive same-window failure, emit ingest-fail + promote
  # .pending-scan to release stuck state.
  RETRY_FILE="<wiki>/.wiki-meta/.pending-scan-retry-count"
  current_window=$(cat "<wiki>/.wiki-meta/.pending-scan" 2>/dev/null || echo "")
  current_count=0
  if [ -n "$current_window" ] && [ -f "$RETRY_FILE" ]; then
    saved=$(cat "$RETRY_FILE" 2>/dev/null || echo ":")
    saved_window="${saved%%:*}"
    saved_count="${saved##*:}"
    if [ "$saved_window" = "$current_window" ]; then
      current_count="$saved_count"
    fi
  fi
  current_count=$((current_count + 1))
  printf '%s:%d' "$current_window" "$current_count" > "$RETRY_FILE"

  # 2. Append one log.jsonl line. action choice depends on retry count:
  #    - count < 3: action `ingest` with pages_failed populated (normal
  #      retry-required emit; .pending-scan NOT promoted)
  #    - count >= 3: action `ingest-fail` (3-strike escape; .pending-scan
  #      IS promoted to release stuck state — mirrors v1.3.0 Step 7.5.M-D)
  LOG_EMIT_MS=$(_ts_ms)

  # R3.W-1 fix (3rd-round Opus single-reviewer) — STAGE_3_START_MS scoped
  # to the lock+yaml+log section, NOT to INGEST_T0_MS. Pre-fixup formula
  # set stage_3_write == total which violated the "total >= sum(stages)"
  # invariant documented at line ~593. Capture STAGE_3_START_MS at the
  # top of this function (before mkdir lock attempt) to scope correctly.
  PT_STAGE_1_MS=$(( ${STAGE_1_END_MS:-0} - ${STAGE_1_START_MS:-0} ))
  PT_STAGE_2_MS=0   # No Stage 2 (F1 dropped before fanout)
  PT_STAGE_3_MS=$(( LOG_EMIT_MS - ${STAGE_3_START_MS_FAIL:-${LOG_EMIT_MS}} ))
  PT_TOTAL_MS=$((  LOG_EMIT_MS - ${INGEST_T0_MS:-0} ))
  PHASE_TIMING_JSON=$(printf '{"stage_1_analysis":%d,"stage_2_fanout":%d,"stage_3_write":%d,"total":%d}' \
                     "$PT_STAGE_1_MS" "$PT_STAGE_2_MS" "$PT_STAGE_3_MS" "$PT_TOTAL_MS")

  pages_failed_json=$(printf '%s\n' "${FAILED_PAGE_FILES[@]}" | jq -R . | jq -s -c .)

  if [ "$current_count" -ge 3 ]; then
    # 3-strike escape — emit ingest-fail, promote .pending-scan, clear counter.
    emit_log_line action=ingest-fail source=$slug pages_created=[] pages_updated=[] \
                  pages_failed=$pages_failed_json phase_timing_ms=$PHASE_TIMING_JSON \
                  fail_reason="all_f1_dropped_3_strike"
    # Promote .pending-scan despite failure (release stuck state) — same
    # contract as v1.3.0 Step 7.5.M-D ingest-fail.
    if [ -n "$current_window" ]; then
      mv "<wiki>/.wiki-meta/.pending-scan" "<wiki>/.wiki-meta/.last-scan"
    fi
    # Clear retry counter.
    rm -f "$RETRY_FILE"
    echo "ERROR: F1 all-dropped path hit 3-strike escape for $slug. .pending-scan promoted; manual investigation required." >&2
  else
    # Normal retry-required emit — action `ingest` with pages_failed.
    emit_log_line action=ingest source=$slug pages_created=[] pages_updated=[] \
                  pages_failed=$pages_failed_json phase_timing_ms=$PHASE_TIMING_JSON
    # 3. Do NOT promote .pending-scan (next session re-detects + retries
    #    via partial-fail-recovery cascading → forced REPAIR).
  fi

  # 4. Release lock + clear EXIT trap (R3.C-1 fix mirror — same pattern
  #    as Step 7.7.B line ~2056 / Step 7.6.G line ~1983).
  rmdir "<wiki>/.wiki-meta/.wiki-lock"
  trap - EXIT
}
```

Caller-side `STAGE_3_START_MS_FAIL` capture (Step 7.5 single-source branch
just before the `do_all_failed_under_lock` call):

```bash
STAGE_3_START_MS_FAIL=$(_ts_ms)
slug="${SOURCES[0]%%|*}"
do_all_failed_under_lock "$slug" "${FAILED_PAGES[@]}" "${FAILED_PAGE_FILES[@]}" "${source_hashes[@]}"
```

Implementation notes:
- The `phase_timing_ms.stage_3_write` value scopes to the lock+yaml+log
  section only (R3.W-1 fix). This produces a meaningful delta even for
  this all-failed path (vs. the pre-R3 form where stage_3_write equaled
  total). B3.1 path-coverage matrix has a row for this path.
- `partial_fail.failed_pages` matches the union pattern used by Step
  7.6.F (FAILED_PAGE_FILES ∪ FAILED_WORKER_FILES) — for this case
  FAILED_WORKER_FILES is empty (no fanout), so the union reduces to
  FAILED_PAGE_FILES.
- This sub-step's invocation is mutually exclusive with Step 7.6.A
  page-writer dispatch — only one of the two fires per single-source
  ingest. Multi-source A4 path uses Step 7.7.B (the original all-workers-
  fail handler) and is unaffected by R2.F1.7.
- The 3-strike retry counter is shared with Step 7.5.M-D multi-source
  ingest-fail logic (same `RETRY_FILE`). Concurrent multi-source +
  single-source failures at the same `.pending-scan` window aggregate
  their counts — this matches the `<wiki>/.wiki-meta/.pending-scan-retry-count`
  schema's intended semantics (per-window, not per-path).

#### Step 7.5.A — Sub-threshold atomic write from `inline_bodies` (W6 fix)

When `page_plan` is non-empty AND `len(page_plan) < a5_fanout_threshold`,
Stage 1 already emitted full bodies inside `inline_bodies` (no Stage 2
worker dispatch). Main consumes those bodies directly through the same
Stage 3 path A5 fanout uses, with the C3 concurrency check still mandatory.
Same lock semantics, same backup/write/sentinel flow as Step 7.6.C-G.

```bash
do_atomic_write_from_inline_bodies(page_plan, inline_bodies, source_hashes) {
  # Inline_bodies acts as SUCCESS_DRAFTS — no FAILED_WORKERS possible (no fanout).
  SUCCESS_DRAFTS=()
  FAILED_WORKERS=()  # Always empty in sub-threshold path.

  # Verify lex-set match BEFORE assembling drafts (caller MUST emit inline_bodies
  # with same files as page_plan). Contract violations caught early — no partial
  # draft state possible if check fails.
  if [ "$(echo "${page_plan[@]/.file}" | sort)" != "$(echo "${inline_bodies[@]/.file}" | sort)" ]; then
    echo "ERROR: page_plan / inline_bodies file lex-set mismatch — Stage 1 contract violated"
    exit 1
  fi

  # Convert inline_bodies to the same draft shape Step 7.6.C consumes.
  for body in "${inline_bodies[@]}"; do
    pe="<corresponding page_plan entry where pe.file == body.file>"
    SUCCESS_DRAFTS+=({
      file: body.file,
      page_content: body.page_content,
      frontmatter_meta: pe.frontmatter_meta
    })
  done

  # Reuse the Step 7.6.C-G atomic-write block VERBATIM:
  #  - Step 7.6.C: lock acquire + mandatory C3 concurrency check + backup + atomic write
  #  - Step 7.6.D: manifest conversion (with P7 sources lift)
  #  - Step 7.6.E: Step 8a-8h execution
  #  - Step 7.6.F: partial_fail sentinel write OR removal-on-success
  #  - Step 7.6.G: lock release
  #
  # PARTIAL_FAIL semantics identical: any Stage 3 error (C3 abort, backup, write, rename)
  # toggles PARTIAL_FAIL=true. FAILED_WORKERS is always empty so no pre-loop toggle needed.
  call_step_7_6_C_through_G "${SUCCESS_DRAFTS[@]}"
}
```

Implementer note: in markdown-spec pseudocode, `call_step_7_6_C_through_G`
is shorthand for the LLM to inline the same logic — both paths share the
same atomic-write algorithm, parameterized only by the source of drafts
(workers vs `inline_bodies`).

#### Step 7.5.M-A — Parallel worker dispatch (multi-source A4 — Phase 1)

**§3.9 worker mutation detection — pre-snapshot:**

Before dispatching the parallel workers, capture a baseline hash of the wiki tree (gated by `WIKI_TEST_MODE=1`; production skips), AND capture the multi-source path's Stage 1 start timestamp for `phase_timing_ms`:

```bash
STAGE_1_START_MS=$(_ts_ms)    # B3 v1.4.2 — phase_timing_ms capture (multi-source path)
_post_dispatch_pre_snapshot   # Sets PRE_DISPATCH_HASH if WIKI_TEST_MODE=1
```

The matching `_post_dispatch_dirty_scan "A4-fanout"` invocation fires at the start of Step 7.5.M-B (before the B5 ledger build), bracketing the worker LLM execution window.

Split sources across **`min(3, ${#SOURCES[@]})`** deep-wiki:wiki-synthesizer-worker
subagents. Sources are sorted lexicographically by `origin` (source path)
for deterministic worker assignment across reruns. Round-robin distribution:
`source[i] → worker (i % WORKER_COUNT)`. **Dispatch all N workers in a
single Agent-tool-message-turn** (the LLM emits N parallel Agent tool
invocations in one assistant turn — that is the actual parallel mechanism
in Claude Code; there is no shell-side orchestrator).

Each worker invocation specifies `subagent_type: "deep-wiki:wiki-synthesizer-worker"` (qualified namespace per V-0 empirical finding) with
input descriptor:

(The `mode` field is removed in v1.4.1+ — agent identity `deep-wiki:wiki-synthesizer-worker` replaces it.)

```json
{
  "wiki_root": "<absolute path>",
  "source_shard": {
    "sources": [<source descriptors assigned to this worker, sorted>]
  },
  "candidates": [<candidate descriptors — same snapshot for all workers>]
}
```

The candidates list is a snapshot taken AFTER Phase 0 lock acquisition, so
all workers see the same wiki state.

**Reference (non-executable) example** of the round-robin split:

```bash
# Reference only — actual mechanism is parallel Agent tool invocations
WORKER_COUNT=3
[ ${#SOURCES[@]} -lt $WORKER_COUNT ] && WORKER_COUNT=${#SOURCES[@]}
SORTED_SOURCES=$(printf '%s\n' "${SOURCES[@]}" | sort)
i=0
WORKER_BUCKETS=""
while IFS= read -r src; do
  worker_idx=$((i % WORKER_COUNT))
  WORKER_BUCKETS="${WORKER_BUCKETS}${worker_idx}|${src}"$'\n'
  i=$((i + 1))
done <<< "$SORTED_SOURCES"
# Then group by worker_idx and dispatch each subset to a parallel Agent call.
```

#### Step 7.5.M-B — Aggregate drafts (multi-source A4 — Phase 2, sequential, in-memory)

**§3.9 worker mutation detection — post-dispatch scan:**

Before building the in-batch ledger, verify no worker mutated the wiki tree during their LLM execution window (gated by `WIKI_TEST_MODE=1`; production skips):

*Note: `abort_ingest` is shorthand for the abort sequence documented inside `_post_dispatch_dirty_scan` (set sentinel, log event, do not promote `.pending-scan`); implementer inlines those steps per Step 7.7.A worker-mutation failure handling. Same convention applies at the other 3 invocation sites (Step 7.5 single-source A5-analysis [v1.4.2 F2], Step 7.5.M-B Case B2, and Step 7.6.B-post).*

```bash
_post_dispatch_dirty_scan "A4-fanout" || abort_ingest
STAGE_1_END_MS=$(_ts_ms)      # B3 v1.4.2 — multi-source A4 Stage 1 end (worker-fanout return)
```

On mismatch: function emits `FATAL: ...` to stderr, sets `PARTIAL_FAIL=true` + `FAILED_REASON="worker_mutation_detected (A4-fanout)"`, and triggers Step 7.7.A worker-mutation failure handling. The ingest aborts; `.pending-scan` is NOT promoted.

Once all workers return, the agent collects their `drafts[]` arrays into a
single `ALL_DRAFTS` list. The aggregation runs B5 dual-classification with
the v1.2.1 rules extended for fanout:

1. **Build in-batch ledger** (in-memory; main is the single writer, no
   file-lock needed for this in-memory structure):

   ```
   ledger = {}  # proposed_file → list of (worker_idx, draft_idx, draft)
   for worker_idx, worker in enumerate(ALL_WORKER_RESULTS):
     for draft_idx, draft in enumerate(worker.drafts):
       ledger.setdefault(draft.proposed_file, []).append((worker_idx, draft_idx, draft))
   ```

2. **Resolve cross-worker collisions** (fixes Cycle-1 CV-2 + SS-7 + W12):
   For each `proposed_file` with >1 proposers:

   - **Determine canonical ordering** by `origin` (source path) lexicographic
     order, NOT `source_slug`. Slug allocator may suffix-bump based on batch
     order; using slug for tie-breaking would make the final wiki state
     non-deterministic across reruns. **`origin` (or `source_path`) is the
     only stable source-key.**

   - **Case A — All drafts have `proposed_action == "skip"`:** collapse to
     one ingest-skip log entry per source slug; no page write.

   - **Case B — All drafts have `proposed_action == "create"` or `"update"`:**

     - **B1 — Byte-identical `page_content`:** write the canonical draft
       once; append all contributing source_slugs to the page's frontmatter
       `sources:` field AND record each contributing slug's `pages_created`
       per v1.2.1 B5 (per-source provenance). **Sort the resulting `sources:`
       array lexicographically by slug** before writing the page (W12 fix —
       ensures byte-identical output across reruns regardless of worker
       return order).

     - **B2 — `page_content` differs across drafts (CV-2 second-pass + Plan
       #2.1 Cycle-2 C2V-1 mode fix):** the workers analyzed the same
       target page from different sources but produced non-identical
       bodies. Run a SECOND PASS — but use **`mode: "worker"`** (NOT
       `"inline"`, which would write files during Phase 2 and break the
       single-writer invariant):

       **§3.9 worker mutation detection — pre-snapshot (B2 only, conditional):**

       Before dispatching the second-pass synthesizer worker, re-snapshot (gated by `WIKI_TEST_MODE=1`):

       ```bash
       _post_dispatch_pre_snapshot   # re-captures PRE_DISPATCH_HASH for the B2 window
       ```

       After the second-pass worker returns its merged draft (BEFORE main proceeds to write merged content during Phase 3), invoke the scan:

       ```bash
       _post_dispatch_dirty_scan "A4-second-pass" || abort_ingest
       ```

       On mismatch: same handling as Site 1 (Step 7.7.A failure path, PARTIAL_FAIL=true, ingest aborts).

         1. Main dispatches a **single** `deep-wiki:wiki-synthesizer-worker` subagent (qualified namespace per V-0 empirical finding) with the new `colliding_drafts` input field
            (defined in Task 8 Plan #2.1 extension). The `mode` field is removed in v1.4.1+ — agent identity replaces it. Input shape:
            ```json
            {
              "wiki_root": "...",
              "source_shard": {
                "sources": [<union of contributing source descriptors>]
              },
              "candidates": [<existing wiki page if action=update, else []>],
              "colliding_drafts": [
                {"source_slug": "a", "page_content": "<body from worker A>"},
                {"source_slug": "b", "page_content": "<body from worker B>"}
              ]
            }
            ```
         2. The second-pass worker reads sources + colliding_drafts +
            existing page (if any), synthesizes ONE merged
            `page_content` honoring v1.2.1 multi-source merge semantics
            (Rule 6 conflict notation when sources disagree). Returns
            ONE draft via the standard worker output contract — NO
            file writes (worker mode contract enforced). **§3.9 scan:
            `_post_dispatch_dirty_scan "A4-second-pass"` fires HERE
            (between worker return and main's Phase 3 write below) per
            the pre-snapshot/scan pair documented above.**
         3. Main writes the merged content during Phase 3 (under the
            already-held lock); all contributing slugs go into
            `sources` (sorted lexicographically per W12).
       Cost: extra subagent invocation only on collision (rare — most
       multi-source batches don't have same-page overlap). Preserves the
       v1.2.1 invariant of "one merged page per topic across all
       contributing sources" AND the v1.3.0 single-writer invariant
       (all writes happen in Phase 3 via main).

   - **B3 — Genuinely-different topics under same slug:** when the
     second-pass synthesizer reports the topics are distinct (heuristic:
     no semantic overlap between drafts), main suffixes the later draft's
     slug to `<slug>-2`, `<slug>-3`, etc. Order by `origin` (source path)
     lexicographic — first proposer keeps the bare slug.

   - **If proposed actions differ across workers** (e.g., one says
     `create`, another says `update` for the same proposed_file): `update`
     wins (more conservative — assume the existing-wiki match is real).
     Reclassify the `create` draft to contribute its source to the merged
     page; second-pass synthesis (B2) handles content merge.

3. **Apply Step 1.5-equivalent finalization on aggregated drafts (fixes
   Cycle-1 SS-2):** for each draft whose source `type ∈ {file,
   deep-work-report}`, compare the source bytes sha256 (use the worker's
   `source_hashes[source_slug]` if it returned a 64-char hex; otherwise
   recompute from `origin` via `shasum -a 256` / `sha256sum`) against the
   existing `sources/<source_slug>.yaml:content_hash`. If match AND wiki
   state intact (R3W2 v1.2.1 forced-repair check passes), reclassify to
   ingest-skip (no write, just log entry). Forced-repair check runs
   identically to v1.2.1.

#### Step 7.5.M-C — Atomic write (multi-source A4 — Phase 3, lock per Phase 0 decision)

The lock state depends on the branch (per Step 7.5 preamble): held from
Phase 0 (multi-source) OR acquired here (single-source — exactly as
v1.2.1).

**B3 v1.4.2 phase_timing_ms capture** — at Step 7.5.M-C entry (immediately before the manifest conversion below), capture `STAGE_3_START_MS=$(_ts_ms)`. For the multi-source A4 path, the lock is already held (acquired at Phase 0/Step 7.5.M-A entry); the timestamp here marks transition from collision-resolved drafts to atomic write loop.

**Manifest conversion before Step 8 (Cycle-3 CV3-B fix):** Step 8's
existing parser expects the inline-mode response shape with top-level
`created`, `updated`, `versioned`, `failed`, `source_hashes` arrays.
Worker-mode responses use a different shape (`mode`, `drafts`,
`source_hashes`). Before invoking Step 8 logic, **main converts the
aggregated `ALL_DRAFTS` (post-Phase-2 collision resolution) into the
inline-mode manifest shape**:

- For each draft with `proposed_action == "create"`: append entry to
  `created` array with `{file: proposed_file, title: proposed_title,
  tags: proposed_tags, aliases: proposed_aliases, sources: [contributing
  source_slugs sorted lex per W12]}`. The draft's `page_content` is
  written by Step 8a per-draft.
- For each draft with `proposed_action == "update"`: append entry to
  `updated` array with the same shape. The draft's `merge_against` field
  identifies the page for Step 8's version-backup phase.
- `versioned` array starts empty; Step 8a's per-draft version backup
  populates it as backups land.
- `failed` array carries any drafts that the second-pass synthesis
  (Case B2) reported as "merge impossible" — surfaced to user but
  not retried automatically.
- `source_hashes` is the union of per-worker `source_hashes` maps
  (workers compute on read; main may recompute via `shasum` for
  sentinels per the existing v1.2.1 Step 8d normalization).

After this conversion, Step 8a-8h runs **per draft** as if it were the
v1.2.1 inline-mode response — no Step 8 spec changes needed. Step 8a-8h
covers: version snapshot for updates, page write, sources/*.yaml update,
log.jsonl append, index.json update, log.md update, index.md update,
retention prune. Plan implementer: re-read v1.2.1 Step 8 for the exact
sub-step list. Sort the per-draft execution order by `origin`
lexicographic (fixes SS-7) so reruns are deterministic.

After all drafts are written successfully, apply CONDITIONAL `.pending-scan`
promotion (fixes Cycle-1 CV-1 + W13 + Plan #2.1 Cycle-2 C2S-1 — separate
manifest for path retry state):

**Important format constraint (Cycle-2 C2S-1):** `.pending-scan` is a
**timestamp-only** file (matches `TS_RE` in v1.2.1 hook + lint scan-window
parser). Writing source paths INTO it makes the file malformed → next hook
iteration discards it → failed sources lost from retry. Plan #2 incorrectly
proposed this. Plan #2.1 fix: keep `.pending-scan` timestamp-only and use a
**separate** manifest file for path-level retry state.

- **`.pending-scan` exists AND all drafts succeeded:** promote
  `.pending-scan → .last-scan` normally. Delete any stale
  `.wiki-meta/.failed-sources.tsv` (clean state).
- **`.pending-scan` exists AND partial worker failure (N-1 succeeded):**
  do NOT promote `.pending-scan` (timestamp file unchanged). Instead, write
  the failed worker's source paths to **`<wiki>/.wiki-meta/.failed-sources.tsv`**
  (one path per line, TSV format `<source_path>\t<failure_reason>\t<ts>`).
  `.last-scan` unchanged. **Hook reads BOTH on next iteration:**
  `.pending-scan` for the unchanged window epoch, `.failed-sources.tsv` for
  the must-retry source paths (union with newly-detected files in window).
  Existing v1.2.1 partial-failure contract preserved (same effect — failed
  files retried — different mechanism).
- **`.pending-scan` exists AND all workers failed:** abort earlier in
  Phase 1 — Phase 3 not reached. `.failed-sources.tsv` not written
  (handled by the 3-strike retry counter logic in Step 7.5.M-D).
- **No `.pending-scan` (manual `/wiki-ingest fileA.md fileB.md`):** do NOT
  touch `.pending-scan` (it doesn't exist) AND do NOT write
  `.failed-sources.tsv` (manual invocation does not use scan window
  mechanism). Failed sources surfaced as "unprocessed" in stdout summary
  for user to re-invoke manually.

**Schema-coupled change (CLAUDE.md update required):** the new
`.wiki-meta/.failed-sources.tsv` file must be added to CLAUDE.md "Storage
layout (`<wiki_root>/`)" section as part of Task 10 release commit.

Release lock (multi-source) or release lock acquired in this Step (single-
source). Emit per-source action summary.

#### Step 7.5.M-D — Failure handling (multi-source A4)

(Updated to address Cycle-1 W3 + reflect CV-1 partial-fail handling +
Plan #2.1 C2S-1 manifest + C2-W5 counter edge cases.)

- **Worker subagent failure** (any worker returns error): main commits the
  N-1 successful workers' drafts (Phase 3 runs normally for those). Failed
  worker's sources are written to **`.wiki-meta/.failed-sources.tsv`**
  per Step 7.5.M-C (auto-ingest mode) — NOT into `.pending-scan` (Plan #2.1
  C2S-1 fix; `.pending-scan` is timestamp-only, see Step 7.5.M-C). For
  manual-mode invocation: omitted from the structured retry mechanism;
  surfaced in stdout summary as "unprocessed". Idempotent — Step 1.5
  hash-skip on next invocation handles the no-op case for sources that
  succeed-then-resucceed.

- **Worker timeout** (>5 min wall-clock, Agent tool default): treated as
  failure (same path as above).

- **All workers fail (single batch):** abort batch, NO Phase 3 execution,
  `.pending-scan` not promoted, `.last-scan` unchanged.

- **All workers fail repeatedly (3 consecutive batches on same `.pending-scan`
  window — W3 fix + Plan #2.1 Cycle-2 C2-W5 edge-case semantics):**
  maintain a counter at `<wiki>/.wiki-meta/.pending-scan-retry-count`.

  **Counter file format** (Plan #2.1, single line):
  ```
  <window_epoch>:<count>
  ```
  Example: `1735738200:2` (window epoch 1735738200, fail count 2).

  **Read semantics** (start of every all-workers-fail handling):
  - File missing or unreadable → treat as `<current_window_epoch>:0`
    (initialize on first failure).
  - Stored window_epoch ≠ current `.pending-scan` epoch → **reset count
    to 0** (different window; previous failures don't carry over to a
    new scan window). Write `<current>:0` (now becomes :1 after this
    increment).
  - Corrupt content (no colon, non-integer) → log warning, treat as
    `<current_window_epoch>:0`, overwrite cleanly on next write.

  **Write semantics** (after each all-workers-fail event):
  - Increment count by 1.
  - Write `<current_window_epoch>:<count>` (overwrites stored).
  - Atomic write (write to temp file, mv to final — same pattern as
    v1.2.1 lock + atomic ops).

  **Counter clear** (on successful — partial or full — batch):
  - Delete the file (next read sees missing → init to 0).
  - Note: a partial-success batch (N-1 succeed) DOES clear the counter
    even though some sources failed. Rationale: the failed-source-set
    is now in `.failed-sources.tsv` for targeted retry; the
    .pending-scan window is making progress; deterministic
    single-source failure won't loop infinitely because next iteration
    retries only that one source via the manifest, not the full window.
    If the same lone source persists in `.failed-sources.tsv` for
    repeated batches, the user-visible failure surface is via that
    manifest (TSV file with reason + timestamp), not via the
    .pending-scan-retry-count.

  When count reaches 3:
    1. Promote `.pending-scan → .last-scan` ANYWAY (releases the stuck
       window so the user can move forward; the alternative is an infinite
       hook-time retry loop on the same files).
    2. Append a new `ingest-fail` lifecycle event to `log.jsonl`. Per
       NC2 canonical-shape rule (Step 1.5), every action MUST preserve
       `{ts, action, source, pages_created, pages_updated}`. Concrete
       schema (Cycle-3 W-N2 + P3 fix — note: counter file format
       `<window_epoch>:<count>` does NOT store prior timestamps; use
       only the current trigger ts + window_epoch + retry_count to
       characterize the failure):

       ```jsonc
       {
         "ts": "<iso-8601 utc, current trigger time>",
         "action": "ingest-fail",
         "source": "<comma-separated source paths from .failed-sources.tsv>",
         "pages_created": [],
         "pages_updated": [],
         "failure_reason": "<worker error / timeout / lock-contention summary>",
         "window_epoch": <int — the .pending-scan epoch that hit 3 strikes>,
         "retry_count": 3
       }
       ```

       `pages_created` / `pages_updated` are empty (no pages produced by
       a failure event). The window_epoch + retry_count fields are
       v1.3.0+ extensions on top of the canonical NC2 shape, capturing
       enough context to correlate against `.pending-scan` history
       without storing prior timestamps.
    3. Emit a user-visible error message naming the affected files and
       suggesting `/wiki-ingest <file>` for manual retry with verbose
       output.
    4. Delete the counter file (cleared by side effect; next iteration
       starts fresh).

   The new `ingest-fail` lifecycle action is added to CLAUDE.md "Lifecycle
   actions" list as part of Task 10 (release commit). It is a terminal
   event — not retried further.

- **Phase 3 lock acquisition fails** (cannot happen if lock is held from
  Phase 0; this case is now N/A under the new lock scope for multi-source.
  For single-source, same semantics as v1.2.1).

- **Phase 3 mid-loop write failure**: roll back partial writes for the
  failing draft using its `.versions/` snapshot; abort remaining drafts in
  the batch; log error event; release lock; do NOT promote `.pending-scan`
  (per Step 7.5.M-C partial-fail rule). Drafts written successfully BEFORE the
  failure remain on disk (already committed atomically). Their log.jsonl
  entries also remain. The `.failed-sources.tsv` reduction includes any
  sources whose drafts were skipped due to mid-loop abort.

- **log.jsonl append failure**: fatal — Phase 3 atomicity is broken. Main
  attempts to roll back the just-written page using its `.versions/`
  snapshot, releases lock, surfaces a user-visible critical error. Do NOT
  promote `.pending-scan`.

### Step 7.6 — A5 fanout flow (single-source, page_plan ≥ a5_fanout_threshold)

After Step 7.5's analysis-mode invocation, when `len(page_plan) >= a5_fanout_threshold` (default 3), main dispatches one `wiki-page-writer` worker per `page_plan` entry, parallel.

> **Pseudocode disclaimer (P3+P5 fix, round-1 review — Opus C3+C5 + Codex adv D1):**
> The bash blocks in Step 7.6 below use markdown-spec pseudocode that the LLM running
> `/wiki-ingest` interprets at execution time. Specifically the following constructs are
> NOT runnable bash 3.2 and MUST be mapped to real shell during interpretation:
>
> - **Dotted field access** (`${draft.file}`, `${pe.action}`, `${pe.existing_body_hash}`,
>   `${draft.page_content}`) — represent positional fields of a JSON-encoded worker draft
>   (Stage 2 output) or a page_plan entry (Stage 1 output). Implementer parses each draft
>   into bash variables (e.g. `file=$(jq -r '.file' <<< "$draft")`) before the loop body, OR
>   the LLM directly substitutes the value when emitting the action. Both paths are
>   acceptable — the contract is what data flows where, not the exact extraction syntax.
> - **JSON-style array literals** (`FAILED_PAGES+=({file, reason: "..."})`) — represent
>   appending a tuple to an accumulator. Implementer maintains parallel `FAILED_PAGE_FILES`
>   + `FAILED_PAGE_REASONS` bash arrays (TSV-separated would also work) and consumes them
>   together when emitting the manifest in Step 7.6.D. The `failed[]` shape in the manifest
>   IS canonical JSON — only the bash-internal representation is implementation-flex.
>
>   **Q3 fix (round-3 review, Opus Q3) — same pattern applies to FAILED_WORKERS:** the W3
>   fix introduces `FAILED_WORKERS+=({file, fail_reason: "..."})` (note `fail_reason`,
>   not `reason`, matching the worker-output contract). Map to parallel arrays
>   `FAILED_WORKER_FILES` + `FAILED_WORKER_REASONS`. The W1 fix loop at Step 7.6.F
>   uses `FAILED_WORKER_FILES` to project the `file` field. Combined union for the
>   sentinel `failed_pages` payload + log emit (R-P2) is `FAILED_PAGE_FILES` ∪
>   `FAILED_WORKER_FILES`.
> - **Array field-strip** (`${arr[@]/.field}`) — represents iterating a struct-array and
>   projecting one field. Implementer iterates the parallel arrays directly.
>
> These pseudocode constructs are PRESENT for clarity (the data shape is the spec, the
> exact bash extraction is incidental). Bash 3.2 portable patterns to use during
> implementation: TSV temp files, parallel arrays, `jq -r` extraction, or the LLM
> directly emitting Edit calls with literal string values. Verify against bash 3.2
> macOS portability rules (no `declare -A`, no `mapfile`, no `${var,,}`, no `&>`)
> per CLAUDE.md "Bash 3.2 portability" section.

#### Step 7.6.A — Parallel page-writer dispatch

**§3.9 worker mutation detection — pre-snapshot:**

Before dispatching the parallel page-writer workers, capture a baseline hash (gated by `WIKI_TEST_MODE=1`) AND capture the Stage 2 fanout start timestamp:

```bash
STAGE_2_START_MS=$(_ts_ms)    # B3 v1.4.2 — phase_timing_ms capture (A5 fanout Stage 2 start)
_post_dispatch_pre_snapshot   # Sets PRE_DISPATCH_HASH if WIKI_TEST_MODE=1
```

The matching `_post_dispatch_dirty_scan "A5-fanout"` fires AFTER worker output validation (Step 7.6.B) but BEFORE Step 7.6.C atomic-write — bracketing the worker LLM execution window. Cycle-3 N1.2 fix: scan MUST run BEFORE main's legitimate writes, not after.

**§3.2 + V-0 empirical finding (handoff §0): subagent_type MUST be `deep-wiki:wiki-page-writer` (qualified namespace), NOT `general-purpose`.** The v1.4.0 dogfood failure root cause was main session voluntarily downgrading to `subagent_type: "general-purpose"` for `wiki-page-writer` workers — granting Read+Write+Edit and enabling unsafe writes outside the lock. V-0 empirically confirmed (per docs/handoff-2026-05-06-v1.4.1-task4.md Section 0 + scripts/v0-probe/results.tsv) that qualified namespace `deep-wiki:wiki-page-writer` resolves correctly; unqualified `wiki-page-writer` returns explicit Agent-not-found error (no silent substitution). DO NOT downgrade dispatch fallback to general-purpose under any circumstance — the explicit error is preferable to silent contract violation.

For each entry in `page_plan`, dispatch one `wiki-page-writer` agent in a single message (concurrent execution):

```
Agent({
  subagent_type: "deep-wiki:wiki-page-writer",
  run_in_background: true,
  prompt: <JSON-encoded {wiki_root, page_plan_entry: <entry>}>
})
```

All `len(page_plan)` agents are dispatched in ONE message (Claude Code subagent concurrency). Worker timeout: `a5_worker_timeout_sec` (default 90s).

#### Step 7.6.B — Aggregate worker drafts

Wait for all worker completion notifications (Claude Code runtime delivers automatically — no polling). Collect each worker's output JSON:

```bash
# W3 fix (round-2 review, Codex adv A-P3) — defensive parse + validation gate
# for worker output aggregation. Agent tool JSON output is best-effort; LLM
# workers may return prose-only response, JSON with missing required fields,
# truncated output (LLM hit max_tokens mid-emission), or no output at all
# (Agent spawn failure / timeout). Without this gate, malformed responses
# silently drop the page from FAILED_WORKERS, skip partial_fail sentinel,
# never retry — exactly the silent-state-divergence Codex adv flagged.
#
# INVARIANT: every page_plan entry MUST produce exactly one outcome (ok or
# failed). The "claimed-files" tracker enforces this.

WORKER_DRAFTS=()    # raw outputs (for diagnostics)
SUCCESS_DRAFTS=()   # validated: worker_status=="ok" + non-empty page_content
FAILED_WORKERS=()   # ANY of: status != "ok", missing fields, unparseable JSON,
                    # empty page_content, no output received (spawn fail/timeout)

# Track which planned files have NOT yet been claimed by a worker output.
UNCLAIMED=()
for pe in "${page_plan[@]}"; do UNCLAIMED+=("${pe.file}"); done

for raw in "${RAW_WORKER_OUTPUTS[@]}"; do
  # Gate 1: strict JSON parse.
  if ! parsed=$(parse_json_strict "$raw" 2>/dev/null); then
    # Cannot identify which file this is for — attribute to first unclaimed.
    if [[ ${#UNCLAIMED[@]} -gt 0 ]]; then
      FAILED_WORKERS+=({file: "${UNCLAIMED[0]}", fail_reason: "worker output not parseable as JSON"})
      UNCLAIMED=("${UNCLAIMED[@]:1}")
    fi
    continue
  fi

  file="${parsed.file}"
  status="${parsed.worker_status}"

  # Gate 2: required fields present.
  if [[ -z "$file" || -z "$status" ]]; then
    if [[ ${#UNCLAIMED[@]} -gt 0 ]]; then
      FAILED_WORKERS+=({file: "${UNCLAIMED[0]}", fail_reason: "worker output missing required field (file or worker_status)"})
      UNCLAIMED=("${UNCLAIMED[@]:1}")
    fi
    continue
  fi

  # Gate 3: file is one of the planned files (defensive — synthesizer
  # hallucination or duplicate output would otherwise corrupt manifest).
  if ! printf '%s\n' "${UNCLAIMED[@]}" | grep -Fxq "$file"; then
    FAILED_WORKERS+=({file: "$file", fail_reason: "worker output for unplanned file (not in page_plan, possibly hallucinated or duplicate)"})
    continue
  fi

  # Gate 3.5: basename safety (post-review fix — fixes round-4 missed: C1
  # path traversal). page_plan files reach Step 7.6.C as the page_path
  # construction key; without basename validation here, Step 7.6.C's
  # `mktemp`/`cp`/`mv` runs against whatever the file string contains
  # (including `../foo`). Step 8b's basename regex is the canonical
  # validator but runs AFTER 7.6.C wrote pages — irreversible. Apply the
  # same `^[a-z0-9][a-z0-9-]*\.md$` regex here, BEFORE the file claims
  # the UNCLAIMED slot or enters SUCCESS_DRAFTS.
  if ! printf '%s' "$file" | grep -qE '^[a-z0-9][a-z0-9-]*\.md$'; then
    FAILED_WORKERS+=({file: "$file", fail_reason: "worker output file is not a valid kebab-case basename (rejected by Step 8b regex; would write outside pages/)"})
    continue
  fi
  # Mark this file claimed.
  UNCLAIMED=("${UNCLAIMED[@]/$file/}")  # markdown pseudocode — implementer uses
                                         # explicit array filter loop or new
                                         # parallel-array shift per Step 7.6
                                         # disclaimer mapping rule.

  # Gate 4: status branch.
  case "$status" in
    ok)
      page_content="${parsed.page_content}"
      frontmatter_meta="${parsed.frontmatter_meta}"
      if [[ -z "$page_content" ]]; then
        FAILED_WORKERS+=({file: "$file", fail_reason: "worker_status=ok but page_content empty (truncated output?)"})
      elif [[ -z "$frontmatter_meta" || "$frontmatter_meta" == "null" ]]; then
        # Post-review fix — fixes round-4 missed: W2 (Codex review P2). Worker
        # contract requires frontmatter_meta with title/tags/aliases/sources_final;
        # without this gate, a truncated/prose-only response with valid
        # page_content but missing frontmatter_meta would be promoted to
        # SUCCESS_DRAFTS and Step 7.6.D's P7 lift would yield null/missing
        # top-level fields, corrupting index.json + sources/<slug>.yaml.
        # JSON null guard added — bash `[[ -z ]]` would treat the 4-char string
        # "null" as non-empty.
        FAILED_WORKERS+=({file: "$file", fail_reason: "worker_status=ok but frontmatter_meta missing or null (truncated output?)"})
      else
        # H1 fix (Codex adversarial post-fix) — verify required frontmatter_meta
        # subfields BEFORE promoting to SUCCESS_DRAFTS. Worker contract requires
        # title (string, non-empty), tags (array), aliases (array), sources_final
        # (array, lex-sorted slugs). Without this gate, a partial frontmatter_meta
        # like `{"title":"X"}` (missing sources_final) would lift null/missing
        # values into manifest, corrupting per-source provenance + index.
        # Implementer note: bash 3.2 cannot introspect JSON natively. Use jq when
        # available (preferred) or python3 fallback; treat any extraction error
        # as missing field. Cross-reference with `pe.frontmatter_meta` from
        # `page_plan` when feasible — if the worker's subfields are missing but
        # page_plan has them, fall back to plan values rather than failing the
        # draft (synthesizer's analysis-mode emit is the canonical source).
        # On any unrecoverable subfield gap → FAILED_WORKERS.
        for required_sub in title tags aliases sources_final; do
          val=$(printf '%s' "$frontmatter_meta" | jq -r ".$required_sub // empty" 2>/dev/null \
                || printf '%s' "$frontmatter_meta" | python3 -c "import json,sys;d=json.load(sys.stdin);v=d.get('$required_sub');print('' if v in (None,[],'') else v)" 2>/dev/null \
                || echo "")
          if [[ -z "$val" ]]; then
            # Try fallback to pe.frontmatter_meta first.
            pe_val=$(printf '%s' "${pe.frontmatter_meta}" | jq -r ".$required_sub // empty" 2>/dev/null || echo "")
            if [[ -n "$pe_val" ]]; then
              # Implementer note: splice the missing subfield from page_plan back
              # into the worker's frontmatter_meta payload before SUCCESS_DRAFTS.
              # Markdown-spec pseudocode — actual implementation uses jq merge.
              continue
            fi
            FAILED_WORKERS+=({file: "$file", fail_reason: "worker_status=ok but frontmatter_meta.$required_sub missing or empty (cannot fall back to page_plan)"})
            ok_validated=false
            break
          fi
        done
        [[ "${ok_validated:-true}" == "true" ]] && SUCCESS_DRAFTS+=("$parsed")
      fi
      ;;
    failed)
      reason="${parsed.fail_reason:-no reason given}"
      FAILED_WORKERS+=({file: "$file", fail_reason: "$reason"})
      ;;
    *)
      FAILED_WORKERS+=({file: "$file", fail_reason: "unknown worker_status: $status"})
      ;;
  esac
done

# Any unclaimed planned files → no output received at all (Agent spawn
# failure, runtime timeout, network drop, etc.). Each becomes a FAILED_WORKERS
# entry so PARTIAL_FAIL toggles correctly per P5 fix.
for f in "${UNCLAIMED[@]}"; do
  [[ -n "$f" ]] && FAILED_WORKERS+=({file: "$f", fail_reason: "no worker output received (Agent spawn failure or runtime timeout)"})
done
```

If `len(SUCCESS_DRAFTS) == 0`, ALL workers failed → see Step 7.7.B (all-fail path).

#### Step 7.6.B-post — §3.9 worker mutation detection (pre-Step-7.6.C)

After Step 7.6.B aggregation + validation completes, verify no `wiki-page-writer` worker mutated the wiki tree during their LLM execution window (gated by `WIKI_TEST_MODE=1`; production skips):

```bash
_post_dispatch_dirty_scan "A5-fanout" || abort_ingest
STAGE_2_END_MS=$(_ts_ms)      # B3 v1.4.2 — A5 fanout Stage 2 end (post worker validation, pre Step 7.6.C lock)
```

**CRITICAL ordering** (cycle-3 N1.2 fix): this scan MUST fire BEFORE Step 7.6.C atomic-write, not after — otherwise main's legitimate Phase 3 writes register as worker-mutation false positives and abort every ingest.

On mismatch: function emits `FATAL: A5-fanout worker mutated wiki_root (pre=..., post=...)` to stderr, sets `PARTIAL_FAIL=true` + `FAILED_REASON="worker_mutation_detected (A5-fanout)"`, and triggers Step 7.7.A worker-mutation failure handling. The ingest aborts; lock is released; `.pending-scan` is NOT promoted.

#### Step 7.6.C — Atomic write under lock (mandatory C3 concurrency check + manifest conversion)

```bash
STAGE_3_START_MS=$(_ts_ms)    # B3 v1.4.2 — phase_timing_ms capture (Stage 3 start = lock acquire attempt)
mkdir "<wiki>/.wiki-meta/.wiki-lock" || { echo "Wiki locked"; exit 1; }
trap 'rmdir "<wiki>/.wiki-meta/.wiki-lock" 2>/dev/null || true' EXIT

PARTIAL_FAIL=false

# P5 fix (round-1 review, Codex adversarial D1) — toggle PARTIAL_FAIL=true when ANY
# worker returned worker_status: "failed" BEFORE the SUCCESS_DRAFTS loop runs.
# Without this, a partial-success run (e.g., 3/5 SUCCESS_DRAFTS, 2 FAILED_WORKERS)
# never triggers Step 7.6.F's sentinel write because the loop only toggles on
# Stage 3 errors. Result: 2 failed pages would silently never retry on next
# session — round-1 A1 bug regression in plan form. Sentinel must include FAILED_WORKERS' file basenames in failed_pages payload alongside FAILED_PAGES (see Step 7.6.F).
if [[ ${#FAILED_WORKERS[@]} -gt 0 ]]; then
  PARTIAL_FAIL=true
fi

# F1.2 fix (v1.4.2 post-impl review — 2/3 reviewer agreement) — preserve
# F1 gate failures across the Step 7.6.C reset. Step 7.5 single-source
# F1 disk-authoritative gate may have populated FAILED_PAGES (basename
# regex reject, file absent on disk, disk read failed) AND set
# PARTIAL_FAIL=true. The reset above clears that signal. Without this
# re-toggle, Step 7.6.F's sentinel WRITE/REMOVAL skips the partial_fail
# write → no <wiki>/.wiki-meta/sources/<slug>.yaml partial_fail field →
# Step 1.5's partial-fail-recovery cascading detection misses → page
# never retries on next session. Mirror the P5 pattern for FAILED_PAGES
# (NOTE: FAILED_PAGES may also be populated mid-loop by C3 / backup /
# write failures — both paths converge on the same sentinel payload).
if [[ ${#FAILED_PAGES[@]} -gt 0 ]]; then
  PARTIAL_FAIL=true
fi

for draft in "${SUCCESS_DRAFTS[@]}"; do
  file="${draft.file}"

  # Defense-in-depth basename guard (post-review fix — fixes round-4
  # missed: C1 path traversal). Step 7.6.B Gate 3.5 should already have
  # caught any non-basename file, but this loop is the canonical
  # filesystem-touching code path and SUCCESS_DRAFTS may also be populated
  # from sub-threshold inline_bodies (Step 7.5.A) or from page_plan
  # synthesizer output that bypassed Step 7.6.B. Re-validate here so
  # Step 8b's regex is never the only safety gate.
  if ! printf '%s' "$file" | grep -qE '^[a-z0-9][a-z0-9-]*\.md$'; then
    FAILED_PAGES+=({file, reason: "page_plan/draft file rejected by basename regex (invalid kebab-case .md or contains path separator)"})
    PARTIAL_FAIL=true
    continue
  fi

  page_path="<wiki>/pages/${file}"
  pe="<corresponding page_plan entry>"

  # C3 — mandatory optimistic concurrency check.
  if [[ "${pe.action}" == "update" ]]; then
    # Update path: re-Read existing body, hash compare against pe.existing_body_hash.
    # R-P1 fix (round-3 review, Codex review P2) — dual fallback for Linux portability.
    current_body=$(cat "$page_path" 2>/dev/null || echo "")
    current_hash=$({ printf '%s' "$current_body" | shasum -a 256 2>/dev/null \
                     || printf '%s' "$current_body" | sha256sum 2>/dev/null; } \
                   | awk '{print $1}')
    if [[ "$current_hash" != "${pe.existing_body_hash}" ]]; then
      FAILED_PAGES+=({file, reason: "concurrent ingest detected at Stage 3 — page bytes drifted since Stage 1 read"})
      PARTIAL_FAIL=true
      continue
    fi
  else  # action == "create"
    # Create path: existence check.
    if [[ -f "$page_path" ]]; then
      FAILED_PAGES+=({file, reason: "concurrent ingest claimed same filename at Stage 3"})
      PARTIAL_FAIL=true
      continue
    fi
  fi

  # Backup (Rule 7) for update only.
  if [[ "${pe.action}" == "update" ]]; then
    versioned_path=$(compute_next_version_path "$file")
    cp "$page_path" "$versioned_path" || {
      FAILED_PAGES+=({file, reason: "backup failed"})
      PARTIAL_FAIL=true
      continue
    }
    VERSIONED+=("$versioned_path")
  fi

  # Atomic write (write to tmp, rename).
  tmp=$(mktemp "${page_path}.XXXXXX")
  printf '%s' "${draft.page_content}" > "$tmp" || {
    rm -f "$tmp"
    FAILED_PAGES+=({file, reason: "tmp write failed"})
    # A6 — abort remaining drafts in the loop (matches v1.3.0 Phase 3 mid-loop fail).
    for remaining in "${remaining drafts after this one}"; do
      FAILED_PAGES+=({file: remaining.file, reason: "skipped due to mid-loop abort after $file write failure"})
    done
    PARTIAL_FAIL=true
    break  # halt loop
  }
  mv "$tmp" "$page_path" || {
    rm -f "$tmp"
    FAILED_PAGES+=({file, reason: "rename to final path failed"})
    # R4-R4-2 fix (round-4 review, Codex review P2) — symmetric with tmp-write
    # fail path above. Without this, A6 promise ("Step 7.7.C: remaining drafts
    # captured in FAILED_PAGES") is broken on rename failure: `break` halts
    # loop without recording the remaining drafts → audit + retry payload
    # under-reports the pages skipped by the abort.
    for remaining in "${remaining drafts after this one}"; do
      FAILED_PAGES+=({file: remaining.file, reason: "skipped due to mid-loop abort after $file rename failure"})
    done
    PARTIAL_FAIL=true
    break  # same A6 abort
  }
  WRITTEN+=({file, action: pe.action, frontmatter_meta: draft.frontmatter_meta})
done
```

#### Step 7.6.D — Manifest conversion (to v1.3.0 Step 8 input shape)

Build the manifest for Step 8a-8h consumption:

```bash
manifest = {
  created: [],      # entries from WRITTEN where pe.action == "create" AND PRE_BATCH_PAGES does not contain file
  updated: [],      # entries from WRITTEN where pe.action == "update"
  versioned: VERSIONED,
  source_hashes: <from analysis output>,
  failed: FAILED_PAGES + FAILED_WORKERS  # union with reason strings
}

# P7 fix (round-1 review, Codex review D5/P1) — Step 8a-8h (v1.3.0 unchanged) reads
# top-level `title`, `tags`, `aliases`, `sources` from each entry in `created`/`updated`.
# Worker output carries these fields nested under `frontmatter_meta`. Without explicit
# lifting, Step 8 sees them as `null`/missing → broken per-source provenance + index.
for entry in manifest.created + manifest.updated:
  entry.title    = entry.frontmatter_meta.title
  entry.tags     = entry.frontmatter_meta.tags
  entry.aliases  = entry.frontmatter_meta.aliases
  entry.sources  = entry.frontmatter_meta.sources_final  # already lex-sorted by Stage 1
  # frontmatter_meta itself stays for diagnostics; consumers read top-level only.
```

For entries in `created` and `updated`, also embed `page_content` (per round-2 C4 fix — main needs to ensure Stage 8 emit includes the body that was written; while Step 8 metadata path reads only frontmatter_meta fields, downstream consumers may need page_content for diagnostics).

#### Step 7.6.E — Run v1.3.0 Steps 8-13 unchanged (R4-Q1 corrected — page-write/metadata split is structural, not sub-step skip)

> **R4-Q1 fix (round-4 review, Opus Q1) — REPLACES the round-3 Adv-A2 fictional
> sub-step taxonomy:**
> Round-3's Adv-A2 fix introduced a "Step 8 sub-step taxonomy" table asserting
> Step 8a=version snapshot, 8b=page write, 8c=sources/*.yaml, 8d=log.jsonl,
> 8e=index.json, 8f=log.md, 8g=index.md, 8h=retention prune. **Round 4 verified
> this taxonomy is fictional** — `commands/wiki-ingest.md` Step 8 actually has
> sub-steps 8a-8e covering reconciliation, validation, classification, source_hashes
> normalization, and per-source provenance. log.jsonl/index.json/human-artifacts/
> retention are SEPARATE top-level steps (Step 9 / Step 10 / Step 11 / Step 13).
>
> **The actual page-write-vs-metadata split is structural, not a Step 8 internal
> skip.** In v1.3.0:
> - Synthesizer agent's **Phase 2 (backup)** + **Phase 3 (page write)** own the
>   page-write side effects.
> - `commands/wiki-ingest.md` Steps 8-13 are PURELY metadata pipelines (run AFTER
>   the agent has already written pages).
>
> A5 path mirrors this exactly:
> - **Step 7.6.C** owns backup + page write (under lock — equivalent to v1.3.0
>   synthesizer Phase 2 + Phase 3).
> - **Steps 8-13** run UNCHANGED — no sub-step skipping needed because Steps 8+
>   never write pages in any code path.
>
> The round-3 Adv-A2 concern ("double version snapshot") was based on misreading
> `commands/wiki-ingest.md:625-628` — that paragraph is a v1.3.0 A4 multi-source
> narrative summary describing what happens AFTER Phase 3 ends (i.e., Steps 8
> through 13 in narrative form), NOT a sub-step listing of Step 8. v1.3.0 already
> structures Steps 8+ as metadata-only by virtue of the synthesizer-vs-command
> split — A5 inherits this property automatically.

After Step 7.6.D's manifest conversion, run `commands/wiki-ingest.md` Steps 8 through 11 UNDER THE LOCK acquired in Step 7.6.C:

- **Step 8** (reconcile + classify + sources/*.yaml). Specifically:
  - **8a** (Reconcile against disk) — `test -f` check that 7.6.C's writes landed.
    A5 path STILL needs this defensive check (verifies the agent-claimed `created`/`updated`
    entries are actually on disk after 7.6.C).
  - **8b** (Validate filenames) — regex check `^[a-z0-9][a-z0-9-]*\.md$`.
    A5 path's basename guards in Step 7.6.B (Gate 3.5) and Step 7.6.C (defense-in-depth)
    SHOULD have caught violations before any write; Step 8b is the canonical post-write
    audit and should treat any rejection as a state-divergence error (escalate to
    Step 7.7.F metadata pipeline failure recovery).
  - **8c** (Classify authoritatively) — split into CREATED_ENTRIES vs UPDATED_ENTRIES
    using PRE_BATCH_PAGES.
  - **8d** (Normalize source_hashes) — recompute sha256 for "main-computes" sentinel slugs.
  - **8e** (Write per-source provenance to `sources/<slug>.yaml`).
- **Step 9** (Update Index — `index.json`). Only WRITTEN entries; `frontmatter_meta.title/tags/aliases/sources`
  already lifted to top-level entry fields by Step 7.6.D P7 fix.
- **Step 10** (Append to Log — `log.jsonl`). **R-P2 fix (round-3 review, Codex review P2)**:
  include `pages_failed` field when FAILED_PAGES OR FAILED_WORKERS is non-empty
  (NOT just FAILED_PAGES — partial-fanout where Stage 2 has worker failures AND
  Stage 3 succeeds cleanly otherwise must still record retry-required pages).
  Payload value = union of `FAILED_PAGE_FILES` + `FAILED_WORKER_FILES`, matching
  the Step 7.6.F sentinel payload.
  **B3 fix (v1.4.2 — handoff §1.B3)**: capture `LOG_EMIT_MS=$(_ts_ms)` immediately
  before the log line is appended; embed `phase_timing_ms` JSON object built from
  the captured stage timestamps (see "Step 7 — Shared utility: phase timing
  telemetry" above for capture-point list and per-path coverage). Schema-additive —
  `wiki-lint` Step 6 LOG-INVARIANT scan ignores unknown top-level fields; existing
  consumers of `pages_created` / `pages_updated` are unaffected. Phase timing absent
  on `ingest-skip`, `ingest-repair`, `ingest-fail`, `lint`, `rebuild`, `delete`,
  `query-filed`, `setup` lifecycle actions (only `ingest` carries it).
- **Step 11** (Update Human-Readable Wiki Artifacts — `log.md` + `index.md`).

> **Post-review fix — fixes round-4 missed: C2 (lock ordering / partial_fail
> race):** Step 12 (Release Lock) and Step 13 (Auto-Lint) DEFERRED to Step
> 7.6.G. Reason: the partial_fail sentinel WRITE/REMOVAL in Step 7.6.F is the
> retry-correctness signal for the same yaml file Step 8e mutates — it MUST
> run inside the same lock transaction. The original "Steps 8-13 unchanged"
> wording inadvertently included Step 12, putting Step 7.6.F outside the
> lock and exposing a window where a concurrent ingest can observe stale
> yaml between Step 12 release and Step 7.6.F's rewrite. v1.3.0 multi-source
> A4 path's Step 7.5.M-C (atomic write) acquires the lock and runs Steps
> 8-13 inline because v1.3.0 has no partial_fail sentinel; A5 introduces
> the sentinel and therefore needs Step 12 to fire AFTER Step 7.6.F, not
> before. Step 13 (auto-lint) is read-mostly and idempotent — safe to run
> post-lock.

No sub-step skipping required. Steps 8-11 run end-to-end under the lock; Step 12
+ Step 13 fire from Step 7.6.G AFTER Step 7.6.F's sentinel rewrite is durable.

#### Step 7.6.F — partial_fail sentinel WRITE or REMOVAL-on-success (A1 + C5 + P4)

**Two sub-cases depending on `PARTIAL_FAIL` state and existing yaml content:**

- **Case (i) PARTIAL_FAIL = true** — write/update partial_fail sentinel block.
- **Case (ii) PARTIAL_FAIL = false AND yaml has partial_fail field** — atomic-remove the
  partial_fail field. **P4 fix (round-1 review, Opus C2 single-reviewer but verified
  against spec §7.4 "Repair-on-success cleanup")** — without this, every source that
  ever had a transient failure enters a permanent re-ingest loop because Step 1.5 keeps
  forcing REPAIR via the partial-fail-recovery cascading check (Phase 3 Task 3.1).
- **Case (iii) PARTIAL_FAIL = false AND yaml has no partial_fail field** — no-op
  (the typical clean ingest case).

```bash
yaml="<wiki>/.wiki-meta/sources/<slug>.yaml"
yaml_has_partial=false
if grep -q '^partial_fail:' "$yaml" 2>/dev/null; then
  yaml_has_partial=true
fi

# C1 fix (round-2 review, 2/3 agreement — Opus Q1 + Codex review R-P1) — explicit
# if/elif/else structure replaces the ambiguous `return 0` hedge. The previous form
# relied on `return 0` at script-top-level to skip Case (i), which fails silently
# (bash error "return: can only `return' from a function") and falls through to
# Case (i) — re-running the awk+printf chain with PARTIAL_FAIL=false on an
# already-stripped yaml, producing an empty `partial_fail: failed_pages: [""]` block.
# This corruption fired on every successful repair-on-success cycle, retriggering
# partial-fail-recovery cascade indefinitely (the very loop P4 was meant to break).
#
# Three exhaustive cases:
# (ii) PARTIAL_FAIL=false AND yaml_has_partial=true  → strip partial_fail (repair success)
# (i)  PARTIAL_FAIL=true                              → write/update partial_fail sentinel
# (iii) PARTIAL_FAIL=false AND yaml_has_partial=false → no-op (clean ingest, falls past)

if [ "$PARTIAL_FAIL" = "false" ] && [ "$yaml_has_partial" = "true" ]; then
  # Case (ii) — repair-on-success cleanup (P4 fix). Strip partial_fail block entirely.
  tmp=$(mktemp "${yaml}.XXXXXX")
  # State-machine awk: strip partial_fail header (in ANY form) + indented children, do NOT append.
  #
  # R-P3 fix (round-3 review, Codex review P2) — pattern broadened from
  # `/^partial_fail:[[:space:]]*$/` (header-only form: `partial_fail:`) to
  # `/^partial_fail:.*$/` (any line starting with `partial_fail:`). Step 1.5's
  # detect uses `grep -q '^partial_fail:'` which matches BOTH:
  #   (a) header form:   `partial_fail:` followed by indented children
  #   (b) inline form:   `partial_fail: {ts: bad}` (single-line malformed)
  # Original strip pattern only matched (a), so (b) would be detected → forces
  # REPAIR → Stage 3 succeeds → strip awk skips no lines → yaml unchanged →
  # next session detects again → PERMANENT retry loop.
  #
  # Broadened pattern correctly handles both cases:
  # - Header form: skip=1 → indented children dropped → next non-indent clears skip
  # - Inline form: skip=1 (line dropped) → next non-indent line clears skip
  #   (no indented continuation expected for inline form)
  awk '
    /^partial_fail:.*$/             { skip=1; next }
    skip && /^[[:space:]]/           { next }
    skip && /^[^[:space:]]/          { skip=0 }
    { print }
  ' "$yaml" > "$tmp"
  sync
  if ! mv "$tmp" "$yaml"; then
    rm -f "$tmp"
    echo "ERROR: partial_fail removal failed; source stuck in re-ingest loop"
    exit 1
  fi

elif [ "$PARTIAL_FAIL" = "true" ]; then
  # Case (i) — partial_fail sentinel WRITE (gate explicit per C1 fix).
  # Read existing yaml content.
  existing=$(cat "$yaml")

  # Construct partial_fail block.
  # P5 fix — failed_pages payload includes BOTH FAILED_PAGES (Stage 3 errors) AND
  # FAILED_WORKERS file basenames (Stage 2 errors), since PARTIAL_FAIL is now toggled
  # from both sources (see Step 7.6.B addition above).
  #
  # W1 fix (round-2 review, Opus Q3) — explicit loop replaces ambiguous printf
  # payload with field-strip pseudocode. The previous form
  #   printf '"%s",' "${FAILED_PAGES[@]/.}" "${FAILED_WORKERS[@]/.file}" | sed 's/,$//'
  # had two bugs: (a) `${FAILED_PAGES[@]/.}` (no field name after the dot) deletes
  # the FIRST literal `.` from each element at runtime, corrupting filenames
  # (page1.md → page1md). The disclaimer at Step 7.6 documents `${arr[@]/.field}`
  # but does NOT cover the bare `/.` form. (b) Empty-array case yields
  # `failed_pages: [""]` instead of `failed_pages: []`, breaking next-session retry
  # parsing. The explicit loop below produces a valid empty `[]` for empty input
  # and uses pre-extracted basename arrays per the pseudocode disclaimer's
  # parallel-array mapping rule.
  failed_pages_json="["
  __sep=""
  for __f in "${FAILED_PAGE_FILES[@]}" "${FAILED_WORKER_FILES[@]}"; do
    failed_pages_json="${failed_pages_json}${__sep}\"${__f}\""; __sep=","
  done
  failed_pages_json="${failed_pages_json}]"

  partial_fail_block=$(cat <<EOF
partial_fail:
  ts: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
  failed_pages: ${failed_pages_json}
  reason: "$(determine_reason)"  # "stage 2 worker fail" | "stage 3 write fail" | "concurrency abort" | "all workers failed" | "all f1 dropped" (R3.W-2 v1.4.2 — F1 gate dropped all update entries; emitted by do_all_failed_under_lock at Step 7.5.B)
EOF
)

  # Atomic rewrite: write to tmp, fsync, rename.
  tmp=$(mktemp "${yaml}.XXXXXX")
  {
    # P1 fix (round-1 review, 3-way unanimous) — state-machine awk replaces broken
    # range-pattern variant. The previous form `awk '/^partial_fail:/,/^[a-z_]+:/...'`
    # had two bugs: (1) `partial_fail:` itself matches `^[a-z_]+:`, range terminates
    # immediately; (2) indented children (`  ts:`, `  failed_pages:`, `  reason:`)
    # don't match `^[a-z_]+:`, fall through to output unchanged. Result: orphan child
    # lines + new partial_fail block appended → malformed yaml after every cycle.
    #
    # The state-machine variant below tracks `skip` flag explicitly:
    # - line entering `partial_fail:` sets skip=1, continues (drop the header).
    # - while skip=1 AND line begins with whitespace (indented child): drop it.
    # - while skip=1 AND line begins non-whitespace (next top-level key): clear skip,
    #   then PRINT this line (it's a sibling key like `pages_updated:`).
    # - default: print.
    # Verified bash 3.2 + macOS BSD awk compatible (no GNU extensions).
    #
    # If existing yaml already has partial_fail, strip the old block then append fresh.
    # Otherwise, pass through.
    if grep -q '^partial_fail:' "$yaml"; then
      # R-P3 fix: same broadened pattern as Case (ii) — match ANY partial_fail:
      # line including malformed inline forms like `partial_fail: {ts: bad}`.
      awk '
        /^partial_fail:.*$/             { skip=1; next }
        skip && /^[[:space:]]/           { next }
        skip && /^[^[:space:]]/          { skip=0 }
        { print }
      ' "$yaml"
    else
      cat "$yaml"
    fi
    echo "$partial_fail_block"
  } > "$tmp"
  sync  # fsync hint (best-effort)
  if ! mv "$tmp" "$yaml"; then
    rm -f "$tmp"
    echo "ERROR: partial_fail sentinel write failed; wiki state at risk"
    exit 1
  fi
fi  # End if/elif (Case ii / Case i). Case (iii) PARTIAL_FAIL=false AND no yaml partial_fail → falls past (no-op clean ingest).
```

#### Step 7.6.G — Release lock + post-lock auto-lint + report

> **Post-review fix — fixes round-4 missed: C2 (lock ordering):** Step 12
> (Release Lock) + Step 13 (Auto-Lint) deferred from Step 7.6.E land here,
> AFTER Step 7.6.F's partial_fail sentinel WRITE/REMOVAL has flushed.
> This guarantees the sentinel update is part of the same lock-protected
> transaction that wrote pages and updated yaml/log/index, closing the
> race window where a concurrent ingest could observe stale state
> between an early Step 12 release and Step 7.6.F's rewrite.

```bash
# Step 12 (Release Lock) — runs AFTER Step 7.6.F's sentinel write.
rmdir "<wiki>/.wiki-meta/.wiki-lock"
trap - EXIT

# Step 13 (Auto-Lint, includes retention prune `last-3 .versions per page`)
# — runs POST-LOCK. Read-mostly + idempotent; safe outside the transaction.
# Retention prune retains the newest .versions/v<N+1>.md created by 7.6.C
# and prunes from the oldest end — no risk of pruning the just-created
# backup.
run_step_13_auto_lint
```

Surface result to user (Step 14 final report unchanged from v1.3.0).

### Step 7.7 — A5 failure handling

#### Step 7.7.A — Per-worker failure (one or more, but not all)

Documented in Step 7.6.B (workers with `worker_status: "failed"` go to `FAILED_WORKERS`). Step 7.6.C iterates only over SUCCESS_DRAFTS — failed-worker entries are added to manifest's `failed[]` and contribute to PARTIAL_FAIL flag.

#### Step 7.7.B — All-workers fail (zero successes from page-writers)

```bash
if [[ ${#SUCCESS_DRAFTS[@]} -eq 0 ]]; then
  # No Stage 3 page write. But still need to write log + retry counter under lock.
  mkdir "<wiki>/.wiki-meta/.wiki-lock" || { echo "Wiki locked"; exit 1; }
  trap 'rmdir "<wiki>/.wiki-meta/.wiki-lock" 2>/dev/null || true' EXIT

  # R4-Adv-Adv-2 fix (round-4 review, Codex adv finding):
  # All-workers-fail can leave a FIRST-time source's yaml in a corrupt state.
  # Step 7.6.F's sentinel writer assumes sources/<slug>.yaml ALREADY EXISTS
  # (cat | awk transform + append partial_fail). For first-ingest all-fail case,
  # the yaml file doesn't exist yet → write fails OR creates a sentinel-only
  # yaml missing required fields (id/type/origin/content_hash/pages_*).
  # Fix: ensure baseline yaml exists before sentinel write.
  yaml="<wiki>/.wiki-meta/sources/<slug>.yaml"
  if [ ! -f "$yaml" ]; then
    # Materialize a baseline yaml using Step 8e's schema with empty page arrays
    # and a normalized content_hash (file/deep-work-report → shasum dual fallback;
    # url/text → "main-computes" sentinel which Step 1.5 rejects, forcing
    # safe re-ingest on next attempt).
    case "<source.type>" in
      file|deep-work-report)
        baseline_hash=$({ shasum -a 256 "<source.origin>" 2>/dev/null \
                          || sha256sum "<source.origin>" 2>/dev/null; } | awk '{print $1}')
        ;;
      url|text)
        baseline_hash="main-computes"  # Sentinel — Step 1.5 sed regex rejects, forces re-ingest.
        ;;
    esac
    write_or_update_yaml slug=<slug> origin=<source.origin> type=<source.type> \
                        content_hash="$baseline_hash" \
                        ingested_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
                        pages_created=[] pages_updated=[]
  fi

  # 1. Append pages_failed log line.
  emit_log_line action=ingest pages_created=[] pages_updated=[] \
                pages_failed="${FAILED_WORKER_FILES[@]}"  # parallel-array form per disclaimer

  # 2. Write partial_fail sentinel to sources/<slug>.yaml (Step 7.6.F path Case (i)).
  write_partial_fail_sentinel reason="all workers failed"

  # 3. Increment retry counter (.pending-scan-retry-count).
  increment_retry_counter

  # 4. If counter == 3:
  if [[ retry_counter == 3 ]]; then
    emit_log_line action=ingest-fail
    promote_pending_scan_to_last_scan  # break stuck-window loop
    reset_retry_counter
  fi
  # else: .pending-scan NOT promoted (next session retries the source).

  rmdir "<wiki>/.wiki-meta/.wiki-lock"
  trap - EXIT
  exit 1
fi
```

**A7 — lock acquisition before any log/meta write is mandatory.** Even though no page is written, log.jsonl + sources yaml + retry counter are all concurrency-sensitive.

#### Step 7.7.C — Stage 3 mid-loop write failure

Documented in Step 7.6.C — `break` halts the loop on first write failure. A6 — remaining drafts after the failing one go to FAILED_PAGES with reason `"skipped due to mid-loop abort after <file> write failure"`. Pages already written stay (atomic per page).

#### Step 7.7.D — Stage 3 concurrency check abort (C3)

Per Step 7.6.C: hash mismatch (update) or file-exists (create) under lock → page added to FAILED_PAGES, loop CONTINUES (concurrency abort doesn't halt other pages — that's why this is `continue`, not `break`). Other pages may still write.

PARTIAL_FAIL flag is set, so Step 7.6.F sentinel write fires.

#### Step 7.7.E — Worker timeout

Each worker has timeout `a5_worker_timeout_sec` (default 90s). Timeout = `worker_status: "failed"` with `fail_reason: "timeout"`. Treated identically to per-worker failure (Step 7.7.A).

#### Step 7.7.F — Metadata pipeline failure after Step 7.6.C wrote pages (R4-Adv-Adv-1 fix)

**R4-Adv-Adv-1 fix (round-4 review, Codex adv critical):** the round-3 plan
covers Step 2 (worker fail) + Stage 3 page write fail (mid-loop break) + C3
concurrency abort, but does NOT define recovery for FAILURES IN STEPS 8-13 AFTER
PAGES WERE COMMITTED. If 7.6.C wrote N pages successfully, then Step 9 (index.json)
or Step 10 (log.jsonl append) fails (disk full, permission, sigkill mid-write),
the plan would silently exit with: pages mutated on disk + no provenance/log/index
update + no `partial_fail` sentinel + no retry record. Result: wiki state divergence
that no automated recovery path detects.

**Recovery contract:** any error from Step 8a (reconcile) through Step 11 (human
artifacts) AFTER 7.6.C wrote pages MUST trigger:

```bash
# Pseudocode — implementer maps to error trap or per-step rc check
on_metadata_failure() {
  # 1. Mark all WRITTEN entries as FAILED for retry purposes.
  for entry in WRITTEN; do
    FAILED_PAGES+=({file: entry.file, reason: "metadata pipeline failure after page write — yaml/log/index out of sync"})
    FAILED_PAGE_FILES+=("${entry.file}")
  done
  PARTIAL_FAIL=true

  # 2. Write partial_fail sentinel via Step 7.6.F Case (i) path.
  # Same lock semantics: lock is still held from 7.6.C; do not release.
  write_partial_fail_sentinel reason="metadata pipeline failure"

  # 3. Append minimal log line (defensive — Step 10 itself may have failed,
  # so retry log emission with shorter payload to maximize chance of landing).
  if ! emit_log_line action=ingest pages_created="${WRITTEN_CREATE_FILES[@]}" \
                     pages_updated="${WRITTEN_UPDATE_FILES[@]}" \
                     pages_failed="${FAILED_PAGE_FILES[@]}"; then
    # Even minimal log line failed. Last-resort: write a marker file so
    # next-session R3W2 detection can flag wiki state drift.
    echo "metadata pipeline failure at $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >> "<wiki>/.wiki-meta/.metadata-failure-marker"
  fi

  # 4. Do NOT promote .pending-scan (next session retries).
  # 5. Release lock.
  rmdir "<wiki>/.wiki-meta/.wiki-lock"
  exit 1
}
```

**Rationale:** the alternative — rolling back all WRITTEN pages from `.versions/`
backups — is more correct but invasive (requires N file copies under lock,
extending lock duration unpredictably; if rollback itself partially fails, state
is even worse). The chosen contract (mark all as failed + write sentinel + best-effort
log + next-session retry) trades "perfect rollback" for "predictable recovery
signal". Step 1.5's `partial_fail` cascading + R3W2 wiki state drift detection
will force a clean re-ingest on next session, which restores consistency.

Phase 6 sandbox test (W2 fault-injection deferred to v1.4.1 per round-1 W2 fix):
when fault-injection lands, add Test 14 — "metadata pipeline failure after
page writes": inject `WIKI_TEST_METADATA_FAIL_AT=Step9` env var; verify
partial_fail sentinel written + pages_failed log + .pending-scan NOT promoted.

### Step 7.8 — `page_plan == 0` terminal handling (A8)

When Stage 1 returns empty `page_plan` (analysis judged the source brings no new info worthy of a page write), main treats this as `ingest-skip` lifecycle event — same shape as v1.3.0 multi-source Case A (all skip):

**P2 fix (round-1 review, Codex review P2 + Codex adv D3, 2/3 agreement):** Step 7.8
must NOT recompute hash via `shasum -a 256 < "<source.origin>"`. For URL and text
sources, `<source.origin>` is a URL string or pasted-text marker, NOT a readable
file path — `shasum < <url>` either fails or records empty/garbage hash. Use the
analysis output's `source_hashes[<slug>]` (already computed by Stage 1, valid for
all source types). For file/deep-work-report sources, fall back to local shasum
ONLY when synthesizer emitted the sentinel "main-computes" (per P6 fix below).

```bash
# Caller passes source descriptor + the analysis output's source_hashes map.
# Markdown-spec pseudocode; implementer maps to actual bash arrays per Step 7.6
# disclaimer (see Task 4.2).
do_ingest_skip_terminal_under_lock() {
  # Args: $1=source descriptor (slug, origin, type fields), $2=source_hashes map
  mkdir "<wiki>/.wiki-meta/.wiki-lock" || { echo "Wiki locked"; exit 1; }
  trap 'rmdir "<wiki>/.wiki-meta/.wiki-lock" 2>/dev/null || true' EXIT

  # 1. Determine content_hash for sources/<slug>.yaml.
  # P2 fix (round-1) — use Stage 1 source_hashes when available.
  # C2 fix (round-2 review, 2/3 agreement — Codex review R-P2 + Codex adv A-P1):
  # the previous round-1 form treated url|text + sentinel "main-computes" as a
  # fatal contract violation. But the analysis contract explicitly ALLOWS the
  # sentinel (synthesizer has no shasum tool), so every duplicate URL/text
  # ingest with no new info (page_plan==0) was hitting fatal exit, never writing
  # the ingest-skip log line, never promoting .pending-scan. Result: user-visible
  # repeated failure on re-ingest of unchanged URL/text sources.
  #
  # New behavior — graceful degradation by source type:
  #   - file/deep-work-report: re-shasum locally (synthesizer's sentinel signals
  #     "main, please compute").
  #   - url/text: reuse Step 8d's existing normalization helper (curl-fetch +
  #     shasum for url; text-inbox + shasum for text), already implemented in
  #     v1.3.0. If normalization fails (network down for url, etc.), keep the
  #     sentinel — Step 1.5's sed regex matches only 64-char hex, so sentinel
  #     naturally falls through to safe re-ingest on next attempt (no data loss,
  #     just one extra ingest cycle).
  current_hash="${source_hashes[<slug>]:-main-computes}"
  if [ "$current_hash" = "main-computes" ] || [ -z "$current_hash" ]; then
    case "<source.type>" in
      file|deep-work-report)
        # Local file — safe to re-shasum.
        # R4-R4-3 fix (round-4 review, Codex review P2) — dual fallback for Linux.
        # Without sha256sum fallback: empty hash on Linux without `shasum`,
        # which gets written to sources/<slug>.yaml; Step 1.5 sed regex
        # `^[0-9a-f]{64}$` rejects empty → re-ingest forced indefinitely.
        # Mirror Step 1.5 L193 + Step 7.5/7.6.C R-P1 fix pattern.
        current_hash=$({ shasum -a 256 "<source.origin>" 2>/dev/null \
                         || sha256sum "<source.origin>" 2>/dev/null; } | awk '{print $1}')
        ;;
      url|text)
        # C2 fix — reuse Step 8d normalization (single source of truth for
        # url/text hashing). Implementer note: `step_8d_normalize_url_or_text_hash`
        # is markdown-spec shorthand — read commands/wiki-ingest.md Step 8d
        # block (curl/text-inbox + shasum logic) and inline the equivalent here.
        current_hash=$(step_8d_normalize_url_or_text_hash "<source.origin>" "<source.type>" 2>/dev/null)
        # If normalization fails (e.g., network down for url) keep sentinel.
        # Step 1.5 sed regex `^content_hash:.*([0-9a-f]{64})` rejects sentinel
        # values, naturally forcing re-ingest on next attempt — safe fallback.
        if [ -z "$current_hash" ]; then
          current_hash="main-computes"
          echo "WARNING: Step 8d normalization unavailable for $type:$origin; recording sentinel — next ingest will retry." >&2
        fi
        ;;
    esac
  fi
  # Post-review fix — fixes round-4 missed: H2 (Codex adversarial post-fix).
  # First-time source with empty page_plan must materialize the FULL Step 8e
  # yaml schema, not just slug/content_hash/ingested_at. Missing type/origin
  # weakens slug-collision detection (allocator can't distinguish two sources
  # with the same natural slug) and breaks downstream consumers expecting
  # the canonical yaml shape. Mirror the Step 7.7.B baseline-yaml logic
  # (R4-Adv-Adv-2) for consistency — same write_or_update_yaml field set.
  write_or_update_yaml slug=<slug> origin=<source.origin> type=<source.type> \
                      content_hash=$current_hash \
                      ingested_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
                      pages_created=[] pages_updated=[]

  # 2. Append ingest-skip log line.
  emit_log_line action=ingest-skip source=<slug> pages_created=[] pages_updated=[]

  # 3. Promote .pending-scan → .last-scan (terminal event, source is fully accounted for).
  promote_pending_scan_to_last_scan

  rmdir "<wiki>/.wiki-meta/.wiki-lock"
  trap - EXIT
}
```

Without this terminal flow, the SessionStart hook would re-detect the source's file every session (its mtime is in pending-scan window but no terminal log exists for it).

#### Backwards compatibility note

For 1-source `/wiki-ingest`, v1.4.0 changes the dispatch from `mode: "inline"`
to `mode: "analysis"` (Step 7.5 decision branch 2) so cross-page synthesis
is exposed before page bodies are written. Behavior is **semantically
preserved** from v1.3.0 (same pages produced, same provenance, same log
events) but **not byte-identical** — analysis-mode invocation introduces a
~10-25% wall-clock variance and the page_plan/inline_bodies/A5-fanout sub-
branches replace inline-mode's single-stage synthesis. v1.2.1's byte-
identical 1-source guarantee no longer holds.

For multi-source batches in v1.2.1, v1.3.0 produces identical final wiki
state when no cross-worker page collision occurs (the common case): same
pages, same log events, same provenance YAMLs. Only wall-clock differs
(parallel analysis phase). When cross-worker collision DOES occur
(uncommon — most multi-source batches surface independent topics), v1.3.0's
second-pass synthesis (Step 7.5.M-B Case B2) preserves v1.2.1's
single-synthesizer multi-source merge invariant — content from all
contributing sources flows into one merged page, no facts dropped. v1.4.0
multi-source path is unchanged from v1.3.0.

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
#
# B5 review fix (v1.2.1+): snapshot CREATED_ENTRIES and UPDATED_ENTRIES before
# applying dedup. Per-source yaml writes (Step 8e) consult the snapshot — every
# slug records the page under pages_created if the slug actually contributed to
# its creation, even when the log-emission path will dedup it down. Step 10's
# log lines still use the deduped CREATED_ENTRIES / UPDATED_ENTRIES, preserving
# the "each filename appears in pages_created at most once across log lines"
# invariant.
#
# CR-B fix (v1.2.1+): use length-guarded array literal init — bash 3.2.57's
# `B=("${A[@]:-}")` produces a 1-element-empty-string array when A is empty,
# NOT an empty array. Verified live:
#   $ /bin/bash -c 'set -u; A=(); B=("${A[@]:-}"); echo "len=${#B[@]}"'
#   len=1
# Same fix pattern is already used in `scan-vault-changes.sh` (lines 303, 310)
# for the auto_ingest globs / require_tag arrays.

ORIGINAL_CREATED_ENTRIES=()
[ ${#CREATED_ENTRIES[@]} -gt 0 ] && ORIGINAL_CREATED_ENTRIES=("${CREATED_ENTRIES[@]}")
ORIGINAL_UPDATED_ENTRIES=()
[ ${#UPDATED_ENTRIES[@]} -gt 0 ] && ORIGINAL_UPDATED_ENTRIES=("${UPDATED_ENTRIES[@]}")

SEEN_CREATED=""    # newline-delimited "이미 created로 분류된 파일명" 집합
NEW_CREATED=()
EXTRA_UPDATED=()
if [ ${#CREATED_ENTRIES[@]} -gt 0 ]; then
  for entry in "${CREATED_ENTRIES[@]}"; do
    file="$(jq -r '.file' <<<"$entry")"
    if printf '%s\n' "$SEEN_CREATED" | grep -Fxq "$file"; then
      EXTRA_UPDATED+=("$entry")
    else
      SEEN_CREATED="$SEEN_CREATED"$'\n'"$file"
      NEW_CREATED+=("$entry")
    fi
  done
fi

# Re-assign post-dedup arrays — same length-guarded pattern (CR-B).
CREATED_ENTRIES=()
[ ${#NEW_CREATED[@]} -gt 0 ] && CREATED_ENTRIES=("${NEW_CREATED[@]}")
[ ${#EXTRA_UPDATED[@]} -gt 0 ] && UPDATED_ENTRIES+=("${EXTRA_UPDATED[@]}")
```

The classification change emits a one-line note in the Step 14 report ("N entries reclassified from created to updated due to same-batch dedup at log-emission level — per-source yamls preserve full attribution"). **Per-source provenance (B5 review fix, v1.2.1+):** Step 8e per-source yamls are written from `ORIGINAL_CREATED_ENTRIES` / `ORIGINAL_UPDATED_ENTRIES` (pre-dedup), so a co-created page X is recorded in *both* contributing slugs' yamls under `pages_created`. Step 10 log emission uses the post-dedup `CREATED_ENTRIES` / `UPDATED_ENTRIES`, so only the first contributing slug's log line carries X under `pages_created` — the log invariant continues to hold.

**Note on bash 3.2 portability (CR-B v1.2.1+):** the prior `("${ARR[@]:-}")` snapshot pattern is **broken** for empty arrays in bash 3.2.57. The Self-Review checklist that initially claimed it as "set-u-safe array deref" conflated *iteration* (where `${ARR[@]:-}` is correctly empty) with *array literal initialization* (where the `:-}` substitutes a single empty string). All four sites in this task use the length-guarded `[ ${#ARR[@]} -gt 0 ] && ...` pattern instead.

**d. Normalize `source_hashes`.** The agent returns `source_hashes` with one entry per source slug (the caller rejected the manifest in Step 7 / Error Handling if any passed-in slug was missing). The *values*, however, may not all be valid sha256 digests: all three split agents (`deep-wiki:wiki-synthesizer-{analysis|worker|inline}`) have no shell/hashing capability — their tool scopes (`Read, [Write,] Glob, Grep, WebFetch` — Write only on dormant inline) exclude any hashing tool, so they return a sentinel placeholder value for each slug. The caller is responsible for normalizing these to real digests before Step 8e.

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
  - <files in ORIGINAL_CREATED_ENTRIES whose entry.sources contains this slug — pre-dedup; B5 v1.2.1+>
pages_updated:
  - <files in ORIGINAL_UPDATED_ENTRIES whose entry.sources contains this slug — pre-dedup; B5 v1.2.1+>
```

Per-slug `pages_created`/`pages_updated` filtering uses each entry's `sources` list against the **pre-dedup** snapshot taken in Step 8c.1 (`ORIGINAL_CREATED_ENTRIES` / `ORIGINAL_UPDATED_ENTRIES`). A page only lists a slug if that slug actually contributed to it. **B5 review fix (v1.2.1+):** in same-batch co-create cases (`slug1` and `slug2` independently produce `X.md`), Step 8c.1's intra-batch dedup demotes `slug2`'s log-emission classification to `pages_updated`, but per-source yamls preserve the truth — both `slug1.yaml` and `slug2.yaml` record `X.md` under `pages_created`. The wiki-lint source-provenance invariant continues to hold (every page's frontmatter `sources:` slug has a matching `.wiki-meta/sources/<slug>.yaml` whose `pages_*` includes that page). The log-line invariant (each filename appears in `pages_created` at most once across log lines) is enforced exclusively at Step 10's log emission — see Step 10's R3C1+IW3+RW2 blockquote for the per-source log line classification.

`content_hash` comes from the Step 8d normalized map. When the agent could compute its own sha256, this exactly matches the bytes it ingested. When the agent could not, main's post-hoc hash reflects the bytes *available on disk / at the URL* at reconciliation time — for `type: file` and `type: text` this is effectively identical (the file does not change between the agent's read and main's hash in a single ingest), and for `type: url` it is best-effort.

### 9. Update Index

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Read the current `.wiki-meta/index.json` (envelope-aware). For each entry in
`CREATED_ENTRIES` ∪ `UPDATED_ENTRIES`, use the entry's `{file, title, tags,
aliases}` directly — do NOT re-read the page body. `CREATED_ENTRIES` produce
new index entries; `UPDATED_ENTRIES` overwrite existing ones. Update
`generated_at` to the current UTC timestamp, then re-wrap via
`wrap-index-envelope.js`.

**v1.5.0+ envelope contract:** `index.json` is wrapped in the M3 cross-plugin
envelope (cf. claude-deep-suite/docs/envelope-migration.md §1). The legacy
`{pages, generated_at}` shape is preserved verbatim inside `payload`, so the
in-memory merge logic operates on the unwrapped payload. The reader handles
legacy (pre-1.5.0) input transparently; the writer always emits the wrapped
form. Multi-source aggregator: each scanned page is recorded in
`provenance.source_artifacts[]` path-only (markdown — no envelope detect);
`parent_run_id` is omitted by default.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"

# 9.a — Read existing index (envelope-aware unwrap → legacy shape).
# read-index-envelope.js exits 0 on success (legacy or unwrapped envelope),
# 1 on identity mismatch / corrupt payload, 2 on IO / parse error.
EXISTING_INDEX=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
                   "${WIKI_ROOT}/.wiki-meta/index.json")

# 9.b — Merge in-memory: apply CREATED_ENTRIES + UPDATED_ENTRIES. The merged
# JSON has the legacy { pages, generated_at } shape. Sort pages alphabetically
# by filename. (See ingest implementation for the actual jq/node merge logic.)
MERGED_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PAYLOAD_TMP="${WIKI_ROOT}/.wiki-meta/index.payload.tmp.$$.$(date +%s).json"
echo "$EXISTING_INDEX" | jq \
  --argjson created "$CREATED_ENTRIES_JSON" \
  --argjson updated "$UPDATED_ENTRIES_JSON" \
  --arg ts "$MERGED_TS" \
  '.generated_at = $ts
   | (.pages // []) as $existing
   | ($created + $updated) as $delta
   | ($delta | map(.file) | unique) as $delta_files
   | ($existing | map(select(.file as $f | $delta_files | index($f) | not))) as $kept
   | .pages = (($kept + $delta) | sort_by(.file))' \
  > "$PAYLOAD_TMP"

# 9.c — Envelope-wrap + atomic write. Each scanned page contributes one
# --source-page entry; the helper writes atomically (temp + rename) and
# gated cleanup keeps the payload temp on failure for retry.
SOURCE_PAGE_ARGS=()
while IFS= read -r REL; do
  [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
done < <(jq -r '.pages[].file' "$PAYLOAD_TMP" 2>/dev/null | awk '{ print "pages/" $0 }')

if node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-index-envelope.js" \
     --payload-file "$PAYLOAD_TMP" \
     --output "${WIKI_ROOT}/.wiki-meta/index.json" \
     "${SOURCE_PAGE_ARGS[@]}"; then
  rm -f "$PAYLOAD_TMP"
else
  echo "ERROR: wrap-index-envelope.js failed; payload preserved at $PAYLOAD_TMP for retry" >&2
  exit 1
fi
```

If the existing `index.json` fails identity check (e.g. a foreign envelope
mistakenly placed there) the reader exits 1 — Step 9 aborts and surfaces the
identity-mismatch reason. Manual recovery: invoke `/wiki-rebuild` which
regenerates the index from scratch (page frontmatter is the source of truth;
`index.json` is derived per skills/wiki-schema/SKILL.md).

### 10. Append to Log

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

**B3 v1.4.2 phase_timing_ms capture** — immediately before the first log line is appended (after all per-slug filtering / dedup is complete), capture `LOG_EMIT_MS=$(_ts_ms)`. Build the `phase_timing_ms` JSON object from the captured stage timestamps. Per the schema in "Step 7 — Shared utility: phase timing telemetry" above, deltas are:

```bash
# W3 fix (v1.4.2 post-impl review) — apply ${var:-0} defaultization to all
# base variables so this compute is set -u tolerant. Path-coverage matrix
# above lists clean-bypass paths (ingest-skip / ingest-repair / ingest-fail)
# that never reach this site, but a future code-path unification might
# emit phase_timing_ms with an unset variable. Defensive default keeps the
# field arithmetic-safe.
PT_STAGE_1_MS=$(( ${STAGE_1_END_MS:-0} - ${STAGE_1_START_MS:-0} ))
PT_STAGE_2_MS=$(( ${STAGE_2_END_MS:-${STAGE_1_END_MS:-0}} - ${STAGE_2_START_MS:-${STAGE_1_END_MS:-0}} ))   # 0 when sub-threshold/empty/multi-source
PT_STAGE_3_MS=$(( ${LOG_EMIT_MS:-0} - ${STAGE_3_START_MS:-0} ))
PT_TOTAL_MS=$((  ${LOG_EMIT_MS:-0} - ${INGEST_T0_MS:-0} ))
PHASE_TIMING_JSON=$(printf '{"stage_1_analysis":%d,"stage_2_fanout":%d,"stage_3_write":%d,"total":%d}' \
                   "$PT_STAGE_1_MS" "$PT_STAGE_2_MS" "$PT_STAGE_3_MS" "$PT_TOTAL_MS")
```

Append one log line **per source in the batch**, using the per-slug filter applied to the **post-dedup** `CREATED_ENTRIES` / `UPDATED_ENTRIES` arrays — *not* the per-source yaml lists, which after the B5 fix (v1.2.1+) are intentionally pre-dedup. The yamls record full per-source attribution (both contributing slugs in a co-create get `pages_created:[X.md]`); the log lines apply the intra-batch dedup so the log invariant (each filename appears in `pages_created` at most once across log lines) is preserved at the log-emission layer:

```json
{"ts":"<iso_timestamp>","action":"ingest","source":"<slug>","pages_created":[...filtered_for_slug],"pages_updated":[...filtered_for_slug],"phase_timing_ms":{"stage_1_analysis":<int>,"stage_2_fanout":<int>,"stage_3_write":<int>,"total":<int>}}
```

For a single-source ingest this is one line; for multi-source batch it is one line per source, identical `ts` and identical `phase_timing_ms` (timing is per-batch, not per-source — workers split sources by `i % WORKER_COUNT`, no per-source decomposition is meaningful). This matches the per-source yaml written in Step 8e — any page whose frontmatter `sources:` field lists a given slug MUST appear under that slug's log line (`pages_created` or `pages_updated`). The `phase_timing_ms` field is **schema-additive** (`wiki-lint` Step 6 LOG-INVARIANT scan filters via `select(.action != "ingest-repair") | .pages_created[]?` — unknown top-level fields ignored). Field is **omitted** from `ingest-skip`, `ingest-repair`, `ingest-fail`, `lint`, `rebuild`, `delete`, `query-filed`, `setup` lifecycle actions (only `ingest` carries it).

> **Drain note (RW2 review fix, v1.2.1+):** the `SKIPPED` and `REPAIR` arrays populated by Step 1.5 are *drained here in Step 10*, not in Step 8 — see the `(v1.2.1+, R3C1 + IW3)` blockquote immediately below for the exact replacement-vs-supplement semantics. Step 8e per-source yamls are still written for SKIPPED slugs (no-op — yaml is already authoritative) and for REPAIR slugs (per current cycle's restoration). The two paths converge here.

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

Every ingest — single-source, multi-source, URL, file, or deep-work report — dispatches to `deep-wiki:wiki-synthesizer-analysis` (single-source A5 path) or `deep-wiki:wiki-synthesizer-worker` (multi-source A4 path) at Step 7. The agent owns source reading, page-body reading, create-vs-update judgment, page writing, and version backup; this command owns lock, pre-batch snapshot, metadata (index.json, log.jsonl, sources/*.yaml), human artifacts (index.md, log.md), and auto-lint. This separation keeps page content out of main's context window, which matters especially for batch auto-ingests (see below).

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
5. Each group is dispatched to `deep-wiki:wiki-synthesizer-worker` as a multi-source batch (Step 7) — no flag needed
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
- If any of the split agents (`deep-wiki:wiki-synthesizer-{analysis|worker}`, also `deep-wiki:wiki-page-writer` for A5 fanout) cannot be spawned or returns an unparseable response, release the lock and report the error. Do NOT promote `.pending-scan` — the next session will re-detect the window.

  "Unparseable" depends on which split agent returned the response (per-agent contracts differ in v1.4.1+):
  - `deep-wiki:wiki-synthesizer-analysis`: missing `mode: "analysis"` literal, OR missing `page_plan` array (may be empty), OR missing `source_hashes` map. `inline_bodies` array required (may be empty when above-threshold).
  - `deep-wiki:wiki-synthesizer-worker`: missing `mode: "worker"` literal, OR missing `drafts` array, OR missing `source_hashes` map.
  - `deep-wiki:wiki-page-writer`: missing `file` field, OR missing `page_content`, OR missing `frontmatter_meta` (object), OR missing `worker_status` field.
  - For `wiki-synthesizer-analysis` AND `wiki-synthesizer-worker`: `source_hashes` missing a slug the caller passed in is fatal.
  - For `wiki-page-writer`: any worker-output validation failure is handled per Step 7.6.B Gates 1-4 (file basename, status branch, page_content non-empty, frontmatter_meta subfields) — the per-agent contract above is the BEFORE-Gate-1 baseline.
  - Note: invalid-format `source_hashes` *values* (sentinels like `"main-computes"`, empty strings, non-hex) are NOT fatal — Step 8d normalizes them via main-side recompute. Only a missing key for a slug the caller passed in is fatal.
  - Legacy `created`/`updated`/`versioned`/`failed` shape applies ONLY to the Step 8 manifest AFTER main reconciles drafts/page_plans (i.e., post-aggregation, NOT raw split-agent output). Step 8a's manifest construction generates this shape from per-agent outputs; Step 8b+ validation operates on this constructed manifest, not on the raw agent JSON.
- Always release the lock in case of errors (use trap in bash operations)
- **Inbox cleanup (type: text)**: The trap that releases the lock also deletes each file in `INBOX_FILES` (populated in Step 6.5). Never use `.inbox/*.txt` wildcards — stale inbox files from a prior crashed session belong to that session and may still be needed for recovery. This cleanup runs on success AND failure so pasted text never lingers on disk
- **Orphan versions**: If any `failed` entry carries an `orphan_version`, surface it in the Step 14 report so the user knows a backup exists for a page that did NOT get overwritten. Auto-lint's retention prune (Step 13) handles actual cleanup — no special action here
- If the agent returns `failed` entries (partial success): proceed with metadata updates for the succeeded pages and include the failures in the Step 14 report. **Do NOT promote `.pending-scan` on any partial or full failure** — the next session's hook will re-detect and re-process the window (no data loss). This matches the original "process all files successfully before promoting" semantics
