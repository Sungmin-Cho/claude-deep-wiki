# Contributing to deep-wiki

Thanks for your interest in improving **deep-wiki** — an LLM-managed markdown wiki for
persistent knowledge accumulation, part of the
[claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

## Development setup

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-wiki.git
cd claude-deep-wiki
```

Node 20+ is required (ESM project). There are no runtime dependencies — the repo ships
the plugin (skills, hooks, agents) plus a Node test runner and helper scripts.

## Tests

```bash
npm test                 # node --test (recursive discovery from cwd)
npm run validate-fixture # validate the envelope sample fixture
```

Hook scripts must stay **Bash 3.2 portable** (macOS ships `/bin/bash` 3.2.57) — see the
conventions in [`CLAUDE.md`](CLAUDE.md): no `declare -A`, no `mapfile`, no `${var,,}`,
no `&>/dev/null`.

## Conventions

- **Documentation** follows [`docs/DOCS_RULE.md`](docs/DOCS_RULE.md) (local maintainer
  guide). README is evergreen and bilingual (EN + KO); the CHANGELOG follows
  [Keep a Changelog](https://keepachangelog.com/) and is also bilingual.
- **Version triple-sync**: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` must always carry the same version.
- The canonical wiki path prefix is `<wiki_root>/` (underscore); the hyphen form is
  forbidden.

## Pull requests

1. Branch from `main`.
2. Keep changes focused and make sure `npm test` is green.
3. Add a `## [Unreleased]` entry (or a versioned entry) to `CHANGELOG.md` **and**
   `CHANGELOG.ko.md` for any user-observable change.
4. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
