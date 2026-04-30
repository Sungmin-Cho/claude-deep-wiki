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

**Exclusions (NOT reported as orphans):**

1. `welcome.md` — entry-point page.
2. Pages whose frontmatter `tags:` includes `leaf` — author-marked intentional leaf (archive index, milestone summary, personal log).
3. Pages whose filename matches a glob in `~/.claude/deep-wiki-config.yaml:lint.orphan_ignore` (optional config block).

```yaml
# Optional config block in ~/.claude/deep-wiki-config.yaml
lint:
  orphan_ignore:
    - "archive-*.md"
    - "daily-note-*.md"
    - "personal-*.md"
```

The exclusions are union — any one match exempts the page.

```bash
# Detect frontmatter tag 'leaf' across all pages (B3 review note).
TAGGED_LEAVES=$(for f in "$WIKI_ROOT/pages"/*.md; do
  awk '
    BEGIN{infm=0; intags=0; found=0}
    /^---[[:space:]]*$/ { fm++; if(fm==1) infm=1; else if(fm==2){exit} }
    infm && /^tags:[[:space:]]*\[/ {
      line=$0; sub(/^tags:[[:space:]]*\[/,"",line); sub(/\][[:space:]]*$/,"",line)
      n=split(line,arr,",")
      for(i=1;i<=n;i++){ gsub(/^[[:space:]"\x27]+|[[:space:]"\x27]+$/,"",arr[i]); if(arr[i]=="leaf"){found=1;exit} }
      next
    }
    infm && /^tags:[[:space:]]*$/ { intags=1; next }
    infm && intags && /^[[:space:]]+-[[:space:]]*leaf[[:space:]]*$/ { found=1; exit }
    infm && intags && !/^[[:space:]]+-/ { intags=0 }
    END{ if(found) print FILENAME }
  ' "$f" 2>/dev/null
done | xargs -I{} basename {} | sort -u)

# Orphan ignore globs from ~/.claude/deep-wiki-config.yaml — block-aware awk
# (mirror of Task 2.2's auto_ingest.ignore_globs parser) (I3 review note).
ORPHAN_IGNORE_GLOBS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ORPHAN_IGNORE_GLOBS+=("$line")
done < <(awk '
  /^lint:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/             { in_block=0 }
  in_block && /^[[:space:]]+orphan_ignore:[[:space:]]*(#.*)?$/ { in_list=1; next }
  in_block && in_list && /^[[:space:]]+-[[:space:]]*/ {
    sub(/^[[:space:]]+-[[:space:]]*/, "")
    sub(/[[:space:]]+#.*$/, "")
    sub(/[[:space:]]+$/, "")
    gsub(/^["'"'"']|["'"'"']$/, "")
    print
  }
  in_block && in_list && !/^[[:space:]]+-/ { in_list=0 }
' "$CONFIG" 2>/dev/null)

# Apply: filter $ORPHANS by removing welcome.md, $TAGGED_LEAVES, glob matches.
NEW_ORPHANS=""
for f in $ORPHANS; do
  [ "$f" = "welcome.md" ] && continue
  printf '%s\n' "$TAGGED_LEAVES" | grep -Fxq "$f" && continue
  matched=false
  if [ ${#ORPHAN_IGNORE_GLOBS[@]} -gt 0 ]; then
    for pat in "${ORPHAN_IGNORE_GLOBS[@]}"; do
      case "$f" in
        $pat) matched=true; break ;;
      esac
    done
  fi
  $matched && continue
  NEW_ORPHANS="$NEW_ORPHANS$f"$'\n'
done
ORPHANS="$NEW_ORPHANS"
```

**If `OBS_LIVE`**, use Obsidian's link graph for more accurate orphan detection:

```bash
obsidian orphans 2>/dev/null
```

> **Wiki boundary filter required.** This command returns vault-wide results and does not support `path=` scoping or `format=json`. Parse line-by-line and keep **only** entries starting with `<wiki_prefix>/pages/`. Discard all other vault notes. On parse failure, fall back to the regex-based scan above.

### 4. Broken Link Detection

For each markdown link `[text](target.md)` found in pages **outside fenced code blocks**, check if `target.md` exists in `pages/`. Report any broken links with the source page and target.

**Code block exclusion (v1.2.0+):** Strip **fenced** code blocks (```...```) before grep'ing for links. **4-space-indented blocks are NOT stripped** (NW3 review note — CommonMark treats 4-space inside lists as item-continuation, and unconditional stripping would silently swallow valid links inside list items). Inline backticks (\`code\`) are also not stripped because broken-link false-positives from inline code are rare and inline backticks can span partial lines.

```bash
# Reference implementation
strip_code_blocks() {
  # W7 review finding: do NOT strip 4-space-indented blocks. CommonMark
  # only treats 4-space at *block start* as code, but this awk has no
  # block-context sense and would also eat list-item continuations like
  # "- top\n    - nested with [link](other.md)", causing false negatives
  # in broken-link detection. Fenced (```) is the dominant style in this
  # repo's pages anyway — fence stripping alone is sufficient.
  awk '
    BEGIN{infence=0}
    /^```/ { infence = !infence; next }
    !infence { print }
  ' "$1"
}

for f in "$WIKI_ROOT/pages"/*.md; do
  bn=$(basename "$f")
  strip_code_blocks "$f" | grep -oE '\[([^]]+)\]\(([^)]+\.md)\)' | while read match; do
    tgt=$(echo "$match" | sed -E 's/.*\(([^)]+\.md)\)/\1/')
    [ ! -f "$WIKI_ROOT/pages/$tgt" ] && echo "[BROKEN] $bn → $tgt"
  done
done
```

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
jq -r 'select(.action != "ingest-repair") | .pages_created[]? | select(type=="string")' "<wiki_root>/log.jsonl" \
  | sort | uniq -c | awk '$1 > 1 { print $2, "appears " $1 " times in pages_created" }'
