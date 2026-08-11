# Deep Wiki storage and Node ownership protocol

## Layout

<!-- deep-wiki:data -->
```text
WIKI_ROOT/
├── pages/                         source-of-truth Markdown pages
├── index.md                       human catalog
├── log.md                         human chronicle
├── log.jsonl                      structured lifecycle records
└── .wiki-meta/
    ├── .config.json             wiki-local auto-ingest and A5 knob config
    ├── index.json                 envelope-wrapped derived catalog
    ├── sources/                   source provenance YAML
    ├── .versions/                 pre-write page versions, latest three
    ├── .wiki-lock/owner.json      authenticated live owner
    ├── .transactions/            recoverable per-operation journals
    ├── .transaction-receipts/    terminal operation receipts
    ├── .pending-scan              pending detection window
    └── .last-scan                 monotonic committed window
```

Regular OS-metadata files in content catalogs (`pages/`, `.wiki-meta/sources/`, and `.wiki-meta/.versions/`) are skipped by readers and reported in `ignored_os_metadata`; content-catalog files are never deleted or reclaimed. Junk-named symlinks, directories, and entries whose type cannot be resolved remain fail-closed. `removed_junk` remains transaction-store-only.

## Setup and auto-ingest authority

The wiki-local `.wiki-meta/.config.json` owns `auto_ingest`. The global host YAML
`auto_ingest` is only a bootstrap/legacy alias; the runtime migrates equivalent
legacy policy into the wiki-local file before SessionStart scanning. Conflicting
local and legacy policies fail closed. Accepted wiki-local keys are
`auto_ingest`, `a5_fanout_threshold`, and `a5_worker_timeout_sec`; migration
preserves A5 keys while moving only `auto_ingest` ownership. The ignore globs
are vault-relative inside `auto_ingest`. Non-regular file, symlink, duplicate
key, invalid UTF-8, or >64 KiB wiki-local config state is `CONFIG_INVALID`.
`CONFIG_CONFLICT` recovery is to make local and legacy values match, or delete
one policy block while all hosts are stopped. Remove legacy YAML only after
`policy_source=wiki_local_migrated`, then re-resolve and confirm
`policy_source=wiki_local`.

Stop all hosts before direct edit of global YAML, wiki-local JSON, setup
authority, or route-created paths, then restart one host and let the runtime
revalidate. `--replace-config` does not bypass invalid selected-host YAML; the
selected host file must first be repaired or removed under stopped-host
conditions. Divergent `CODEX_HOME` or `HOME` values create separate
setup-authority domains, so a shared wiki should use one physical home and one
host configuration route. `.deep-wiki-setup-authority.json` and
`.deep-wiki-setup.reserve` are home authority artifacts, never SessionStart
config candidates; they live in the selected home. A wiki move is an explicit
stopped-host rebind; rebind resumes require the original `CODEX_HOME` and
`DEEP_WIKI_CONFIG` spelling from the pending rebind so the same candidate vector
is revalidated. Rollback uses backup-only downgrade after current-version
recovery; older versions do not perform in-place recovery of newer state.

## Concurrency Lock Protocol

The portable Node runtime uses atomic directory creation as the mutual-
exclusion primitive. A successful `lock acquire` writes `owner.json` and
returns an unpredictable owner token. Every mutating runtime call requires and
revalidates that token, owner record, same-host process identity, and lock
directory identity immediately before mutation.

The supported operation catalog is:

1. `lock acquire`: atomically reserve the wiki and return the owner token.
2. `lock status`: inspect contention without mutation.
3. `lock release`: remove only the lock owned by the exact token and identity.
4. `lock recover`: remove a stale lock only after structural, liveness, age,
   owner-equality, and directory-identity validation. Force bypasses age only.

Callers never use shell traps or direct directory removal. They release in a
guaranteed final step. A crash intentionally leaves authenticated state for
recovery rather than risking release of a replacement owner's lock. The next
ordinary acquisition may reclaim that state without an age delay only after
the complete owner is structurally valid, same-host, and proved dead;
otherwise `lock recover` remains the explicit operator route.

