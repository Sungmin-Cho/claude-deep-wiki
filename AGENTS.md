# deep-wiki - Codex Project Guide

LLM-managed markdown wiki for persistent knowledge accumulation. The plugin
keeps the Claude Code slash-command surface and exposes Codex-native skills and
manifest metadata.

Current version: 1.6.2.

## Runtime Surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`
- User-invocable skills: `skills/wiki-*/SKILL.md`
- Wiki schema reference: `skills/wiki-schema/`
- Hooks: `hooks/hooks.json` and `hooks/scripts/`
- Agents: `agents/`

Keep wiki data and runtime locks out of the plugin repo unless they are
intentional test fixtures.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8'))"
npm test
npm run validate-fixture
```

After a release, update both suite marketplace manifests in
`/Users/sungmin/Dev/claude-plugins/deep-suite/`.
