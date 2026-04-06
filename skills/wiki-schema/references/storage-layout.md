# Wiki Storage Layout Reference

## Complete Directory Structure

```
<wiki_root>/
├── index.md                       # LLM-written catalog (wiki artifact, human-readable)
├── log.md                         # LLM-written chronicle (wiki artifact, human-readable)
├── .wiki-meta/                    # Internal metadata (hidden from Obsidian graph)
│   ├── index.json                 # Machine-readable page catalog (derived, rebuildable)
│   ├── sources/                   # Source provenance files
│   │   ├── karpathy-llm-wiki.yaml
│   │   └── deep-work-2026-04-06.yaml
│   ├── .versions/                 # Page backups before overwrite
│   │   ├── react-hooks.v1.md
│   │   └── react-hooks.v2.md
│   └── .wiki-lock/                # Directory-based lock (transient)
├── log.jsonl                      # Append-only structured event log (machine-readable)
└── pages/                         # Wiki pages (flat, tag-based)
    ├── welcome.md
    ├── react-hooks.md
    └── postgres-indexing.md
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

### Stale Lock Recovery

If a process crashes without releasing the lock, the directory remains. To detect stale locks:

1. Check if any Claude Code process is actively writing to the wiki
2. If no process found and lock exists for >5 minutes, it's safe to remove
3. Only the user should manually remove a stale lock: `rmdir <wiki_root>/.wiki-meta/.wiki-lock`
