---
name: wiki-ingest
description: Ingest files, URLs, pasted text, or Deep Work reports into the Deep Wiki. Triggers on /wiki-ingest, wiki updates, SessionStart change ingestion.
user-invocable: true
runtime_hosts: [claude, codex]
codex_agent_fanout: disabled_for_1.8.0
---

# wiki-ingest

Turn source material into durable, source-grounded wiki pages. You select and
synthesize; `<plugin_root>/scripts/wiki-runtime.js` owns every deterministic operation, called
as structured argv with no shell wrapper. Page, provenance and lifecycle rules
are in the `wiki-schema` skill.

## 1. Resolve and inspect

Resolve the shared Claude/Codex configuration. Missing or conflicting targets
are hard errors.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","config","resolve","--json"]}
```

Capture one consistent read-only snapshot before planning. It includes the
envelope-aware catalog, lifecycle state, provenance, and pending scan window.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","snapshot","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

If snapshot exits `DEADLINE_EXCEEDED` or `TRANSACTION_RECOVERY_REQUIRED`
while inspecting transaction state, do not delete or rewrite that evidence.
The timeout result states whether worker-tree termination was requested but
unconfirmed, or could not be requested or confirmed. Never infer that either
result means the worker or its descendants have exited. Stop all hosts, restore
filesystem readability, rerun snapshot, and only then recover any authenticated
nonterminal operation reported by the runtime.

Normalize each input into a source record. Preserve its origin, type, title,
content hash, and exact excerpts used. Reject secrets, unsupported binary data,
or a source that cannot be read. An unchanged hash may be skipped only when its
pages, provenance, and last terminal lifecycle record are intact; otherwise
perform an ingest repair.

### Obsidian-assisted context (optional)

When the resolved configuration reports `obsidianCli.enabled: true`, enrich the
analysis with read-only vault context: merge candidates beyond the changed
files, notes referencing an ingested source, and the existing tag taxonomy.
Every call is optional and every failure is informational — fall back to direct
file reads, and never block, fail, or alter ingest state because of it.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","obsidian","search","--query","QUERY_TEXT","--limit","20","--json"]}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","obsidian","backlinks","--path","VAULT_NOTE_PATH","--json"]}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","obsidian","tags","--json"]}
```

## 2. Host routing

Both hosts use identical page-plan and manifest schemas.

| Role | Claude Code | Codex 1.8.0 |
|---|---|---|
| single-source analysis | qualified `deep-wiki:wiki-synthesizer-analysis` | main caller performs analysis inline |
| multi-source or collision analysis | qualified `deep-wiki:wiki-synthesizer-worker` | main caller processes inputs one at a time |
| page body generation | qualified `deep-wiki:wiki-page-writer` | main caller synthesizes and validates one body at a time |

Claude Code may fan out only to those three qualified names. A named-agent resolution error must fail the affected work; there is no unqualified or generic fallback. `wiki-synthesizer-inline` is dormant and is never dispatched.

For Codex, `codex_agent_fanout: disabled_for_1.8.0` is unconditional. The main
caller fixes the page-plan sequence once in stable input order, then for each
plan completes analysis, writes the body, validates the unchanged JSON output
schema, and appends the validated manifest entry in memory before advancing. It
never launches a child. This can be slower on large sources, but the committed
semantics and failure behavior match Claude Code.

The inert policy record below is the authority for that loop: apply its listed
phases to each plan, in order, before advancing.

<!-- deep-wiki:data -->
```json
{"codex_route":{"mode":"main-caller-sequential","child_agents":false,"input_order":"stable","per_plan_phases":["analyze","write","validate"]}}
```

## 3. Semantic contracts

For every proposed page:

- Ground every claim in supplied source excerpts or preserved existing text.
- Use kebab-case `.md` filenames and required frontmatter: `title`, `sources`,
  `tags`, and optional `aliases`.
- Reuse a matching title or alias rather than creating a duplicate.
- Preserve unrelated existing sections and standard Markdown links.
- Classify a page as created only if it has never appeared as created in the
  lifecycle history; repairs update existing lifecycle state.
- Produce source provenance for every slug referenced by a page.
- Validate every page plan/body and the complete manifest before mutation.

The shared manifest shape is:

<!-- deep-wiki:data -->
```json
{"operation":"ingest","operation_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ80","pages":[{"file":"topic.md","action":"create","expected_sha256":null,"content":"VALIDATED_PAGE_CONTENT"}],"sources":[{"slug":"source-slug","content":"id: source-slug\ntitle: Source title\ntype: file\norigin: NATIVE_SOURCE_PATH\n"}],"events":[{"event_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ81","ts":"2026-07-11T00:00:00Z","action":"ingest","source":"source-slug","pages_created":["topic.md"],"pages_updated":[]}],"refresh_index":true,"promote_pending_scan":null}
```

## 4. Commit under one owner token

Acquire the lock after planning and before any mutation. Revalidate snapshot
hashes after acquisition so concurrent changes cannot be overwritten.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","acquire","--wiki-root","ABSOLUTE_WIKI_ROOT","--operation","ingest","--json"]}
```

When processing hook inbox data, clean only expired runtime entries while the
token is held.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","inbox","cleanup","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--max-age-days","7","--json"]}
```

Write the validated manifest as a regular, non-symlink file inside the wiki
runtime directory, then submit one journaled commit. The state engine owns page
backups, atomic writes, provenance, catalog refresh, human and machine lifecycle
representations, and rollback.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","commit","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--manifest-file","ABSOLUTE_MANIFEST_FILE","--json"]}
```

For an interrupted commit, recover the same operation before retrying; recovery
is idempotent and token-authenticated.

Every runtime call carries an internal 12-second deadline. On a large or slow
(sync-drive) vault one `commit` can exceed it and exit `DEADLINE_EXCEEDED at
<boundary>`, with the progress made so far durable in the journal. Recovering
the same operation id until it returns a result is the normal path — it may take
several resumable calls, and the error output carries the exact recover argv.

If an unchanged catalog file is changed or deleted externally mid-commit, the
transaction is cancelled with `TRANSACTION_CANCELLED` (exit 4): torn down, no
receipt written, and the wiki left in its pre-commit state with the external edit
preserved rather than clobbered. Re-snapshot and resubmit the same manifest, then
run `/wiki-lint` to surface any `MISSING_SOURCE` the external change left behind.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","transaction","recover","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--operation-id","01JZ7P9Q6MD7S5PB8H4Y40HJ80","--json"]}
```

After a successful hook-driven batch, promote exactly the pending window read
from the snapshot. `.last-scan` is monotonic; a changed expected value is a
conflict rather than permission to overwrite.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","scan-window","promote","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--expected","EXPECTED_PENDING_UTC_Z","--json"]}
```

If a source or page fails, register it under the same token. The first two
failures preserve the pending window for retry. The third failure journal-commits
one terminal `ingest-fail` record and only then promotes the window, preventing a
permanently stuck session without losing the terminal audit. Partial success
commits only validated entries and retains explicit per-source failure state.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","scan-window","fail","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--source","SOURCE_SLUG","--json"]}
```

Release the matching token in a guaranteed final step. Token mismatch is a hard
error and never authorizes removal of another owner.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","release","--wiki-root","ABSOLUTE_WIKI_ROOT","--token","LOCK_TOKEN","--json"]}
```

## 5. Report

Report created, updated, skipped, repaired, and failed pages; source provenance;
pending-window disposition; and transaction operation ID. Run post-ingest
health inspection read-only. Repairs require an explicit `/wiki-lint --fix`.
