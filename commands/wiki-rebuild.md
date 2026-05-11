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
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo "ERROR: Wiki is locked by another session."; exit 1; }
```

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

**Step 3.a — Build payload (legacy shape inside `payload`):**

Caller MUST set `WIKI_ROOT` (absolute path) before invoking the snippet
(Bash tool spawns a fresh shell per invocation — deep-evolve round-2 R2-3
self-containedness lesson). The payload structure is identical to pre-1.5.0
`index.json` (no schema changes), so wiki-lint/wiki-query etc. that already
operate on `.pages[]` continue to work after envelope-aware unwrap.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"

# Pages array is sorted alphabetically by filename, built from Step 2 scan.
# (Below is a structural template — caller substitutes actual page entries.)
PAYLOAD_TMP="${WIKI_ROOT}/.wiki-meta/index.payload.tmp.$$.$(date +%s).json"
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
```

**Step 3.b — Envelope-wrap and atomic write:**

Multi-source aggregator: every scanned page contributes one `--source-page`
entry (path relative to `<wiki_root>`, e.g. `pages/react-hooks.md`). Pages
are markdown → recorded path-only (no envelope detect). `parent_run_id` is
omitted (multi-source aggregator default). Helper writes atomically (temp +
rename); cleanup is gated on helper success (deep-work round-1 C1+C2 lessons).

```bash
# Collect --source-page args from scanned pages. macOS BSD `find` lacks
# `-printf`, so we cd into ${WIKI_ROOT} inside a subshell and rely on the
# already-relative `pages` prefix in the search root. Portable to both BSD
# (macOS default) and GNU (Linux) find. The subshell isolates the cd from
# the outer script's cwd; `set -euo pipefail` interactions are safe because
# the failure of the inner find would surface via empty SOURCE_PAGE_ARGS
# (which the helper accepts but is structurally incorrect; downstream tests
# in tests/envelope-chain.test.js verify the multi-source contract).
SOURCE_PAGE_ARGS=()
while IFS= read -r REL; do
  [ -n "$REL" ] && SOURCE_PAGE_ARGS+=(--source-page "$REL")
done < <(cd "${WIKI_ROOT}" 2>/dev/null && find pages -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)

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
