# Wiki Storage Layout Reference

## Complete Directory Structure

```
<wiki_root>/
├── index.md                       # LLM-written catalog (wiki artifact, human-readable)
├── log.md                         # LLM-written chronicle (wiki artifact, human-readable)
├── log.jsonl                      # Append-only structured event log (machine-readable)
├── pages/                         # Wiki pages (flat, tag-based)
│   ├── welcome.md
│   ├── react-hooks.md
│   └── postgres-indexing.md
└── .wiki-meta/                    # Internal metadata (hidden from Obsidian graph)
    ├── index.json                 # v1.5.0+: M3-envelope-wrapped page catalog (derived, rebuildable)
    ├── sources/                   # Source provenance files
    │   ├── karpathy-llm-wiki.yaml
    │   └── deep-work-2026-04-06.yaml
    ├── .versions/                 # Page backups before overwrite (keep last 3)
    │   ├── react-hooks.v1.md
    │   └── react-hooks.v2.md
    ├── .wiki-lock/                # mkdir-based concurrency lock (transient)
    ├── .last-scan                 # Last committed scan window (ISO 8601 UTC, monotonic)
    ├── .pending-scan              # Oldest detection-window awaiting ingest promotion
    ├── .failed-sources.tsv        # (v1.3.0+) Path-level partial-fail retry manifest (TSV)
    ├── .pending-scan-retry-count  # (v1.3.0+) 3-strike all-workers-fail counter
    └── .config.json               # (v1.4.0+) Optional A5 fanout knobs
```

## Why This Structure?

### .wiki-meta/ is hidden

Files prefixed with `.` are hidden from Obsidian's graph view and file explorer by default. This keeps the wiki clean — users see `index.md`, `log.md`, `pages/`, and `log.jsonl` at the root level.

### index.md and log.md are wiki artifacts

Following Karpathy's philosophy, `index.md` and `log.md` are written by the LLM in natural language. They are human-readable wiki artifacts — part of the wiki itself. `index.json` and `log.jsonl` are their machine-readable counterparts for programmatic use by commands. Both pairs are maintained in parallel during ingest.

### Flat pages/ directory

The 3-way adversarial review rejected category subdirectories because:
- Categories are unstable and subjective
- Moving pages breaks links
- Tags are more flexible and multi-valued

Instead, use `tags` in frontmatter for classification. Use `/wiki-query` to filter by tag.

### log.jsonl (not monthly files)

A single JSONL file is:
- Simpler to append to atomically
- Easy to query with `grep` or `jq`
- No cross-file boundary issues

If the log grows very large (>10,000 lines), consider archiving old entries to `.wiki-meta/log-archive/`.

### index.json is derived

The index can always be regenerated from page frontmatter using `/wiki-rebuild`. This means:
- It's safe to delete and rebuild if corrupted
- It's a cache, not a source of truth
- Ingest updates it for performance, but it's never authoritative

## Source Provenance File Format

```yaml
id: karpathy-llm-wiki              # Unique slug (kebab-case)
title: "Karpathy's LLM Wiki Gist"  # Human-readable
ingested_at: "2026-04-06T15:00:00Z" # ISO 8601
type: url                           # url | file | text | deep-work-report
origin: "https://gist.github.com/karpathy/442a..."  # Where it came from
content_hash: "sha256:a1b2c3..."    # Hash at ingest time
pages_created:                      # Pages this source generated
  - llm-wiki-philosophy.md
pages_updated:                      # Pages this source modified
  - knowledge-management.md
```

## Concurrency Lock Protocol

The lock is a directory (not a file) because `mkdir` is atomic on all filesystems:

```bash
# Acquire
LOCK_DIR="<wiki_root>/.wiki-meta/.wiki-lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Wiki locked by another session"
  exit 1
fi

# Always release on exit
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# ... do work ...

# Release
rmdir "$LOCK_DIR"
```

### Trap patterns (catalog)

Invariant #3 requires acquire-before-write and release-before-end-of-critical-
section, but the **trap form** depends on whether the lock lives in one Bash
block or spans several. The Claude Code Bash tool spawns a **fresh shell per
```bash``` block**, so an `EXIT` trap registered in an acquisition block fires
the instant that block ends — releasing the lock before the next block runs.
Three patterns cover every skill; pick by lock span, not by habit.

- **Pattern 1 — single-block, unconditional-release trap.** Acquire, register
  `trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT`, mutate, and let the block
  end all in ONE `bash` block. Block exit releases the lock. Use when the whole
  critical section fits in one block. On contention, either hard `exit 1` or
  soft-skip (pattern 3) if the caller still emits a user-facing report.
  Examples: `wiki-ingest` Step 7.6.C, `wiki-query` Layer 2, `wiki-lint` §13
  Auto-Fix Phase A.

- **Pattern 2 — multi-block, failure-only trap + explicit success release.**
  When the lock must span several blocks, the acquisition block registers **no**
  `EXIT` trap (it would release too early). Instead the mutation block registers
  a trap that releases ONLY on failure (`rc != 0`), and a later block releases
  explicitly (`rmdir` + `trap - EXIT`) on success. Examples: `wiki-rebuild`
  Step 1 + Step 3/6, `wiki-query` Step 5a + Step 5d/5e.

- **Pattern 3 — contention soft-fail (WARN / return).** When a hard `exit 1` on
  a busy lock would terminate the whole script before a user-facing message or
  diagnostic sentinel is emitted, WARN to stderr and `return` non-zero instead
  of exiting. Use in function-context paths that own later cleanup. Example:
  `wiki-ingest` F1 `do_all_failed_under_lock`.

### Stale Lock Recovery

If a process crashes without releasing the lock, the directory remains. To detect stale locks:

1. Check if any Claude Code process is actively writing to the wiki
2. If no process found and lock exists for >5 minutes, it's safe to remove
3. Only the user should manually remove a stale lock: `rmdir <wiki_root>/.wiki-meta/.wiki-lock`
