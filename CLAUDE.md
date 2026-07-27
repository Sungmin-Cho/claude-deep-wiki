# deep-wiki — Project Guide for Claude

This file is **auto-loaded at the start of every new Claude session**. It contains an overview of the deep-wiki plugin, its structure, and the **mandatory cross-repo update workflow** that must accompany every release.

For detailed change history see [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md). This file is intentionally kept short — it carries only the project overview plus drift-resistant structural and schema information. Version-by-version release notes are deliberately excluded.

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide — single-source-of-truth rules for README / CHANGELOG / this file).

---

## Project Overview

**deep-wiki** is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that implements Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) philosophy. Instead of re-discovering knowledge each time (like RAG), it accumulates knowledge in a persistent markdown wiki — the wiki itself is the artifact; conversations are ephemeral.

**Three-layer model:**
1. **Raw Sources** — Immutable inputs (files, URLs, text, deep-work reports)
2. **Wiki** — LLM-managed markdown pages (the accumulated knowledge)
3. **Schema** — Wiki maintenance rules (`skills/wiki-schema/`)

**Marketplace presence**: This plugin is one of nine in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace (`deep-work` / `deep-wiki` / `deep-evolve` / `deep-review` / `deep-docs` / `deep-dashboard` / `deep-goal` / `deep-memory` / `deep-loop`).

## Runtime Support and Safety Boundaries

- All mutations follow a cooperative current writer contract with complete
  post-seizure owner and directory checks. Ambiguous locks require stopped-host
  intervention, and running a concurrent old version against the wiki is unsupported.
- The guarantee is mounted-filesystem and process-termination durability, not
  power-loss, remote-filesystem, or hostile-process durability.
- The SessionStart hook is Node 22. On Windows, Codex pre-expands the plugin root
  and uses the host-owned `%COMSPEC% /C` launch boundary. There is no shipped
  shell-script runtime; the three `scripts/v0-probe/*-record.sh` files are
  maintainer-only historical probes.
- The release contains no plugin MCP server or native binary and no runtime package
  dependency. Fixed evidence covers Windows Server 2025 and macOS arm64 and Intel;
  this is no Windows 11 claim.
- Installed-Codex authority uses an unauthenticated local Responses fixture. It is
  not production OpenAI API, login, model-quality, Windows 11,
  arbitrary-user-machine, or OS-level no-egress certification.
- After any 1.8 write, only a backup-only downgrade is supported: stop every host,
  recover with 1.8, restore the authenticated pre-upgrade backup, then start 1.7.1.
- After any 1.9 write, only a backup-only downgrade is supported: stop every host,
  recover with 1.9, restore the authenticated pre-upgrade backup, then start 1.8.2.
  1.9 writes an in-flight journal at `contract_version` 2 that 1.8.x cannot recover,
  so an interrupted 1.9 commit must be completed with 1.9 before any downgrade.

---

## 🚨 CRITICAL — Plugin Update Workflow

**Every deep-wiki release must be accompanied by the following work. No exceptions.**

### 1. Sync the deep-suite marketplace (required)

Update the following files in `/Users/sungmin/Dev/claude-plugins/deep-suite/`:

- **`.claude-plugin/marketplace.json`** and **`.agents/plugins/marketplace.json`** — under the `deep-wiki` entry:
  - `sha`: full 40-character merge commit hash on the new `main` (`git rev-parse HEAD`)
  - `description`: a one-line summary of the headline feature for the new version
- **`README.md`** — the `deep-wiki` row in the Plugins table (version + description)
- **`README.md`** — for feature releases, append a version-tagged bullet (e.g. `**Commit deadline scaling (v1.9.0)**`) to the end of the `### Key features` list inside the `## deep-wiki` section; patch releases may skip this
- **`README.ko.md`** — the Korean mirror of all of the above

After editing the deep-suite repo:
```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
git add .claude-plugin/marketplace.json .agents/plugins/marketplace.json README.md README.ko.md
git commit -m "chore: bump deep-wiki to vX.Y.Z — <one-line summary>"
git push
```

### 2. Update deep-wiki CHANGELOG (both languages, required)

- Add a new version entry to both `CHANGELOG.md` and `CHANGELOG.ko.md`
- Bump the version in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `package.json`

**Do NOT inline release notes in this CLAUDE.md** — CHANGELOG is the single source of truth. Only update the schema-coupled sections below (Storage layout, Lifecycle actions, Critical invariants) when the schema itself changes.

### 3. Release checklist

```
[ ] PR merged to main (deep-wiki repo)
[ ] CHANGELOG.md + CHANGELOG.ko.md updated (both languages)
[ ] .claude-plugin/plugin.json + package.json version bumped
[ ] (if schema changed) CLAUDE.md schema section synced
[ ] deep-suite marketplace.json sha + description updated
[ ] deep-suite README.md / README.ko.md table + section updated
[ ] deep-suite committed + pushed
```

Skipping any of these causes the next Claude session to work from stale information and mislead the user.

---

## Directory Structure

