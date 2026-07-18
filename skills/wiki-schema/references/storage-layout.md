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
`lock recover` rather than risking release of a replacement owner's lock.

## Journal protocol

A manifest-backed `commit` writes one operation intent beneath
`.wiki-meta/.transactions/<operation_id>/journal.json`, verifies expected hashes, applies all page,
version, provenance, catalog, and lifecycle changes, then records a terminal
state. `transaction recover` accepts the same operation ID and owner token and
is idempotent. It either completes the recorded operation or restores the
pre-operation state; it never invents a new action.

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
