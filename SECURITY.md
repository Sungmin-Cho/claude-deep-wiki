# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-wiki. Check the current
version with `jq -r .version .claude-plugin/plugin.json` and see the
[CHANGELOG](CHANGELOG.md) for release history.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/deep-wiki/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-wiki runs inside the Claude Code / Codex plugin runtime and operates on **local
files**:

- It reads and writes a local **wiki root** (`<wiki_root>/`) — markdown pages plus
  machine-readable metadata under `.wiki-meta/`. When the wiki lives inside an Obsidian
  vault, it also reads vault files during ingest.
- It ships a **SessionStart hook** (`hooks/scripts/scan-vault-changes.js`) that scans
  the Obsidian vault for files modified since the last scan and proposes auto-ingest.
  Review `hooks/hooks.json` and the scan script before enabling the hook, and confirm
  the configured `wiki_root` / vault path in `~/.claude/deep-wiki-config.yaml`. The hook
  operates on local files and emits only a bounded local candidate receipt.

## Runtime and evidence boundary

- Writers use a cooperative current writer protocol with complete post-seizure
  owner and directory checks. Ambiguous locks require stopped-host intervention;
  do not run a concurrent old version against the same wiki.
- Persistence provides mounted-filesystem and process-termination durability only,
  not power-loss or hostile-process durability.
- The Node 22 Windows hook is launched through the host-owned `%COMSPEC% /C`
  boundary. The release has no shipped shell-script runtime, no plugin MCP server
  or native binary, and no runtime dependency.
- Fixed evidence covers Windows Server 2025 and macOS arm64 and Intel; it is no
  Windows 11 claim. The installed-Codex smoke uses an unauthenticated local
  Responses fixture and is not production OpenAI API, login, model-quality,
  Windows 11, arbitrary-user-machine, or OS-level no-egress certification.
- After any 1.8 write, a backup-only downgrade is required: stop all hosts, recover
  with 1.8, restore the authenticated pre-upgrade backup, then start 1.7.1.
- After any 1.10 write, a backup-only downgrade is required: stop all hosts, recover
  with 1.10, restore the authenticated pre-upgrade backup, then start 1.9.x.

When reporting, please indicate which runtime (Claude Code or Codex) and the affected
version.
