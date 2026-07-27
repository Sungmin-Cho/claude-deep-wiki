@AGENTS.md

# deep-wiki — Claude Code Notes

This file is auto-loaded by Claude Code at the start of every session. `AGENTS.md` (imported above) is the single source for the shared runtime rules — directory structure, storage layout, lifecycle actions, invariants, conventions, and the release workflow. The section below is project narrative that doesn't duplicate anything there.

## Project Overview

**deep-wiki** is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that implements Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) philosophy. Instead of re-discovering knowledge each time (like RAG), it accumulates knowledge in a persistent markdown wiki — the wiki itself is the artifact; conversations are ephemeral.

**Three-layer model:**
1. **Raw Sources** — Immutable inputs (files, URLs, text, deep-work reports)
2. **Wiki** — LLM-managed markdown pages (the accumulated knowledge)
3. **Schema** — Wiki maintenance rules (`skills/wiki-schema/`)

**Marketplace presence**: This plugin is one of nine in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace (`deep-work` / `deep-wiki` / `deep-evolve` / `deep-review` / `deep-docs` / `deep-dashboard` / `deep-goal` / `deep-memory` / `deep-loop`).