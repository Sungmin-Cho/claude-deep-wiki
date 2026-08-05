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
version pruning, and a bounded shared terminal-pruner pass. Its ordinary tail
reclaims only age-eligible, cleaned `scan-window ensure` journals. If initial
inspection finds authenticated terminal-prune residue, the same call first
resumes that residue across scan-window kinds without applying the ordinary age
gate, then retries inspection before committing the lint result. Audit-only
findings remain reported rather than guessed.

Before repair, both `.pending-scan` and `.last-scan` are classified strictly.
Either initial-invalid marker suppresses every `created`, `preserved`, and
`stale` ensure deletion for that lint invocation, including authenticated
already-started residue, even when repair removes the invalid marker.
Authenticated already-started residue remains protected until a later
invocation begins with both markers accepted or absent. Both accepted-or-absent
physical seals are revalidated before every destructive boundary. A `created`
ensure is reclaimable only when pending does not match its
proposal and exact canonical `.last-scan >= input.proposed`; `preserved` and
`stale` are no-op evidence. Any raw
`.reservation-.prune-*` basename is unsupported and requires stopped-host
intervention before generic transaction cleanup mutates a sibling.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","lint","fix","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}
```

The JSON result also carries `removed_junk` — the OS/sync-client metadata files this invocation
reclaimed from the transaction store — and `removed_junk_complete`. Rerun while
`removed_junk_complete` is `false`: recognized metadata remains, either because one bounded pass
reached its limit or because a foreign process still holds a file. Remaining metadata never blocks
readers, so this is reclamation progress, not a repair failure.

Nested terminal and quarantine regular metadata is different: the terminal
pruner reclaims it only while the current owner and the complete directory
identity chain remain proved. Nested cleanup is internal prerequisite work and
is never added to `removed_junk`; its public progress is
`terminal_prune.complete`. A held regular metadata file leaves
`terminal_prune.complete` false and preserves every later journal, backup,
reservation, operation, and quarantine boundary for a fresh retry. A
non-regular recognized name remains a recovery condition and is never followed
or removed.

Regular OS-metadata files in content catalogs (`pages/`, `.wiki-meta/sources/`, and `.wiki-meta/.versions/`) are skipped by readers and reported in `ignored_os_metadata`; content-catalog files are never deleted or reclaimed. Junk-named symlinks, directories, and entries whose type cannot be resolved remain fail-closed. `removed_junk` remains transaction-store-only.

The JSON result includes `terminal_prune` for every non-skipped invocation. A
`suppressed_reason` of `initial-invalid-scan-marker` means the invocation
finished no recovery residue and preserved all ensure-journal evidence selected
under the initial invalid marker state. If the defect was syntactic in an
otherwise readable, identity-stable, one-link regular marker, repair may have
removed it; inspect the repair and rerun to resume eligible reclamation. If
recovery makes no progress, stop all hosts and follow the stopped-host
procedure instead of repeatedly retrying.
Physically ambiguous scan-marker representations are not repaired by this pass;
stop all hosts and correct the marker before rerunning. Rerun immediately with a fresh
deadline while `terminal_prune.complete` is `false`, after a recovery pass incomplete
error (with zero or positive progress), or after a recovery pass completed error whose
underlying diagnosis is `DEADLINE_EXCEEDED`. Correct the
reported condition before rerunning after residue-recovery or post-commit
maintenance failure. For a completed recovery pass followed by
`WIKI_STATE_INVALID`, resolve that independent diagnosis first. For
`TRANSACTION_RECOVERY_REQUIRED`, use the state-specific manifest `transaction
recover` path or the stopped-host procedure instead of assuming scan-window
residue. A terminal scan-window prune quarantine blocks snapshot or commit
inspection until this repair path completes it.

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
