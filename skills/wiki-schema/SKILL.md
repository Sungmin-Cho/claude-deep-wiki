---
name: wiki-schema
description: Defines schema, invariants, and lifecycle rules for any deep-wiki knowledge base operation. Activate whenever wiki pages or metadata are read, created, modified, or validated — specifically during /wiki-ingest, /wiki-query (including auto-filing of cross-page synthesis), /wiki-lint, /wiki-rebuild, /wiki-setup, page frontmatter validation, source provenance tracking, or any direct manipulation of pages/, index.json, log.jsonl, sources/, or .versions/ under a wiki root. Covers required frontmatter fields, kebab-case naming, markdown link conventions, source provenance YAML, M3-envelope-wrapped index.json catalog, append-only log.jsonl event log with 10 lifecycle actions (ingest, ingest-skip, ingest-repair, ingest-fail, update, lint, rebuild, delete, query-filed, setup), mkdir-based concurrency locking, page versioning, and the 4 critical invariants (pages_created exactly-once, .last-scan monotonicity, lock atomicity, source provenance correspondence).
---

# Wiki Schema — Core Rules for Wiki Management

Follow these rules for all wiki operations (ingest, query, lint, rebuild).

## Philosophy

Based on Karpathy's LLM Wiki model: instead of re-discovering knowledge each time (RAG), maintain a persistent markdown wiki where knowledge accumulates. The wiki is the artifact, not the conversation.

Three layers:
1. **Raw Sources** — Immutable inputs (files, URLs, text, reports)
2. **Wiki** — LLM-managed markdown pages (the accumulated knowledge)
3. **Schema** — This skill. Rules governing how the wiki is maintained.

## Wiki Root

The wiki root path is configured in the user's profile at `~/.claude/deep-wiki-config.yaml`. Read this file to determine the wiki location before any operation.

```yaml
# ~/.claude/deep-wiki-config.yaml
wiki_root: ~/path/to/wiki    # Required
```

## Storage Layout

```
<wiki_root>/
├── index.md                          # LLM-written human-readable catalog (wiki artifact)
├── log.md                            # LLM-written human-readable chronicle (wiki artifact)
├── log.jsonl                         # Append-only structured event log (machine-readable)
├── pages/                            # Wiki pages (flat, tag-based classification)
└── .wiki-meta/
    ├── index.json                    # v1.5.0+: M3-envelope-wrapped page catalog (derived, rebuildable)
    ├── sources/                      # Per-source provenance YAML files
    ├── .versions/                    # Page backups before overwrite (keep last 3)
    ├── .wiki-lock/                   # mkdir-based concurrency lock (transient)
    ├── .last-scan                    # Last committed scan window (ISO 8601 UTC, monotonic)
    ├── .pending-scan                 # Oldest detection-window awaiting ingest promotion
    ├── .failed-sources.tsv           # (v1.3.0+) Path-level partial-fail retry manifest
    ├── .pending-scan-retry-count     # (v1.3.0+) 3-strike all-workers-fail counter
    └── .config.json                  # (v1.4.0+) Optional A5 fanout knobs
```

`index.md` and `log.md` are **wiki artifacts** — written by the LLM in natural language for human readers. `index.json` and `log.jsonl` are their machine-readable counterparts for programmatic use.

## Invariants

These four invariants MUST NEVER be violated by any wiki operation. They are the foundation of the wiki's audit, recovery, and concurrency guarantees — breaking them causes data loss, ambiguous history, or stuck-state.

1. **`pages_created` exactly-once across log** — Any page filename appears in `pages_created` arrays at most once across the entire `log.jsonl` history (including within a single multi-source batch). `ingest-repair` lines are exempt: they always carry `pages_created: []` because a self-repair restores an existing page's lifecycle rather than creating a new one. The historical `ingest` line is the canonical creation record. Enforced by `skills/wiki-lint/SKILL.md` Step 6 LOG-INVARIANT scan (with `select(.action != "ingest-repair")` filter) and the v1.2.0+ intra-batch dedup in `skills/wiki-ingest/SKILL.md`.

2. **`.last-scan` monotonic** — `<wiki>/.wiki-meta/.last-scan` MUST NEVER regress (timestamp can only advance or stay equal). Regression would let the SessionStart hook re-detect already-ingested files OR lose detection of files whose mtime falls between the lowered bound and the prior bound. Enforced by the v1.1.4 promotion regression guard in `skills/wiki-ingest/SKILL.md`'s promote block. The promotion write itself is atomic (temp + rename), so an interrupted write never leaves `.last-scan` truncated. `.pending-scan` has a parallel guarantee — once written with a valid ISO 8601 value it is preserved verbatim until promoted (H1 regression guard from ultrareview bug_006; tested by `tests/pending-scan-recovery.test.js` v1.5.2+).

