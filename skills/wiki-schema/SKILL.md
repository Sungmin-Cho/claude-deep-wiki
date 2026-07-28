---
name: wiki-schema
description: Canonical Deep Wiki page, provenance, lifecycle, concurrency, and recovery rules. Apply whenever reading, creating, updating, rebuilding, linting, or querying wiki state.
---

# Wiki schema

The wiki is the durable artifact. LLM callers may interpret and synthesize
knowledge, but `<plugin_root>/scripts/wiki-runtime.js` is the sole authority for deterministic
configuration, lock ownership, versioning, journaled mutation, derived state,
and scan-window transitions on every supported host.

## Storage

<!-- deep-wiki:data -->
```text
WIKI_ROOT/
  pages/
  index.md
  log.md
  log.jsonl
  .wiki-meta/
    index.json
    sources/
    .versions/
    .wiki-lock/owner.json
    .transactions/OPERATION_ID/journal.json
    .transaction-receipts/OPERATION_ID.json
    .pending-scan
    .last-scan
```

Pages and source provenance are authoritative. `.wiki-meta/index.json`,
`index.md`, `log.jsonl`, and `log.md` are transactionally maintained
representations. A caller never mutates one representation independently.

## Page and provenance rules

Every page is a flat kebab-case `.md` file with `title`, `sources`, and `tags`
frontmatter plus optional `aliases`. Use standard Markdown links. Each source
slug on a page must correspond to `.wiki-meta/sources/SLUG.yaml` containing an
ID, title, type, origin, ingestion time, and created/updated page lists.

## Critical invariants

1. A page filename appears in `pages_created` at most once across lifecycle
   history. Repair actions restore existing pages and classify them as updates.
2. `.last-scan` is monotonic. Promotion succeeds only when the authenticated
   pending value equals the expected UTC value.
3. **Lock atomicity**: every mutation requires an owner token returned by Node
   directory acquisition. `.wiki-lock/owner.json` binds token, operation,
   process, host, start time, and lock identity. Release and recovery revalidate
   full ownership; direct directory deletion is forbidden. The canonical
   operation catalog is in `<plugin_root>/skills/wiki-schema/references/storage-layout.md` and applies to
   wiki-ingest, wiki-query, wiki-rebuild, and wiki-lint.
4. Every page source slug has a corresponding provenance record.
5. A transaction operation ID is stable across retry and journal recovery.
   Expected hashes prevent concurrent updates from being overwritten.

## Lock recovery

Use `wiki-runtime.js lock status` to inspect contention. Use `wiki-runtime.js
lock recover` only when the stored owner is structurally valid, the same-host
process is no longer live, the directory identity still matches, and the age
policy is met. `--force` bypasses age only. `owner.json` and the owner token are
capabilities, not informational labels.

## Journal and atomic commit

One manifest-backed commit owns page writes, version backups, source records,
catalog refresh, and lifecycle records. The runtime writes a journal intent,
applies expected-hash-guarded changes, and records terminal state. An
interruption is resolved with `wiki-runtime.js transaction recover` using the
same owner token and operation ID; a caller never creates split mutations.
`wiki-runtime.js transaction prune` removes only fully validated, terminal
scan-window journals older than the requested age while the caller still owns
the lock. The command is bounded; rerun it until `removed` is empty when a
larger backlog must be retired. In-flight, malformed, foreign-kind, linked, or
otherwise ambiguous transaction directories are preserved.

Valid lifecycle actions are `ingest`, `ingest-skip`, `ingest-repair`,
`ingest-fail`, `update`, `lint`, `rebuild`, `delete`, `query-filed`, and
`setup`. Timestamps are ISO 8601 UTC with a `Z` suffix.

## Versioning

Before replacement, the transaction stores the previous page under
`.wiki-meta/.versions/`. Keep the latest three versions per page. Pruning is a
mutation and therefore occurs under the wiki lock, including `/wiki-lint --fix`.

## Auto-Lint

Post-ingest and post-rebuild lint is read-only diagnostics. It reports schema,
link, provenance, catalog, lifecycle, scan-window, and retention drift. Repair
is delegated to the self-locking `/wiki-lint --fix` path and is never silently
performed after token release.
