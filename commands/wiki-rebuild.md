---
allowed-tools: Read, Write, Bash, Glob, Grep
description: Regenerate derived wiki files (index.json) from page frontmatter. Use when the index is out of sync or corrupted.
argument-hint:
---

# /wiki-rebuild — Regenerate Wiki Index

Rebuild derived artifacts from the source-of-truth page files.

## Prerequisites

Read `~/.claude/deep-wiki-config.yaml` to get `wiki_root`. If missing, tell the user to run `/wiki-setup` first.

#### Obsidian CLI Liveness Check

If the config contains `obsidian_cli.available: true`, check if the Obsidian app is running:

```bash
obsidian version 2>/dev/null
```

- **Success** → `OBS_LIVE=true`, read `wiki_prefix` from config.
- **Failure** → `OBS_LIVE=false`, use filesystem-only checks.

## Steps

### 1. Acquire Lock

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
LOCK_DIR="${WIKI_ROOT}/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "ERROR: Wiki is locked by another session."; exit 1; }
```

**No trap here — round-4 Codex review #1 fix.** The Claude Code Bash
tool spawns a fresh shell per ```bash``` block, so registering an EXIT
trap inside this standalone lock-acquisition block would fire as soon
as the block ends — releasing the lock BEFORE Steps 2-5 run, leaving
the rebuild to proceed unlocked and allowing concurrent ingest/rebuild
to interleave. The lock instead has the following lifecycle:

- Step 1 (this block): `mkdir` acquires the lock (no trap).
- Step 3 (envelope wrap block below): registers an in-block EXIT trap
  that releases the lock ONLY on failure (`rc != 0`), so a helper
  failure in Step 3 cleans up its own lock without leaking. On success
  the lock stays held for Step 6 to release after the rebuild's other
  steps complete.
- Step 6 (Release Lock and Report): unconditional `rmdir` on the
  success path.

Crash recovery between Bash invocations (e.g. agent abort between Step
2 and Step 3) still leaks the lock — that is pre-existing wiki-rebuild
behaviour from the mkdir-based lock design and unchanged by M3. Manual
recovery: `rmdir <wiki_root>/.wiki-meta/.wiki-lock`.

### 2. Scan All Pages

Read every `.md` file in `pages/`. For each page, parse the YAML frontmatter to extract:
- `title`
- `tags`
- `aliases`
- filename

### 3. Regenerate index.json

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

Build a new `index.json` from the scanned data. v1.5.0+ wraps the page catalog
in the M3 cross-plugin envelope (cf. claude-deep-suite/docs/envelope-migration.md
§1) — the legacy `{pages, generated_at}` shape lives inside `payload`. The
envelope is added at write-time by `wrap-index-envelope.js`; consumers of
`index.json` use `read-index-envelope.js` to unwrap (or jq-equivalent: if
`.envelope` is present, treat `.payload` as the legacy structure; else use
the root). See "Envelope-aware read" sidebar below.

**Caller contract for the bash snippet below.** Required environment:

- `WIKI_ROOT` — absolute path to the wiki root.
- `CLAUDE_PLUGIN_ROOT` — set by Claude Code at session start; helper
  script locations.

**Step 3 — Build payload + envelope-wrap + atomic write (single bash
block).** Round-3 Codex review #2 fix: payload construction and envelope
wrap MUST live in a single Bash tool invocation. The Claude Code Bash tool
spawns a fresh shell per invocation, so a `PAYLOAD_TMP` variable defined in
one block is unavailable to the next block (the file at that path may also
have been cleaned up via the success-gated `rm -f`). Combining the two
operations is the only safe form. Multi-source aggregator: every scanned
page contributes one `--source-page` entry (path relative to `<wiki_root>`,
e.g. `pages/react-hooks.md`); pages are markdown → recorded path-only (no
envelope detect); `parent_run_id` is omitted. Helper writes atomically
(temp + rename); payload temp cleanup is gated on helper success (failure
preserves it for retry, deep-work round-1 C1+C2 lessons).

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"
: "${CLAUDE_PLUGIN_ROOT:?caller must have CLAUDE_PLUGIN_ROOT set (Claude Code session env)}"

# Round-4 Codex review #1 + Codex adv #2 fix: register a FAILURE-ONLY
# cleanup trap inside the mutation block. On success (rc=0) the lock
# stays held for Step 6 to release. On any failure (helper exit non-zero,
# jq exit, unset variable abort) the trap releases the lock to prevent
# the stranded-lock condition R3-2 targeted, without the R3-2 mistake
# of putting the trap in Step 1's standalone block (which fires
# immediately on Step 1 block exit and kills the lock before Step 2).
PAYLOAD_TMP="${WIKI_ROOT}/.wiki-meta/index.payload.tmp.$$.$(date +%s).json"
cleanup_step3() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    rmdir "${WIKI_ROOT}/.wiki-meta/.wiki-lock" 2>/dev/null || true
    echo "ERROR: /wiki-rebuild Step 3 failed (rc=$rc); lock released; payload preserved at $PAYLOAD_TMP" >&2
  fi
  return $rc
}
trap cleanup_step3 EXIT

# 3.a — Build payload. Pages array sorted alphabetically by filename
# (built from Step 2 scan; below is a structural template — caller
# substitutes actual page entries from the scan result).
cat > "$PAYLOAD_TMP" <<JSON
{
  "pages": [
    {
      "file": "react-hooks.md",
      "title": "React Hooks",
      "tags": ["programming", "react"],
      "aliases": ["hooks", "useState"]
    }
  ],
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

# 3.b — Collect --source-page args from scanned pages. macOS BSD `find`
# lacks `-printf`, so we cd into ${WIKI_ROOT} inside a subshell and rely
# on the already-relative `pages` prefix. Portable to BSD (macOS) + GNU
# (Linux). The subshell isolates the cd from the outer cwd.
#
# Round-2 Opus W2-2: use `${ARR[@]+"${ARR[@]}"}` expansion so that bash
# 3.2 (default `/bin/bash` on macOS) under `set -u` does not abort when
# SOURCE_PAGE_ARGS is empty (e.g. fresh wiki with no pages). The helper
# itself accepts zero `--source-page` flags.
SOURCE_PAGE_ARGS=()
while IFS= read -r REL; do
  [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
done < <(cd "${WIKI_ROOT}" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)

# 3.c — Envelope-wrap + atomic write. Helper writes atomically (temp +
# rename); cleanup is gated on helper success (deep-work round-1 C2).
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-index-envelope.js" \
     --payload-file "$PAYLOAD_TMP" \
     --output "${WIKI_ROOT}/.wiki-meta/index.json" \
     ${SOURCE_PAGE_ARGS[@]+"${SOURCE_PAGE_ARGS[@]}"}
rm -f "$PAYLOAD_TMP"
# On success: trap fires with rc=0 → no rmdir; lock kept for Step 6.
# On failure: trap fires with rc!=0 → rmdir lock; payload temp preserved
# above (no rm reached). User can retry without manual lock cleanup.
```

