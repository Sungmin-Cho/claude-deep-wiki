---
name: wiki-query
description: Answer questions from the Deep Wiki and optionally file cross-page synthesis. Triggers on /wiki-query, wiki search, grounded wiki questions.
user-invocable: true
runtime_hosts: [claude, codex]
---

# wiki-query

Answer from accumulated wiki knowledge. Deterministic reads and mutations use
structured Node argv calls; the caller performs the semantic search, reads the
selected pages, cites them, and distinguishes stored facts from inference.

## Read path

Read the envelope-aware catalog, select candidates by title, aliases, tags, and
source provenance, then read the relevant page bodies through the host's normal
read capability.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","index","read","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

Return an answer with page citations. Say when the wiki lacks enough evidence.

## Optional filing

File a result only when it combines at least two source pages, adds a durable
cross-page insight, and is substantive. Acquire the wiki owner token, prepare a
manifest in the runtime directory, and submit one transaction.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","acquire","--wiki-root","ABSOLUTE_WIKI_ROOT","--operation","query-filed","--json"]}
```

<!-- deep-wiki:data -->
```json
{"operation":"query-autofile","operation_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ82","pages":[{"file":"query-topic.md","action":"create","expected_sha256":null,"content":"VALIDATED_PAGE_CONTENT"}],"sources":[],"events":[{"event_id":"01JZ7P9Q6MD7S5PB8H4Y40HJ83","ts":"2026-07-11T00:00:00Z","action":"query-filed","source":"query-synthesis","pages_created":["query-topic.md"],"pages_updated":[]}],"refresh_index":true,"promote_pending_scan":null}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","commit","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--manifest-file","ABSOLUTE_MANIFEST_FILE","--json"]}
```

If the transaction was interrupted, recover the same operation while still
holding the same token. Recovery is idempotent and must precede any retry.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","transaction","recover","--wiki-root","ABSOLUTE_WIKI_ROOT","--lock-token","LOCK_TOKEN","--operation-id","01JZ7P9Q6MD7S5PB8H4Y40HJ82","--json"]}
```

Release only with the matching token in a guaranteed final step. On error,
preserve the prior page, catalog, and lifecycle record.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","release","--wiki-root","ABSOLUTE_WIKI_ROOT","--token","LOCK_TOKEN","--json"]}
```
