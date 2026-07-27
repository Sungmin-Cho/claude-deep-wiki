---
name: wiki-rebuild
description: Regenerate Deep Wiki derived catalogs from page frontmatter. Triggers on /wiki-rebuild, stale catalog repair, wiki reindexing.
user-invocable: true
runtime_hosts: [claude, codex]
---

# wiki-rebuild

Pages and provenance are authoritative; catalogs are derived. Rebuild all
derived artifacts with one transaction so no caller can expose a new catalog
without its matching lifecycle record.

## Procedure

Acquire one owner token.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","acquire","--wiki-root","ABSOLUTE_WIKI_ROOT","--operation","rebuild","--json"]}
```

Create one manifest with a stable `operation_id`. The state engine scans page
frontmatter, refreshes both human and machine derived artifacts, versions any
replaced content, and records one wiki-wide action in the same journal.

<!-- deep-wiki:data -->
```json
{"operation":"rebuild","operation_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ84","pages":[],"sources":[],"events":[{"event_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ85","ts":"2026-07-11T00:00:00Z","action":"rebuild","source":null,"pages_created":[],"pages_updated":[]}],"refresh_index":true,"promote_pending_scan":null}
```

Submit that manifest exactly once.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","commit","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--manifest-file","ABSOLUTE_MANIFEST_FILE","--json"]}
```

On interruption, inspect the owner and recover the same journaled operation;
never manufacture a second operation identifier.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","status","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","transaction","recover","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--operation-id","01JZ7P9Q6MD7S5PB8H4Y40HJ84","--json"]}
```

After terminal success, run read-only diagnostics. Any repair remains a
separate explicit `/wiki-lint --fix` request.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lint","inspect","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

Release in a guaranteed final step with the matching token.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","release","--wiki-root","ABSOLUTE_WIKI_ROOT","--token","LOCK_TOKEN","--json"]}
```