```
deep-wiki/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json     # plugin manifest (version, name, description)
├── agents/                         # subagent definitions
│   ├── wiki-synthesizer-analysis.md   # Stage 1 single-source A5 analysis (Write absent)
│   ├── wiki-synthesizer-worker.md     # multi-source A4 worker + 2nd-pass merge (Write absent)
│   ├── wiki-synthesizer-inline.md     # DORMANT — frozen v1.3.0 contract for restoration
│   └── wiki-page-writer.md            # A5 page-body generator (tools: [])
├── skills/                         # 5 entry skills (user-invocable) + 1 reference skill (auto-discovered)
│   ├── wiki-setup/SKILL.md         # /wiki-setup — initialization (also: Skill({skill:"deep-wiki:wiki-setup"}))
│   ├── wiki-ingest/SKILL.md        # /wiki-ingest — read sources, create/update pages
│   ├── wiki-query/SKILL.md         # /wiki-query — search the wiki + grounded answers
│   ├── wiki-lint/SKILL.md          # /wiki-lint — health check (schema, orphans, links)
│   ├── wiki-rebuild/SKILL.md       # /wiki-rebuild — regenerate the index
│   └── wiki-schema/                # reference skill (validation rules — not user-invocable)
│       ├── SKILL.md
│       └── wiki-schema.yaml        # machine-readable schema
├── hooks/
│   ├── hooks.json                 # SessionStart hook registration
│   └── scripts/
│       ├── scan-vault-changes.js         # fail-soft Node SessionStart supervisor
│       ├── scan-vault-worker.js          # bounded scanner worker
│       ├── runtime/                       # shared config/lock/state/persistence runtime
│       ├── envelope.js                   # M3 envelope shared lib (ULID, wrap/unwrap)
│       ├── wrap-index-envelope.js        # CLI writer (atomic temp+rename)
│       ├── read-index-envelope.js        # CLI reader (envelope unwrap + legacy pass-through)
│       └── test-helpers/run-scan-vault.js  # hermetic test helper
├── scripts/                        # plugin-level utility scripts
│   ├── lint-agent-tools.js        # frontmatter and tool-contract lint
│   ├── wiki-runtime.js            # portable wiki transaction CLI
│   ├── validate-envelope-emit.js  # release-lint, mirrors the suite envelope schema
│   └── codex-plugin-hook-smoke.js # installed-Codex smoke against the local Responses fixture (evidence claim above)
├── tests/                          # `npm test` (Node test runner)
├── docs/                           # author-local artifacts (gitignored, untracked)
└── .deep-review/                   # gitignored — review cycle artifacts
```

---

## Key Concepts

### Storage layout (`<wiki_root>/`)

```
<wiki_root>/
├── index.md                # LLM-written human-readable dashboard (artifact)
├── log.md                  # LLM-written human-readable chronicle (artifact)
├── log.jsonl               # append-only structured event log (machine-readable)
├── pages/                  # all wiki pages (flat, kebab-case .md)
└── .wiki-meta/
    ├── index.json                   # machine-readable catalog (M3 envelope-wrapped, rebuildable)
    ├── sources/                     # per-source provenance YAML (optional `partial_fail` sentinel)
    ├── .config.json                 # optional knobs (a5_fanout_threshold, a5_worker_timeout_sec)
    ├── .versions/                   # page backups (pre-write snapshots, last 3)
    ├── .wiki-lock/                  # mkdir-based concurrency lock
    ├── .last-scan                   # last committed scan window
    ├── .pending-scan                # in-flight scan window (not promoted = ingest incomplete)
    ├── .failed-sources.tsv          # partial-fail multi-source retry manifest
    └── .pending-scan-retry-count    # 3-strike ingest-fail trigger counter
```

### Lifecycle actions (log.jsonl `action` field)

- `ingest` — normal processing; emits new/updated pages. Attaches `pages_failed` on partial-fail and `phase_timing_ms` telemetry.
- `ingest-skip` — bytes hash unchanged AND wiki state intact → skip
- `ingest-repair` — bytes unchanged BUT wiki state drifted → self-heal (constrained to `pages_created:[]`)
- `ingest-fail` — three consecutive all-workers-fail batches on the same `.pending-scan` window → promote window despite failure
- `update` — direct page edit
- `lint` — health check execution + auto-fix
- `rebuild` — index regeneration
- `delete` — page deletion
- `query-filed` — `/wiki-query` auto-files cross-page synthesis as a new page
- `setup` — `/wiki-setup` seeds the wiki (welcome.md)

### Critical invariants

- **`pages_created` exactly-once across the log** — every page filename appears in `pages_created` arrays at most once across the entire log history. `ingest-repair` is exempt because it always emits `pages_created:[]` (lifecycle restoration ≠ creation).
- **`.last-scan` monotonic** — never moves backward.
- **Lock atomicity** — single-writer guaranteed by `mkdir <wiki>/.wiki-meta/.wiki-lock`.
- **Source provenance (commit-time, no-compounding)** — every `sources:` slug that a commit introduces or updates has a corresponding `<wiki>/.wiki-meta/sources/<slug>.yaml` file at commit time. Out-of-band deletion of an unchanged source's YAML mid-commit is preserved (never clobbered) and cancels the in-flight commit (`TRANSACTION_CANCELLED`) rather than compounding stale provenance; `/wiki-lint` surfaces it as `MISSING_SOURCE`. Commits never build derived state on stale provenance.

