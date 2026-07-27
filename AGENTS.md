# deep-wiki - Codex Project Guide

LLM-managed markdown wiki for persistent knowledge accumulation. The plugin
keeps the Claude Code slash-command surface and exposes Codex-native skills and
manifest metadata.

To check the current version: `jq -r .version .codex-plugin/plugin.json`.

## Runtime Surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`
- User-invocable skills: `skills/wiki-*/SKILL.md`
- Wiki schema reference: `skills/wiki-schema/`
- Hooks: `hooks/hooks.json` and `hooks/scripts/`
- Agents: `agents/`

Keep wiki data and runtime locks out of the plugin repo unless they are
intentional test fixtures.

## Runtime Safety Boundary

- Mutation is governed by a cooperative current writer contract with complete
  post-seizure owner and directory checks. Ambiguous locks require stopped-host
  intervention; a concurrent old version is unsupported.
- The claim is mounted-filesystem and process-termination durability only.
- The Node 22 SessionStart hook uses Codex's host-owned `%COMSPEC% /C` boundary
  on Windows. There is no shipped shell-script runtime.
- The plugin has no plugin MCP server or native binary and no runtime dependency.
  CI evidence covers Windows Server 2025 and macOS arm64 and Intel; it is no
  Windows 11 claim.
- Installed-Codex evidence uses an unauthenticated local Responses fixture. It is
  not production OpenAI API, login, model-quality, Windows 11,
  arbitrary-user-machine, or OS-level no-egress certification.
- After a 1.8 write, use a backup-only downgrade: stop all hosts, recover with
  1.8, restore the authenticated pre-upgrade backup, then start 1.7.1.
- After a 1.9 write, use a backup-only downgrade: stop all hosts, recover with
  1.9, restore the authenticated pre-upgrade backup, then start 1.8.2. A 1.9
  in-flight journal uses `contract_version` 2, which 1.8.x cannot recover, so an
  interrupted 1.9 commit must be completed with 1.9 before any downgrade.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8'))"
npm test
npm run validate-fixture
```

After a release, update both suite marketplace manifests in
`/Users/sungmin/Dev/claude-plugins/deep-suite/`.

---

📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide — single-source-of-truth rules for README / CHANGELOG / this file).