3. **Lock atomicity** — All write operations MUST acquire `mkdir <wiki>/.wiki-meta/.wiki-lock` before touching any wiki state, and release via `trap 'rmdir' EXIT`. `mkdir` is the single atomic primitive that guarantees mutual exclusion across all filesystems. Enforced at: `skills/wiki-ingest/SKILL.md` (Step 7.6.C / Step 7.5.M-C), `skills/wiki-rebuild/SKILL.md` Step 1, `skills/wiki-query/SKILL.md` (Layer 2), `skills/wiki-lint/SKILL.md` (§13 Auto-Fix / Phase A). See `references/storage-layout.md` for the full protocol + stale-lock recovery.

4. **Source provenance correspondence** — Every wiki page frontmatter `sources:` slug MUST have a corresponding `<wiki>/.wiki-meta/sources/<slug>.yaml` file on disk. The yaml is the authoritative provenance record (log-based audit reconstruction may be incomplete when log absence triggered `ingest-repair`). Enforced by `skills/wiki-lint/SKILL.md` Step 7 Source Provenance Check.

## Page Rules

### Structure

Every wiki page MUST have this frontmatter (see `templates/page-template.md`):

```yaml
---
title: "Page Title"
sources:
  - source-slug-1
tags:
  - tag-name
aliases: []
---
```

- `title`: Human-readable page title
- `sources`: List of source slugs that contributed content to this page
- `tags`: Classification tags (use instead of directory-based categories)
- `aliases`: Alternative names for this concept (prevents duplicate pages)

### Naming

- Use **kebab-case** filenames: `react-hooks.md`, `postgres-indexing.md`
- Flat structure within `pages/` — no subdirectories
- Before creating a new page, check `index.json` for existing pages with matching titles or aliases to prevent duplicates

### Linking

- Use standard markdown links: `[Page Title](page-name.md)`
- Do NOT use Obsidian wikilinks `[[...]]` in page content (portability)
- Cross-references go in the page body, NOT in frontmatter `related` fields

### Timestamps

- Do NOT put `created` or `updated` in frontmatter — these are tracked in `log.jsonl`
- To find when a page was created/updated, query `log.jsonl`

## Source Provenance

For each ingested source, create a YAML file at `.wiki-meta/sources/<slug>.yaml`:

```yaml
id: karpathy-llm-wiki
title: "Karpathy's LLM Wiki Gist"
ingested_at: "2026-04-06T15:00:00Z"
type: url
origin: "https://gist.github.com/karpathy/442a6bf..."
content_hash: "sha256:abc123..."
pages_created:
  - llm-wiki-philosophy.md
pages_updated: []
# Optional (v1.4.0+) — `partial_fail` sentinel, written by /wiki-ingest
# Step 7.6.F when any page in an A5 fanout run fails. Removed on
# repair-on-success (Case ii). Drives Step 1.5 hash-skip override →
# `partial-fail-recovery` repair_reason on next session.
# partial_fail:
#   ts: "2026-05-05T10:30:00Z"
#   failed_pages: [react-hooks.md]
#   reason: "synthesizer worker timeout"
```

The `content_hash` field stores a hash of the source content at ingest time, enabling future re-ingest detection.

## Index

`.wiki-meta/index.json` is a machine-readable catalog. Since v1.5.0 it is
wrapped in the M3 cross-plugin envelope (cf. claude-deep-suite/docs/
envelope-migration.md §1) — the legacy `{pages, generated_at}` shape lives
inside `payload`. Producers use `hooks/scripts/wrap-index-envelope.js` to
emit; consumers use `hooks/scripts/read-index-envelope.js` to unwrap.

**Envelope-wrapped (v1.5.0+):**

```json
{
  "$schema": "https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json",
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-wiki",
    "producer_version": "1.5.0",
    "artifact_kind": "index",
    "run_id": "01JTKZQ7N3ABCDEFGHJKMNPQRS",
    "generated_at": "2026-05-11T10:00:00Z",
    "schema": { "name": "index", "version": "1.0" },
    "git": { "head": "abc1234", "branch": "main", "dirty": false },
    "provenance": {
      "source_artifacts": [
        { "path": "pages/react-hooks.md" }
      ],
      "tool_versions": { "node": "v20.11.0" }
    }
  },
  "payload": {
    "pages": [
      {
        "file": "react-hooks.md",
        "title": "React Hooks",
        "tags": ["programming", "react"],
        "aliases": ["hooks", "useState"]
      }
    ],
    "generated_at": "2026-05-11T10:00:00Z"
  }
}
```

**Legacy (pre-1.5.0, still readable):**

```json
{
  "pages": [
    {
      "file": "react-hooks.md",
      "title": "React Hooks",
      "tags": ["programming", "react"],
      "aliases": ["hooks", "useState"]
    }
  ],
  "generated_at": "2026-04-06T15:00:00Z"
}
```

This file is **derived** — it can always be rebuilt from page frontmatter using `/wiki-rebuild`. Update it during ingest, but never treat it as the source of truth.

**Envelope contract:**

- `producer === "deep-wiki"`, `artifact_kind === "index"`, `schema.name === "index"`
  (3-way identity guard enforced by `unwrapEnvelope()` — handoff §4 round-4).