Sort pages alphabetically by filename inside the payload.

**Envelope-aware read (any consumer of index.json):**

When reading `index.json` (e.g. wiki-query, wiki-lint, wiki-ingest Step 4
overlap filter), use the envelope-aware reader so v1.5.0+ envelope-wrapped
files and pre-1.5.0 legacy files both yield the legacy `{pages, generated_at}`
shape on stdout. The reader enforces an identity guard (producer=deep-wiki,
artifact_kind=index, schema.name=index) and rejects foreign or corrupt
envelopes (handoff §4 round-4 + round-5/7 lessons).

```bash
# Returns payload-only JSON (legacy shape) on stdout. Exit codes:
# 0 ok, 1 identity mismatch / corrupt payload, 2 IO / parse error.
INDEX_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/read-index-envelope.js" \
              "${WIKI_ROOT}/.wiki-meta/index.json")
# Now use jq normally: echo "$INDEX_JSON" | jq -r '.pages[].file'
```

If `node` is unavailable in the agent context, a bash-only fast-path
(deep-work round-1 W6 lesson) detects the wrapper without spawning a
per-file Node process. **Note: this is a heuristic** — only
`read-index-envelope.js` is authoritative (full identity guard + corrupt-
payload defense). The grep-based path exists for environments lacking
Node; prefer the node helper whenever available.

```bash
# Fast-path heuristic — node helper is authoritative; this exists for
# environments without node in PATH. Identity check is text-grep based
# (deep-wiki/index/producer/schema_version anchors). corrupt-payload edge
# cases (e.g. payload omitted entirely) are NOT detected here.
if grep -q '"envelope":' "${WIKI_ROOT}/.wiki-meta/index.json" && \
   grep -q '"schema_version": *"1.0"' "${WIKI_ROOT}/.wiki-meta/index.json" && \
   grep -q '"producer": *"deep-wiki"' "${WIKI_ROOT}/.wiki-meta/index.json" && \
   grep -q '"artifact_kind": *"index"' "${WIKI_ROOT}/.wiki-meta/index.json"; then
  # Envelope: extract payload via jq.
  INDEX_JSON=$(jq '.payload' "${WIKI_ROOT}/.wiki-meta/index.json")
else
  # Legacy: use root directly.
  INDEX_JSON=$(cat "${WIKI_ROOT}/.wiki-meta/index.json")
fi
```

### 4. Append to Log

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

```json
{"ts":"<iso_timestamp>","action":"rebuild","source":"manual","pages_created":[],"pages_updated":[]}
```

### 5. Auto-Lint

After rebuilding, run an automatic health check (same as wiki-ingest auto-lint):

1. **Schema compliance** — verify all pages have required frontmatter
2. **Broken links** — check links across all pages
3. **Orphan detection** — find pages with no inbound links

**If `OBS_LIVE`**, enhance checks 2 and 3 with Obsidian CLI (same as wiki-ingest auto-lint):
- Orphan detection: `obsidian orphans` → post-filter to `<wiki_prefix>/pages/`
- Broken links: `obsidian unresolved format=json` → post-filter to `<wiki_prefix>/pages/`

> Wiki boundary filtering is mandatory for all vault-wide CLI results.

Auto-fix structural issues silently (prune excess versions, remove ghost index entries). Only report issues that need human judgment.

### 6. Release Lock and Report

Release the lock directory. Report:
- Total pages indexed
- Any pages with missing or malformed frontmatter (could not be indexed)
- Comparison: previous page count vs. current count
- Lint issues (only if any were found)
