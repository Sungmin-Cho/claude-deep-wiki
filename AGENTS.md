# deep-wiki — Agent Guide

LLM-managed markdown wiki for persistent knowledge accumulation, exposing skills,
hooks and agents to both Claude Code and Codex.

Read the version with `jq -r .version .claude-plugin/plugin.json` — it is triple-synced
across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `package.json`.
Never hardcode it in a doc. Dev setup, tests and PR rules live in `CONTRIBUTING.md`;
documentation rules in `docs/DOCS_RULE.md`.

## Where the contracts live

| Concern | Authority | Gate |
|---|---|---|
| Wiki state — storage layout, page + provenance schema, invariants, lock and journal protocol, lifecycle `action` vocabulary | `skills/wiki-schema/`: `SKILL.md` (LLM-readable), `wiki-schema.yaml` (machine-readable), `references/storage-layout.md` (operation catalog) | `npm test` |
| Per-skill runtime routes | `skills/wiki-*/SKILL.md`; every argv is allowlisted in `scripts/lib/executable-contract.js` | `npm run lint:commands` |
| Subagent roles and tool grants | `agents/*.md` | `npm run lint:agents` |
| SessionStart vault scan | `hooks/hooks.json` (15-second timeout) → `hooks/scripts/` | `npm run lint:hook-command` |
| Emitted `index.json` envelope | `hooks/scripts/envelope.js` | `npm run validate-fixture` |

`scripts/wiki-runtime.js` is the sole authority for configuration, lock ownership,
versioning, journaled mutation, derived state and scan-window transitions. Skills and
agents describe intent; they never mutate wiki state directly.

A new entry skill is auto-discovered on both hosts from `skills/<name>/SKILL.md` with
`user-invocable: true` and `runtime_hosts: [claude, codex]` frontmatter.

## Invariants that bite

- **`<wiki_root>/`** (underscore) is the canonical wiki path prefix suite-wide; the
  hyphen spelling is forbidden and the suite's `check-memory-hierarchy.js` fails on it.
- **`log.jsonl` sits at the vault root; `index.json` sits under `.wiki-meta/`.** The
  asymmetry is deliberate and load-bearing — deep-dashboard resolves both paths
  literally and has already shipped one bug from assuming symmetry.
- **The lifecycle `action` vocabulary is a cross-plugin contract.** deep-dashboard
  counts `ingest`, `ingest-skip`, `ingest-repair` and `ingest-fail` by name, so
  renaming one silently zeroes a suite metric. The full list is `wiki-schema.yaml`
  `log.actions`; the manifest `operation` for auto-filing is `query-autofile` while the
  emitted `action` is `query-filed`, and both literals are test-pinned.
- **`.wiki-meta/index.json` is an M3 aggregator envelope**: its payload must keep
  `pages`, and it never carries `parent_run_id`.
- **Timestamps are `YYYY-MM-DDTHH:MM:SSZ`** — never a local offset, because log
  analysis relies on lexicographic order matching chronological order.
- **The suite advertises these paths** in `suite-extensions.json`; renaming one breaks
  `check-pinned-plugin-paths.js`: `<wiki_root>/log.jsonl`,
  `<wiki_root>/.wiki-meta/index.json`, `<wiki_root>/.wiki-meta/.versions/*`,
  `<wiki_root>/pages/**/*.md`, and the read path `<wiki_root>/.wiki-meta/.pending-scan`.

## Runtime safety boundary

`tests/plugin-contract.test.js` asserts each statement below in `README.md`, this file,
`CONTRIBUTING.md` and `SECURITY.md` (and its Korean mirror in `README.ko.md`).
Rewording one fails the suite — change the claim only when the evidence changes.

- Mutation is governed by a cooperative current writer contract with complete
  post-seizure owner and directory checks. Ambiguous locks require stopped-host
  intervention; a concurrent old version is unsupported.
- The claim is mounted-filesystem and process-termination durability only.
- The Node 22 SessionStart hook uses Codex's host-owned `%COMSPEC% /C` boundary on
  Windows, where Codex additionally pre-expands the plugin root before that launch
  boundary runs. There is no shipped shell-script runtime; the three
  `scripts/v0-probe/*-record.sh` files are maintainer-only historical probes.
- The plugin has no plugin MCP server or native binary and no runtime dependency. CI
  evidence covers Windows Server 2025 and macOS arm64 and Intel; it is no Windows 11
  claim.
- Installed-Codex evidence uses an unauthenticated local Responses fixture. It is not
  production OpenAI API, login, model-quality, Windows 11, arbitrary-user-machine, or
  OS-level no-egress certification.
- Rollback is a backup-only downgrade: stop all hosts, let the current version finish
  recovery, restore the authenticated pre-upgrade backup, then start the older one
  (1.8 → 1.7.1, 1.9 → 1.8.2). A 1.9 in-flight journal uses `contract_version` 2, which
  1.8.x cannot recover, so an interrupted 1.9 commit must be completed with 1.9 first.

## Conventions

- **Node 22 portability.** Shipped runtime entrypoints are CommonJS. Use `node:` APIs,
  preserve Windows drive and UNC paths without POSIX conversion, launch children with
  `shell: false`, and add no shipped `.sh`, `.cmd`, `.bat` or `.ps1` runtime.
- **One task per commit.** Never `git add -A` — explicit paths only, so an untracked
  vault path or transcript cannot leak.
- `docs/` is gitignored: plans, handoffs and review notes are author-local. Put PR
  material in the PR description. `.claude/.hook-tool-input.*` transcripts are ignored
  for the same reason — they carry the session ID and the user's vault path.
- Significant changes run `/deep-review` to convergence before and after
  implementation. For config, hook or parser-driven changes, verify against the actual
  parser rather than re-reading the spec: self-coherent is not executable.

## Release

The plugin repo owns its own release: bump the version triple, add the entry to
`CHANGELOG.md` **and** `CHANGELOG.ko.md`, then merge to `main`.

Re-pinning the suite is then one command in `claude-deep-suite`:
`npm run release:bump -- deep-wiki <sha40>` followed by `npm run preflight`. It rewrites
`.claude-plugin/marketplace.json` and regenerates every auto-generated doc region —
do not hand-edit the suite README plugin table, which lives inside
`<!-- deep-suite:auto-generated:plugin-table-en -->` markers. Two things the command
does not do: `.agents/plugins/marketplace.json` must be synced by hand, and a feature
release should get a hand-written bullet appended to the `### Key features` list in the
suite `README.md` / `README.ko.md` `## deep-wiki` section.
