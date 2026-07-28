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
    ├── index.json                 envelope-wrapped derived catalog
    ├── sources/                   source provenance YAML
    ├── .versions/                 pre-write page versions, latest three
    ├── .wiki-lock/owner.json      authenticated live owner
    ├── .transactions/            recoverable per-operation journals
    ├── .transaction-receipts/    terminal operation receipts
    ├── .pending-scan              pending detection window
    └── .last-scan                 monotonic committed window
```

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

The operator-only `transaction prune` command is the bounded terminal cleanup operation. With the caller's
current owner token, it removes only structurally valid scan-window journals
whose final transition is `cleaned`, whose directory contains no other entry,
and whose journal age exceeds `--max-age-days`. Before unlinking, the runtime
atomically moves the complete transaction directory into a fresh identity-bound
sibling quarantine and revalidates the directory plus journal identity, bytes,
age, and link count there. An interrupted quarantine remains recognizable and
is retried by a later bounded pass. An identity-bound reservation closes the
canonical source generation through quarantine removal, and an exact fsynced
backup preserves authenticated evidence after the original journal unlink.
Later bounded passes resume backup-only or empty quarantines and remove
orphaned active or retired reservations. It preserves in-flight,
malformed, foreign-kind, linked, young, and otherwise ambiguous entries.
Repeat the command while `complete` is `false` to traverse more than one bounded
pass. `complete: true` means every entry listed for that pass was inspected; it
does not claim that ambiguous entries were removed.

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
