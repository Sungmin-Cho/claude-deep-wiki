---
name: wiki-query
description: Use when the user wants to ask a question against the deep-wiki and get an answer grounded in the accumulated knowledge — searching pages, reading their bodies, and (when the answer is novel cross-page synthesis) auto-filing the answer back into the wiki as a new page via the `query-filed` lifecycle action. Triggers on `/wiki-query`, "ask the wiki", "wiki query", "search the wiki", "ask wiki", "위키 질의", "위키 검색", "위키에서 찾기", "위키에 물어보기", "위키 답변". The question string is passed as the sole argument.
user-invocable: true
---

# wiki-query — Search and Answer from the Wiki

Search wiki pages and generate an answer grounded in the wiki's accumulated knowledge. When a query produces novel cross-page synthesis, the result is automatically filed back into the wiki.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Prerequisites" / §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — 사용자가 `/wiki-query <question>` 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-wiki:wiki-query", args: "<question>" })` 형태로 명시 invoke (cross-platform 표준 경로).

두 경로 모두 args 는 동일한 자연어 질문 문자열로 전달되며, Step 1 의 query parsing 이 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| `<question>` | 자연어 질문 — 검색 쿼리이자 답변의 기반 |
| (없음) | 사용자에게 무엇을 알고 싶은지 물어봄 |

## Prerequisites

이 entry skill 은 `wiki-schema` sibling skill (4 critical invariants + 10 log actions + storage layout 규칙) 을 동작 전제로 합니다. 또한 4 개 sibling entry skill 과 wiki_root 를 공유합니다 — `wiki-setup` 으로 wiki_root 가 사전 초기화되어 있고 `wiki-ingest` 로 페이지가 쌓여 있어야 하며, query 가 cross-page synthesis 를 auto-file 할 때는 lock atomicity 와 `pages_created` exactly-once 불변식을 `wiki-lint` / `wiki-rebuild` 와 동일하게 준수합니다.

**Cross-platform self-containment**: Claude Code 에서는 sibling skill (`wiki-schema`) 이 description 매칭으로 자동 로드됩니다. 다만 Codex / Copilot CLI / Gemini CLI 등 타 플랫폼에서 `Skill()` 호출 시 sibling skill 의 auto-load 보장이 약할 수 있으므로, 본 SKILL §"Steps" 본문은 **의도적으로 self-contained** — 2-layer 검색 + 답변 pipeline (Layer 1: 페이지 검색·읽기 / Layer 2: lock 하 cross-page synthesis 의 auto-file), `query-filed` lifecycle action 의 `log.jsonl` entry 형식, 새 페이지 file naming 규약 (kebab-case + 충돌 회피 suffix) 을 인라인으로 보존합니다.

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If missing, tell the user to run `/wiki-setup` first.

#### Obsidian CLI Liveness Check

If the config contains `obsidian_cli.available: true`, check if the Obsidian app is running:

```bash
obsidian version 2>/dev/null
```

- **Success** → `OBS_LIVE=true`, read `wiki_prefix` from config.
- **Failure** → `OBS_LIVE=false`, use filesystem-only mode silently.

## Steps

### 1. Parse Question

Use the argument as the search query. If no argument, ask the user what they want to know.

### 2. Search Strategy

Perform a multi-layer search to find relevant pages:

**Layer 1 — Index scan:**
Read `.wiki-meta/index.json` (envelope-aware in v1.5.0+). Match the query
against page titles, tags, and aliases. Collect candidate page filenames.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
# Envelope-aware read — emits legacy {pages, generated_at} shape on stdout
# whether the file is pre-1.5.0 legacy or v1.5.0+ envelope-wrapped.
INDEX_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
              "${WIKI_ROOT}/.wiki-meta/index.json")
