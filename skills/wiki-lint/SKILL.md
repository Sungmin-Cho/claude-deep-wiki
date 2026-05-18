---
name: wiki-lint
description: Use when the user wants to inspect the deep-wiki for health issues — orphan pages, broken inter-page links, schema violations, contradictions, stale content, missing source provenance YAML, `pages_created` exactly-once invariant breaks, and `.last-scan` monotonicity violations. Triggers on `/wiki-lint`, "lint wiki", "check wiki health", "wiki status", "wiki audit", "wiki diagnose", "wiki dashboard", "위키 린트", "위키 점검", "위키 상태", "위키 헬스체크", "위키 무결성". Accepts an optional `--fix` flag that auto-repairs the auto-fixable subset (broken links, orphan removal, sources/ slug normalization) while leaving audit-only items in the dashboard.
user-invocable: true
---

# wiki-lint — Wiki Health Check

Inspect the wiki for structural issues, inconsistencies, and schema violations.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Prerequisites" / §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — 사용자가 `/wiki-lint [--fix]` 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-wiki:wiki-lint", args: "[--fix]" })` 형태로 명시 invoke (cross-platform 표준 경로).

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, 본문의 fix-mode 분기가 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | dry-run — 모든 lint 항목을 dashboard 로 보고, 변경 없음 |
| `--fix` | auto-fixable 항목 (broken links, orphan removal, source provenance YAML 정규화) 자동 수정; audit-only 항목은 보고만 |

## Prerequisites

이 entry skill 은 `wiki-schema` sibling skill (4 critical invariants + 10 log actions + storage layout 규칙) 의 validation 규칙을 동작 전제로 합니다. 또한 4 개 sibling entry skill 과 wiki_root 를 공유합니다 — `wiki-setup` 으로 wiki_root 가 사전 초기화되어 있어야 하며, lint 의 auto-fix 는 `wiki-ingest` / `wiki-query` / `wiki-rebuild` 가 이후 idempotent 하게 동작하도록 invariants 를 복원합니다.

**Cross-platform self-containment**: Claude Code 에서는 sibling skill (`wiki-schema`) 이 description 매칭으로 자동 로드됩니다. 다만 Codex / Copilot CLI / Gemini CLI 등 타 플랫폼에서 `Skill()` 호출 시 sibling skill 의 auto-load 보장이 약할 수 있으므로, 본 SKILL §"Steps" 본문은 **의도적으로 self-contained** — 6 step lint pipeline (status dashboard / link check / orphan check / schema check / log-invariant scan / source provenance check), `lint` lifecycle action 의 `log.jsonl` entry 형식, `pages_created` exactly-once 불변식의 enforcement 규약을 인라인으로 보존합니다.

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
# (mirror of v1.3.0+ broadened auto_ingest.ignore_globs parser; both accept block + inline + dotted forms).
ORPHAN_IGNORE_GLOBS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ORPHAN_IGNORE_GLOBS+=("$line")
done < <(awk '
  # Inline list parser used by both block-inline and dotted-form branches.
  function parse_inline_list(line,    s, items, n, i, item) {
    s = line
    sub(/^[^\[]*\[/, "", s)         # strip everything up to and including [
    sub(/\][[:space:]]*(#.*)?$/, "", s)   # strip trailing ] and any comment
    n = split(s, items, /,/)
    for (i = 1; i <= n; i++) {
      item = items[i]
      gsub(/^[[:space:]]*["'"'"']?/, "", item)
      gsub(/["'"'"']?[[:space:]]*$/, "", item)
      if (item != "") print item
    }
  }
  # Form 3: dotted top-level (matched anywhere, no in_block dependency)
  /^lint\.orphan_ignore:[[:space:]]*\[/ {
    parse_inline_list($0)
    next
  }
  /^lint:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/             { in_block=0 }
  # Form 2: inline form inside lint block
  in_block && /^[[:space:]]+orphan_ignore:[[:space:]]*\[/ {
    parse_inline_list($0)
    in_list=0
    next
  }
  # Form 1: block form (existing). `next` is required: the sub() above
  # mutates $0 (strips the leading "  - "), so without `next` the terminator
  # rule below would fire on the very same line and prematurely set in_list=0,
  # silently dropping every list item after the first. (Pre-existing bug
  # surfaced by v1.3.0 sandbox; fixed here as part of the broaden.)
  in_block && /^[[:space:]]+orphan_ignore:[[:space:]]*(#.*)?$/ { in_list=1; next }
  in_block && in_list && /^[[:space:]]+-[[:space:]]*/ {
    sub(/^[[:space:]]+-[[:space:]]*/, "")
    sub(/[[:space:]]+#.*$/, "")
    sub(/[[:space:]]+$/, "")
    gsub(/^["'"'"']|["'"'"']$/, "")
    print
    next
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

**Code block exclusion (v1.2.1+):** Strip **fenced** code blocks (```...```) unconditionally, and strip **4-space- or tab-indented blocks** with block-context awareness (track blank/list/paragraph/indented-code state) so real multi-line indented code blocks are stripped while list-item continuations and paragraph lazy continuations are preserved. Inline backticks (\`code\`) are still not stripped because broken-link false-positives from inline code are rare and inline backticks can span partial lines. Tab-indent recognition added in v1.3.0 (1.2). Post-list 2-blank-line list termination (CommonMark) added in v1.3.0 (1.3).

```bash
# Reference implementation
strip_code_blocks() {
  # W7 review fix (v1.2.1+): the v1.2.0 NW3 deferral kept 4-space blocks
  # entirely intact to avoid false-negatives on list continuations. v1.2.1
  # tracks block context (blank / list / paragraph / indented-code) so real
  # multi-line indented code blocks are stripped while list continuations and
  # paragraph lazy continuations are preserved. Fenced (```) is stripped
  # unconditionally. v1.3.0 (1.2) extended the indent rule to recognize
  # tab-indent (\t) in addition to 4 spaces. v1.3.0 (1.3) added a blank_run
  # counter so prev_was_list resets after 2 consecutive blank lines, matching
  # the CommonMark rule that 2 blank lines terminate a list — closes the
  # remaining post-list code-block false-negative.
  #
  # CR-C v1.2.1+: explicit in_indented_code state so 2nd+ lines of a multi-line
  # indented block are also stripped. Without this state, prev_blank=0 after
  # the first stripped line caused subsequent 4-space lines to fall into the
  # paragraph-lazy-continuation branch and leak into broken-link detection.
  #
  # All earlier deferred limitations (W-γ tab-indent, W-δ post-list 2-blank
  # reset) are now closed in v1.3.0.
  awk '
    BEGIN { infence=0; prev_was_list=0; prev_blank=1; in_indented_code=0; blank_run=0 }
    /^```/ { infence = !infence; in_indented_code=0; next }
    infence { next }
    /^[[:space:]]*$/ {
      # v1.3.0 (1.3): 2 consecutive blank lines terminate list context
      # (CommonMark spec). After reset, a 4-space-indented line becomes a
      # real code block, not a list continuation. Closes W-δ false-negative.
      blank_run += 1
      if (blank_run >= 2) prev_was_list = 0
      prev_blank=1; in_indented_code=0
      print; next
    }
    /^[[:space:]]*([-*+]|[0-9]+\.)[[:space:]]/ {
      prev_was_list=1; prev_blank=0; in_indented_code=0; blank_run=0
      print; next
    }
    /^(    |\t)/ {
      # v1.3.0 (1.2): tab-indent now recognized as CommonMark indented code
      # marker, in addition to 4 spaces. Closes the W-γ false-positive on
      # broken-link detection inside tab-indented code blocks.
      if (in_indented_code) {
        # continuation of an already-open indented code block — strip
        prev_blank=0; blank_run=0; next
      }
      if (prev_was_list || !prev_blank) {
        # list continuation OR paragraph lazy continuation — keep
        prev_blank=0; blank_run=0; print; next
      }
      # start of an indented code block (after blank, no list context) — strip
      in_indented_code=1; prev_blank=0; blank_run=0; next
    }
    {
      # any other line — paragraph; if non-indented it breaks list/code context
      if ($0 !~ /^[[:space:]]/) { prev_was_list=0; in_indented_code=0 }
      prev_blank=0; blank_run=0; print
    }
  ' "$1"
}

for f in "$WIKI_ROOT/pages"/*.md; do
  bn=$(basename "$f")
  strip_code_blocks "$f" | grep -oE '\[([^]]+)\]\(([^)]+\.md)\)' | while read match; do
    tgt=$(echo "$match" | sed -E 's/.*\(([^)]+\.md)\)/\1/')
    # T10 review fix (v1.2.1+): external URLs ending in .md (e.g. GitHub gist
    # raw URL) are not local wiki links — skip the existence check.
    case "$tgt" in
      http://*|https://*) continue ;;
    esac
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

Check `index.json` (envelope-aware in v1.5.0+) for:
- Pages with identical titles
- Pages where one page's title matches another page's alias
- Suggest merge candidates

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
INDEX_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
              "${WIKI_ROOT}/.wiki-meta/index.json")
# $INDEX_JSON has legacy { pages, generated_at } shape — duplicate scan works
# on .pages[].title and .pages[].aliases[] unchanged.
```

### 6. Log Invariant Check — `pages_created` Duplication

Parse `log.jsonl` and flag any page filename that appears in `pages_created` **more than once** across all entries. By invariant, each page is "created" exactly once over the entire history; duplicates indicate a prior ingest misclassified an update as a create.

Example jq query (reference):
```bash
jq -r 'select(.action != "ingest-repair") | .pages_created[]? | select(type=="string")' "<wiki_root>/log.jsonl" \
  | sort | uniq -c | awk '$1 > 1 { print $2, "appears " $1 " times in pages_created" }'
```

> The invariant applies to every log entry that emits `pages_created` — including `setup` (seeds `welcome.md`), `ingest`, `query-filed`, and any future action. **Exception (R3C1 review fix, v1.2.1+):** `ingest-repair` lines are excluded from the duplicate scan because they always emit `pages_created:[]` (per `skills/wiki-ingest/SKILL.md` Step 10 spec) — a self-repair is a restoration of a previously-created page's lifecycle, not a new creation. The `select(.action != "ingest-repair")` filter is defense-in-depth in case any legacy or out-of-spec entry slips a non-empty `pages_created` into an `ingest-repair` line.

Report findings as `[LOG-INVARIANT]` — no auto-fix (historical log is append-only). Fix forward in future ingests by respecting the pages_created classification rule.

> **v1.4.0 compatibility note:** A5 fanout ingests may emit an additional
> top-level `pages_failed` field in `log.jsonl` (per `skills/wiki-ingest/SKILL.md`
> Step 7.6.E Step 10 + Step 7.6.F sentinel payload). The `jq -r '.pages_created[]?'`
> operator + `select(type=="string")` filter above ignores the new field
> correctly — no schema update needed. v1.4.0 also introduces
> `partial-fail-recovery` as a new `repair_reason` value (alongside v1.2.1 R3W2's
> `missing-page:<file>`, `page-missing-slug:<file>`, `log-jsonl-missing`,
> `no-prior-terminal-log`, `last-action-not-terminal:<action>`). This value
> is informational (Step 10 R3C1 emit only) — wiki-lint does NOT strict-validate
> it, so no whitelist update needed.

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

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
# Envelope-aware read of index.json (v1.5.0+ envelope-wrapped or legacy).
INDEX_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
              "${WIKI_ROOT}/.wiki-meta/index.json")
