---
name: wiki-lint
description: Inspect or repair Deep Wiki structure, links, provenance, lifecycle invariants, and scan-window state. Triggers on /wiki-lint, wiki health checks, audits, --fix repair.
user-invocable: true
runtime_hosts: [claude, codex]
---

# wiki-lint

Run a host-neutral health check. The default path is read-only and reports drift
in page schema, links, provenance, catalog, orphans, lifecycle, version
retention, and the scan window.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lint","inspect","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

Present a compact dashboard grouped into errors, warnings, and informational
items. Never call a repair merely because inspection completed.

## Repair mode

With an explicit `--fix`, call the self-locking repair operation. It owns token
acquisition, expected-hash checks, journal recovery, safe catalog regeneration,
and version pruning. Audit-only findings remain reported rather than guessed.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lint","fix","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

If repair reports contention, inspect the current owner. Never delete a lock
directory directly.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","status","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

Only after the owner is invalid or dead and the age policy is satisfied may the
user request runtime recovery. `--force` bypasses age only, never owner or
same-host liveness validation.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lock","recover","--wiki-root","ABSOLUTE_WIKI_ROOT","--stale-ms","300000","--json"]}
```