# Existing jq pipelines on $INDEX_JSON (.pages[].title etc.) work unchanged.
```

**Layer 2 — Content search:**
Use Grep to search `pages/` directory for keywords from the query. Add matching files to candidates.

**If `OBS_LIVE`**, supplement or replace Grep with Obsidian's full-text search:

```bash
obsidian search:context query="<query keywords>" path="<wiki_prefix>/pages" format=json
```

This leverages Obsidian's text index for broader matching than exact keyword grep.

**Layer 2.5 — Graph-based expansion (OBS_LIVE only):**

For each candidate page found in Layer 1-2, check its backlinks to discover related pages that may not contain the exact keywords:

```bash
obsidian backlinks path="<wiki_prefix>/pages/<candidate>.md" format=json
```

Add linked pages to the candidate list. This graph traversal is only available with Obsidian CLI.

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

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

**v1.5.0+ envelope-aware index update.** The auto-filing write path MUST
read-merge-write through the envelope helpers so the envelope wrapper is
preserved across query-filed updates. Direct `index.json` mutation drops
`run_id` / `provenance` and breaks subsequent envelope-aware reads
(round-1 Codex adversarial #1).

**Caller contract for the bash snippet below** (round-2 Opus W2-1
documentation gap; mirrors Step 9 of `/wiki-ingest`):

- `WIKI_ROOT` — absolute path to the wiki root.
- `CLAUDE_PLUGIN_ROOT` — set by Claude Code at session start; helper
  script locations.
- `QUERY_FILED_ENTRY_JSON` — JSON object describing the query-filed page,
  shape `{"file": "query-<topic>.md", "title": "...", "tags": [...],
  "aliases": [...]}`. The agent constructs this from Step 5c frontmatter.

If any required variable is absent the `${VAR:?msg}` guards abort with a
clear error before any mutation. A trap on EXIT releases the
`.wiki-lock` directory **only on failure paths** (round-3 Codex adv #1 +
Codex review #1 — 2-way fix). On the success path the lock is held
across the index update AND the log append (which happens after this
snippet exits, as the bullet below describes), and Step 5e releases the
lock once all writes are done. On any failure (read-helper exit 1, jq
exit, undefined-variable abort) the trap fires and releases the lock so
the wiki is never left in a stranded locked state.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
: "${CLAUDE_PLUGIN_ROOT:?caller must have CLAUDE_PLUGIN_ROOT set (Claude Code session env)}"
: "${QUERY_FILED_ENTRY_JSON:?caller must set QUERY_FILED_ENTRY_JSON to a JSON object {file,title,tags,aliases}}"

# Failure-only lock release — round-3 Codex adv #1 + Codex review #1
# (2-way fix). On success the lock stays held until Step 5e (after the
# log.jsonl append) so the index update + log append are one critical
# section. On any failure exit, the trap releases the lock to prevent
# stranded-lock state.
PAYLOAD_TMP="${WIKI_ROOT}/.wiki-meta/index.payload.tmp.$$.$(date +%s).json"
cleanup() {
  local rc=$?
  rm -f "$PAYLOAD_TMP" 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    rmdir "${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
    echo "ERROR: /wiki-query auto-file failed (exit $rc); lock released for retry" >&2
  fi
  return $rc
}
trap cleanup EXIT

# Read existing index (envelope-aware unwrap → legacy shape).
EXISTING_INDEX=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
                   "${WIKI_ROOT}/.wiki-meta/index.json")

# Merge the query-filed page. If the page already exists in pages[],
# overwrite its entry; otherwise insert.
MERGED_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$EXISTING_INDEX" | jq \
  --argjson entry "$QUERY_FILED_ENTRY_JSON" \
  --arg ts "$MERGED_TS" \
  '.generated_at = $ts
   | (.pages // []) as $existing
   | ($existing | map(select(.file != $entry.file))) as $kept
   | .pages = (($kept + [$entry]) | sort_by(.file))' \
  > "$PAYLOAD_TMP"

# Envelope-wrap + atomic write. Page paths gathered via portable BSD find
# (round-1 C1). Use ${ARR[@]+"${ARR[@]}"} expansion so bash 3.2 with set -u
# tolerates an empty pages directory (round-2 Opus W2-2 empty-array fix).
SOURCE_PAGE_ARGS=()
while IFS= read -r REL; do
  [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
done < <(cd "${WIKI_ROOT}" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)

node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-index-envelope.js" \
   --payload-file "$PAYLOAD_TMP" \
   --output "${WIKI_ROOT}/.wiki-meta/index.json" \
   ${SOURCE_PAGE_ARGS[@]+"${SOURCE_PAGE_ARGS[@]}"}
# On success: cleanup fires with rc=0 → tmp removed, lock kept for Step 5e.
# On failure: cleanup fires with rc!=0 → tmp removed, lock released.
```

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