```

> The invariant applies to every log entry that emits `pages_created` — including `setup` (seeds `welcome.md`), `ingest`, `query-filed`, and any future action. **Exception (R3C1 review fix, v1.2.1+):** `ingest-repair` lines are excluded from the duplicate scan because they always emit `pages_created:[]` (per `commands/wiki-ingest.md` Step 10 spec) — a self-repair is a restoration of a previously-created page's lifecycle, not a new creation. The `select(.action != "ingest-repair")` filter is defense-in-depth in case any legacy or out-of-spec entry slips a non-empty `pages_created` into an `ingest-repair` line.

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

### 11. Scan-Window Invariant Check (v1.2.0+)

Inspect `<wiki_root>/.wiki-meta/.last-scan` and `<wiki_root>/.wiki-meta/.pending-scan` for three pathological states. Reports as `[SCAN-WINDOW]`.

```bash
LAST_FILE="<wiki_root>/.wiki-meta/.last-scan"
PEND_FILE="<wiki_root>/.wiki-meta/.pending-scan"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

LAST=$(cat "$LAST_FILE" 2>/dev/null || true)
PEND=$(cat "$PEND_FILE" 2>/dev/null || true)

# State A: invalid TS regex on either file
if [ -s "$LAST_FILE" ] && ! [[ "$LAST" =~ $TS_RE ]]; then
  echo "[SCAN-WINDOW] .last-scan content is not valid UTC ISO 8601 with Z suffix: $(printf '%q' "$LAST")"
fi
if [ -s "$PEND_FILE" ] && ! [[ "$PEND" =~ $TS_RE ]]; then
  echo "[SCAN-WINDOW] .pending-scan content is not valid UTC ISO 8601 with Z suffix: $(printf '%q' "$PEND")"
fi

# State B: PENDING < LAST (stale pending, would have caused regression in v1.1.3)
if [[ "$LAST" =~ $TS_RE ]] && [[ "$PEND" =~ $TS_RE ]] && [[ "$PEND" < "$LAST" ]]; then
  echo "[SCAN-WINDOW] .pending-scan ($PEND) is older than .last-scan ($LAST) — stale pending will be dropped on next ingest by v1.1.4 guard"
fi

# State C: LAST is more than 48h old AND PENDING is newer (auto-ingest stalled)
if [[ "$LAST" =~ $TS_RE ]]; then
  # tri-branch (I2 review note): GNU coreutils gdate / BSD-macOS / Linux.
  # Mirror of hooks/scripts/scan-vault-changes.sh:89-95 — without this,
  # Linux runs always get LAST_EPOCH=0 and a State C warning of ~half-a-million hours.
  if command -v gdate >/dev/null 2>&1; then
    LAST_EPOCH=$(gdate -d "$LAST" +%s 2>/dev/null || echo 0)
  elif [[ "$(uname)" == "Darwin" ]]; then
    LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST" +%s 2>/dev/null || echo 0)
  else
    LAST_EPOCH=$(date -d "$LAST" +%s 2>/dev/null || echo 0)
  fi
  NOW=$(date -u +%s)
  AGE_HOURS=$(( (NOW - LAST_EPOCH) / 3600 ))
  if [ "$AGE_HOURS" -gt 48 ] && [[ "$PEND" =~ $TS_RE ]]; then
    echo "[SCAN-WINDOW] .last-scan is ${AGE_HOURS}h old and .pending-scan exists — auto-ingest may have stalled. Inspect log.jsonl for recent ingest activity."
  fi
fi
```

These are health signals; State B and the invalid-TS variant are auto-fixable in Step 13.

> **Note on Step renumbering:** This insertion shifts the existing Step 11 (Report) → Step 12, and the existing Step 12 (Auto-Fix) → Step 13.

### 12. Report

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

### 13. Auto-Fix (if --fix flag)

If the user passed `--fix`:
- Prune excess versions (keep last 3)
- Add missing pages to index.json
- Remove ghost entries from index.json
- Do NOT auto-fix content issues (schema violations, orphans, broken links) — these require human judgment
- Drop stale `.pending-scan` (State B from Step 11 — `PENDING < LAST`)
- Drop invalid `.pending-scan` content (State A on `.pending-scan`); leave `.last-scan` intact (State A on `.last-scan` requires manual intervention because dropping it would trigger first-run fallback).

```bash
# In the --fix path (SCAN-WINDOW auto-fix, v1.2.0+):
LAST=$(cat "$WIKI_ROOT/.wiki-meta/.last-scan" 2>/dev/null || true)
PEND=$(cat "$WIKI_ROOT/.wiki-meta/.pending-scan" 2>/dev/null || true)
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

if [ -s "$WIKI_ROOT/.wiki-meta/.pending-scan" ] && ! [[ "$PEND" =~ $TS_RE ]]; then
  rm -f "$WIKI_ROOT/.wiki-meta/.pending-scan"
  echo "  --fix: dropped invalid .pending-scan"
elif [[ "$LAST" =~ $TS_RE ]] && [[ "$PEND" =~ $TS_RE ]] && [[ "$PEND" < "$LAST" ]]; then
  rm -f "$WIKI_ROOT/.wiki-meta/.pending-scan"
  echo "  --fix: dropped stale .pending-scan (older than .last-scan)"
fi
```