- `producer_version` mirrors `.claude-plugin/plugin.json.version` (single source of truth).
- `run_id` is a 26-char Crockford Base32 ULID per ULID spec (lex sort = time sort).
- **Multi-source aggregator**: `parent_run_id` is omitted by default — index.json
  is built by scanning every page's frontmatter, no single source artifact
  acts as parent. Pages are recorded in `provenance.source_artifacts[]`
  path-only (markdown — no envelope detect).
- The payload shape is unchanged from pre-1.5.0; tools that read
  `index.json` use `read-index-envelope.js` which unwraps the envelope or
  passes legacy through transparently.

## Event Log

`log.jsonl` is append-only. Each line is one event:

```json
{"ts":"2026-04-06T15:00:00Z","action":"ingest","source":"karpathy-llm-wiki","pages_created":["llm-wiki-philosophy.md"],"pages_updated":[]}
```

### Actions (10 total)

All valid `action` values. The first three (`ingest`, `ingest-skip`, `ingest-repair`) drive `/wiki-ingest`'s self-healing logic; `ingest-fail` is the 3-strike escape hatch. Auto-lint runs after every state-changing action — see `wiki-schema.yaml` `auto_lint.trigger_after`.

- **`ingest`** — Normal processing path. New/updated pages emit. v1.4.0+ adds optional `pages_failed: [<file>...]` field (A5 fanout partial-fail audit); v1.4.2+ adds optional `phase_timing_ms: {stage_1_analysis, stage_2_fanout, stage_3_write, total}` ms-int telemetry. Both fields are schema-additive and ignored by `/wiki-lint` Step 6 LOG-INVARIANT scan.
- **`ingest-skip`** (v1.2.0+) — Source dropped from batch because `content_hash` unchanged AND wiki-side state intact (no missing pages, no log drift).
- **`ingest-repair`** (v1.2.0+, expanded v1.2.1+) — `content_hash` unchanged BUT wiki state drift detected → full ingest forced as self-repair. MUST carry `pages_created: []` (the historical `ingest` line is the canonical creation record); all touched pages go to `pages_updated`. Triggered by `missing-page`, `page-missing-slug`, `no-prior-terminal-log`, or `partial-fail-recovery` (v1.4.0+) reasons. Filtered out by `/wiki-lint` Step 6 LOG-INVARIANT scan as defense-in-depth.
- **`ingest-fail`** (v1.3.0+) — Emitted when the all-workers-fail retry counter reaches 3 consecutive batches on the same `.pending-scan` window. Promotes the window despite failure (releases stuck state) and records affected source paths + 3 prior failure timestamps. Counter resets on any successful batch (full or partial — partial relies on `.failed-sources.tsv` for per-source retry).
- **`update`** — Direct page edit (out-of-band of `/wiki-ingest`).
- **`lint`** — `/wiki-lint` execution + auto-fix.
- **`rebuild`** — `/wiki-rebuild` index regeneration.
- **`delete`** — Page deletion.
- **`query-filed`** — `/wiki-query` produced a synthesis that drew from 2+ pages with novel cross-page insight; auto-filed back into the wiki as a `query-synthesis`-tagged page.
- **`setup`** — `/wiki-setup` initial scaffold (welcome.md seed).

## Concurrency

Acquire a `mkdir`-based directory lock at `.wiki-meta/.wiki-lock` before any write operation. Release on exit. See `references/storage-layout.md` for the full lock protocol and stale lock recovery.

## Versioning

Before overwriting an existing page, copy the current version to `.wiki-meta/.versions/<page-name>.v<N>.md`. Keep the last 3 versions. Prune older versions during auto-lint. See `references/storage-layout.md` for details.

## Auto-Lint

Lint runs **automatically** after every write operation (`wiki-ingest`, `wiki-rebuild`, and `wiki-query` auto-filing). Users do not need to invoke `/wiki-lint` manually — it is only needed for on-demand deep inspection or `--fix` on legacy issues.

Auto-lint checks: schema compliance, broken links, index drift, orphan detection. It auto-fixes structural issues (index drift, excess versions) silently and only reports issues requiring human judgment.

## Query Auto-Filing

When `/wiki-query` produces a synthesis that draws from 2+ pages and creates novel cross-page insights, the result is automatically filed back into the wiki as a `query-synthesis` tagged page. This implements Karpathy's principle that valuable query results should compound back into the wiki. Pages created this way use the `query-derived` source slug and `query-<topic>.md` naming convention.

## Additional Resources

### Schema Definition
- **`wiki-schema.yaml`** — Machine-readable schema for validation tools

### Templates
- **`templates/page-template.md`** — Required page structure template

### References
- **`references/storage-layout.md`** — Detailed storage structure rationale, source provenance format, and concurrency lock protocol
- **`references/recommended-tools.md`** — CLI tools (qmd, Marp) and Obsidian plugins (Dataview, Web Clipper) that enhance the wiki workflow
