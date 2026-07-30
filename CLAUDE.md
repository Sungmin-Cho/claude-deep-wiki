@AGENTS.md

# deep-wiki — Claude Code notes

`AGENTS.md` (imported above) carries every shared runtime rule. `README.md` explains
what the plugin is and why. Only Claude Code-specific behaviour belongs here.

- The five entry skills are reachable as slash commands (`/wiki-setup`, `/wiki-ingest`,
  `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`). Other hosts call the same skills as
  `Skill({ skill: "deep-wiki:wiki-<verb>" })`, and both routes must stay identical.
- Subagent fan-out is Claude Code-only. `/wiki-ingest` may dispatch exactly three
  qualified roles — `deep-wiki:wiki-synthesizer-analysis`,
  `deep-wiki:wiki-synthesizer-worker`, `deep-wiki:wiki-page-writer` — and a
  named-agent resolution error must fail that work rather than fall back to a generic
  agent. Codex performs the same work sequentially in its main caller. See
  `<plugin_root>/skills/wiki-ingest/SKILL.md` §2.