---

## Workflows & Conventions

### Node 22 portability (required)

All shipped runtime entrypoints are CommonJS Node scripts and must remain portable
across macOS, Linux, and native Windows. Use `node:` standard-library APIs, preserve
Windows drive/UNC paths without POSIX conversion, launch children with `shell:false`,
and keep stdout/stderr contracts bounded. Shell is allowed only as CI host
infrastructure; do not add a shipped `.sh`, `.cmd`, `.bat`, or `.ps1` runtime.

### UTC ISO 8601 timestamps (required)

All `ts` / `generated_at` / `ingested_at` values use the format
`YYYY-MM-DDTHH:MM:SSZ` (Z suffix). Generate from `new Date().toISOString()` and
remove the millisecond component. Never use a local timezone offset (`+09:00`,
etc.) — log.jsonl analysis depends on lexicographic comparison matching numeric
chronological order.

### Cross-platform date parsing

Validate the canonical UTC-Z grammar before calling `Date.parse`, reject a
non-finite result, and keep all comparisons in integer milliseconds. Do not
delegate parsing to platform-specific `date` executables.

### Atomic commit hygiene

Each commit must correspond to exactly one task. Never use `git add -A` (risk of leaking sensitive files). For every task:
1. spec or runtime change (markdown / yaml / Node)
2. validate via sandbox scenario
3. `git add` with explicit file paths
4. HEREDOC commit message (with the Co-Authored-By trailer)

### Spec/Plan ordering instructions

When a spec or plan uses positional directives ("above X", "below Y", "before Z"), name the surrounding pattern so the implementer can verify intent. Example: "Insert vX.Y.Z above vX.Y-1 (chronological-newest-first ordering)" — bare "above" is ambiguous and gets misread. Apply this to CHANGELOG edits, version-tagged bullet lists, and any list whose insertion order is meaningful.

### Review cycle (deep-review)

Significant changes follow this cycle:
1. Draft a plan (`docs/superpowers/plans/YYYY-MM-DD-feature.md`)
2. Run `/deep-review` 3-way (Opus + Codex review + Codex adversarial)
3. `/deep-review --respond` (ACCEPT / REJECT / DEFER each issue)
4. Update the plan and re-review until convergence
5. Implement (subagent-driven or inline)
6. After implementation, run `/deep-review` once more (regression check)
7. Push PR + merge
8. **Sync CHANGELOG + deep-suite per the "CRITICAL" section above**

Each cycle's review/response artifacts live under `.deep-review/{reports,responses}/` keyed by timestamp (gitignored).

**Lesson**: for config / hook / parser-driven changes, verify execution against the actual parser — not just that the spec text reads as self-consistent (self-coherent ≠ executable).

### docs/ folder policy

`.gitignore` ignores `docs/` entirely. Plans, follow-up notes, ultrareview reports, etc. are **author-local artifacts** and are not committed. Put PR review material inline in the PR description.

### `.claude/.hook-tool-input.*`

A transcript artifact created during Claude Code hook execution (contains the session ID, transcript path, command inputs/outputs, and the user's vault path). A matching pattern is in `.gitignore` to prevent leaks.

---

## Release history

Full change history lives in [`CHANGELOG.md`](CHANGELOG.md) (English) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md) (Korean).

To check the current version: `jq -r .version .claude-plugin/plugin.json`

---

## Quick references

| Question | Answer |
|---|---|
| How do I add a new entry skill? | Drop a new `skills/<name>/SKILL.md` with `user-invocable: true` frontmatter — it's auto-discovered for both Claude Code slash (`/<name>`) and cross-platform `Skill({ skill: "deep-wiki:<name>" })` |
| How do I change the schema? | Edit `skills/wiki-schema/wiki-schema.yaml` (machine) AND `SKILL.md` (LLM-readable) |
| How do I add a new hook trigger? | `hooks/hooks.json` + a portable Node script under `hooks/scripts/<new>.js` (must finish within the 15-second timeout) |
| How do I add a subagent? | New `agents/<name>.md` (frontmatter + prompt). Dispatch with the qualified namespace `deep-wiki:<name>` |
| Wiki schema violation? | Run `/wiki-lint` (`--fix` for auto-fixable items) |
| User complains ingest is slow? | Recommend the `auto_ingest:` config + `/wiki-lint --fix` |

---

## Related repositories

- **deep-suite (marketplace)**: https://github.com/Sungmin-Cho/claude-deep-suite — `/Users/sungmin/Dev/claude-plugins/deep-suite`
- **deep-work**: https://github.com/Sungmin-Cho/claude-deep-work
- **deep-evolve**: https://github.com/Sungmin-Cho/claude-deep-evolve
- **deep-review**: https://github.com/Sungmin-Cho/claude-deep-review
- **deep-docs**: https://github.com/Sungmin-Cho/claude-deep-docs
- **deep-dashboard**: https://github.com/Sungmin-Cho/claude-deep-dashboard
