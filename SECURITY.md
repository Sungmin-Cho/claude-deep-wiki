# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-wiki. Check the current
version with `jq -r .version .claude-plugin/plugin.json` and see the
[CHANGELOG](CHANGELOG.md) for release history.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/claude-deep-wiki/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-wiki runs inside the Claude Code / Codex plugin runtime and operates on **local
files**:

- It reads and writes a local **wiki root** (`<wiki_root>/`) — markdown pages plus
  machine-readable metadata under `.wiki-meta/`. When the wiki lives inside an Obsidian
  vault, it also reads vault files during ingest.
- It ships a **SessionStart hook** (`hooks/scripts/scan-vault-changes.sh`) that scans
  the Obsidian vault for files modified since the last scan and proposes auto-ingest.
  Review `hooks/hooks.json` and the scan script before enabling the hook, and confirm
  the configured `wiki_root` / vault path in `~/.claude/deep-wiki-config.yaml`. The hook
  operates only on local files and never transmits them.

When reporting, please indicate which runtime (Claude Code or Codex) and the affected
version.