INDEX_FILES=$(echo "$INDEX_JSON" | jq -r '.pages[].file' | sort)
# macOS BSD `find` lacks `-printf`; portable alternative: cd into pages/ in a
# subshell so output paths are already basename-relative. Strip leading `./`
# that BSD find emits when the search root is `.`.
DISK_FILES=$(cd "${WIKI_ROOT}/pages" 2>/dev/null && find . -maxdepth 1 -name '*.md' -type f 2>/dev/null | sed 's|^\./||' | sort)
# Compare INDEX_FILES vs DISK_FILES with comm -23 / comm -13 as usual.
```

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
- Add missing pages to index.json (v1.5.0+ — see envelope-aware index mutation below)
- Remove ghost entries from index.json (v1.5.0+ — same)
- Do NOT auto-fix content issues (schema violations, orphans, broken links) — these require human judgment
- Drop stale `.pending-scan` (State B from Step 11 — `PENDING < LAST`)
- Drop invalid `.pending-scan` content (State A on `.pending-scan`); leave `.last-scan` intact (State A on `.last-scan` requires manual intervention because dropping it would trigger first-run fallback).

**v1.5.0+ envelope-aware index mutation.** When `--fix` adds missing pages
or removes ghost entries from `index.json`, the write path MUST go through
the envelope helpers. Direct mutation of the wrapped file drops
`envelope.run_id` and provenance, breaking subsequent envelope-aware reads
(round-1 Codex adversarial #2). The simplest safe form delegates to
`/wiki-rebuild` (which already uses the envelope-wrap helper end-to-end):

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"

# Recommended: delegate index drift fix to /wiki-rebuild — it regenerates
# index.json from page frontmatter (the source of truth per
# skills/wiki-schema/SKILL.md) and emits envelope-wrapped output via the
# same atomic temp+rename helper used by /wiki-ingest. Equivalent semantics
# to a manual add-missing + remove-ghost cycle, without the envelope
# preservation foot-gun.

# Alternative — in-place envelope-aware index patch (for callers that
# explicitly need to scope changes to specific pages without a full
# rebuild). Same read-merge-write pattern as /wiki-query Step 5d and
# /wiki-ingest Step 9 — see those steps for the full pattern.
```

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