## Journal protocol

A manifest-backed `commit` writes one operation intent beneath
`.wiki-meta/.transactions/<operation_id>/journal.json`, verifies expected hashes, applies all page,
version, provenance, catalog, and lifecycle changes, then records a terminal
state. `transaction recover` accepts the same operation ID and owner token and
is idempotent. It either completes the recorded operation or restores the
pre-operation state; it never invents a new action.

The shared bounded terminal cleanup operation is called by
`scan-window ensure`, `wiki-lint --fix`, and the singular operator
`transaction prune` command. With the caller's current owner token, ordinary selection removes only
structurally valid scan-window journals whose final transition is `cleaned`,
whose directory contains no other entry, and whose journal age exceeds the
caller's age policy. A lint recovery pass bypasses that ordinary age gate only
for authenticated residue from an already-started prune and skips every
ordinary transaction directory. Before unlinking, the runtime
atomically moves the complete transaction directory into a fresh identity-bound
sibling quarantine and revalidates the directory plus journal identity, bytes,
age, and link count there. An interrupted quarantine remains recognizable and
is retried by a later bounded pass. An exact journal-copy reservation closes
the canonical source generation through quarantine removal, and an exact
fsynced backup preserves authenticated evidence after the original journal
unlink. Both use exclusive crash-recoverable pending publication. Later
bounded passes resume partial publications, backup-only or empty quarantines,
and orphaned exact reservations, checking the deadline across discovery,
validation, and recoverable mutation phases. It preserves in-flight,
malformed, foreign-kind, linked, young, and otherwise ambiguous entries.
Recognized direct-child metadata inside a terminal operation or its quarantine
is reclaimed only as a plain regular file under the current owner plus the
physical `.wiki-meta`, `.transactions`, and direct-child directory identity
proofs. These nested removals consume the same bounded terminal-prune budget
but do not enter top-level `removed_junk`; a held file makes `complete` false
before later authenticated evidence can be removed. A recognized name with a
non-regular representation remains a recovery condition and is never followed
or removed.
Repeat the command while `complete` is `false` to traverse more than one bounded
pass. `complete: true` means every entry listed for that pass was inspected; it
does not claim that ambiguous entries were removed.
Ensure deletion additionally requires strict marker authority. Exact canonical
UTC-Z plus LF, one-link regular non-symlink marker files are accepted; lstat
`ENOENT` alone is absent. Either initial-invalid marker suppresses every
`created`, `preserved`, and `stale` ensure deletion for the pass, including
authenticated already-started residue. Authenticated already-started residue
remains protected until a later pass begins with both markers accepted or
absent. Both physical marker seals for accepted-or-absent state are revalidated at every
destructive boundary; unreadable or physically ambiguous state stays
protected. A `created` ensure needs
nonmatching pending plus exact `.last-scan >= input.proposed`; `preserved` and
`stale` are no-op evidence. Raw
`.reservation-.prune-*` basenames are rejected before type, suffix, or content
parsing and require stopped-host intervention.
This terminal-prune recovery authority is distinct from manifest `transaction
recover`. Unaccepted or ambiguous residue requires stopped-host manual
intervention rather than a broader deletion rule. Terminal-prune residue blocks
snapshot and commit inspection until the shared lint repair path completes it.

## Scan windows

`.pending-scan` is the oldest uncommitted detection window. After a successful
ingest, `scan-window promote` compares its authenticated expected value and
advances `.last-scan` monotonically. A mismatch fails closed. `scan-window fail`
preserves retry state on attempts one and two. On attempt three it first commits
one terminal `ingest-fail` journal event, then promotes the matching window; a
failed terminal commit leaves the pending window and retry counter intact.

## Derived state and versions

Pages and provenance are authoritative. Catalogs and chronicles change only as
part of the same journaled commit. Page replacement stores a prior version; the
latest-three retention rule is enforced only while a valid owner token is held.
