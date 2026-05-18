---
name: wiki-setup
description: "Use when the user wants to initialize the deep-wiki knowledge base for first use — creating the wiki root directory, the config file at `~/.claude/deep-wiki-config.yaml`, the initial directory structure (`pages/`, `.wiki-meta/`), and a seed `welcome.md` page. Triggers on `/wiki-setup`, \"init wiki\", \"set up wiki\", \"scaffold wiki\", \"create wiki\", \"wiki bootstrap\", \"위키 초기화\", \"위키 셋업\", \"위키 설정\", \"위키 만들기\", \"위키 시작\". Accepts an optional `<wiki_root_path>` argument; otherwise prompts the user via AskUserQuestion (option A — inside an Obsidian vault, option B — standalone directory). Windows users must supply a POSIX form path (`/c/...` or `/mnt/c/...`)."
user-invocable: true
---

# wiki-setup — Initialize Deep-Wiki

Set up the deep-wiki knowledge base for first use.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — 사용자가 `/wiki-setup [wiki_root_path]` 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-wiki:wiki-setup", args: "[wiki_root_path]" })` 형태로 명시 invoke (cross-platform 표준 경로).

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, Step 1 의 분기가 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Step 1 의 AskUserQuestion 분기로 진입 — A) Obsidian vault 안 / B) 독립 디렉토리 선택 |
| `<wiki_root_path>` | wiki_root 로 직접 사용 (절대 경로 또는 `~`-prefix 허용; POSIX form 필수, Windows 사용자는 `/c/Users/...` 또는 `/mnt/c/Users/...`) |

## Prerequisites

이 entry skill 은 `wiki-schema` sibling skill (4 critical invariants + 10 log actions + storage layout 규칙) 과 함께 동작합니다 — setup 은 wiki 디렉토리 구조만 생성하며, 이후 `/wiki-ingest` / `/wiki-lint` / `/wiki-query` / `/wiki-rebuild` 4 개 sibling entry skill 이 본 skill 이 생성한 wiki_root 와 schema 를 공유합니다.

**Cross-platform self-containment**: Claude Code 에서는 sibling skill (`wiki-schema`) 이 description 매칭으로 자동 로드됩니다. 다만 Codex / Copilot CLI / Gemini CLI 등 타 플랫폼에서 `Skill()` 호출 시 sibling skill 의 auto-load 보장이 약할 수 있으므로, 본 SKILL §"Steps" 본문은 **의도적으로 self-contained** — 디렉토리 트리, config 스키마(`wiki_root` 키), 초기 시드 페이지(`welcome.md`) 본문, lifecycle action `setup` 의 `log.jsonl` entry 형식을 인라인으로 보존합니다.

## Steps

### 1. Determine Wiki Root

If an argument is provided, use it as the wiki root path. Otherwise, prompt the user:

> Where should the wiki be stored?
> A) Inside an Obsidian vault (provide path, e.g., ~/Obsidian/MyVault/wiki)
> B) A standalone directory (provide path, e.g., ~/wiki)

**Platform note:** On Windows, the wiki_root path MUST be in POSIX form (e.g. `/c/Users/name/wiki` under Git Bash, `/mnt/c/Users/name/wiki` under WSL2). The SessionStart hook rejects Windows-native paths (`C:\...` or `C:/...`). If the user provides a Windows-native path, normalize it before writing to config.

### 2. Create Config File

Write the configuration to `~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: <resolved_absolute_path>
```

> **Optional: auto-ingest scope filter (v1.2.0+).** To exclude high-frequency low-value paths from auto-ingest, add an `auto_ingest:` block:
>
> ```yaml
> wiki_root: <resolved_absolute_path>
> auto_ingest:
>   ignore_globs:                  # path globs (relative to vault root) to exclude
>     - "NOTES/DAILY/*"
>     - "Home/3. RESOURCE/재무/경제 뉴스/*"
>   require_tag: ""                # if non-empty, only ingest files with this frontmatter tag
> ```
>
> Without this block, all modified `.md` files in the vault are detected (legacy behavior). Filtering happens in the SessionStart hook before /wiki-ingest is invoked. **Note (I1):** the bash 3.2 `case` glob used by the hook treats `*` as matching any character including `/`, so `Home/Daily/*` and `Home/Daily/**` are functionally equivalent. The single-`*` form is preferred for clarity since `**` does not have its conventional fnmatch globstar semantics here. Filters are evaluated in order: `ignore_globs` first (path glob match, no I/O), `require_tag` second (frontmatter read). A path is included only if it passes both.

### 3. Scaffold Wiki Structure

Create the directory structure at the wiki root:

```bash
mkdir -p "<wiki_root>/pages"
mkdir -p "<wiki_root>/.wiki-meta/sources"
mkdir -p "<wiki_root>/.wiki-meta/.versions"
```

Create the initial machine-readable files:

```bash
touch "<wiki_root>/log.jsonl"
```

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

**`<wiki_root>/.wiki-meta/index.json`** — v1.5.0+ emits the M3 cross-plugin envelope wrap around the legacy payload shape. Caller MUST set `WIKI_ROOT` (absolute path) before invoking the snippet below.

```bash
set -euo pipefail
: "${WIKI_ROOT:?caller must set WIKI_ROOT to the wiki root absolute path}"

# Build the empty payload (legacy shape preserved inside `payload`).
PAYLOAD_TMP="${WIKI_ROOT}/.wiki-meta/index.payload.tmp.$$.$(date +%s).json"
cat > "$PAYLOAD_TMP" <<JSON
{
  "pages": [],
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

# Envelope-wrap. The helper writes atomically (temp + rename) and emits
# `wrapped: <path> ...` on stdout. Multi-source aggregator: no parent_run_id;
# empty source_artifacts on first setup (pages/ is empty by definition).
# Cleanup payload temp file ONLY on helper success — failure preserves it
# for retry (deep-work round-1 C2 gated-cleanup lesson).
if node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-index-envelope.js" \
     --payload-file "$PAYLOAD_TMP" \
     --output "${WIKI_ROOT}/.wiki-meta/index.json"; then
  rm -f "$PAYLOAD_TMP"
else
  echo "ERROR: wrap-index-envelope.js failed; payload preserved at $PAYLOAD_TMP for retry" >&2
  exit 1
fi
```

Create the initial human-readable wiki artifacts:

**`<wiki_root>/index.md`** — LLM-written catalog:

```markdown
# Wiki Index

This wiki is newly created and has no knowledge pages yet. Run `/wiki-ingest` to start building knowledge.

## Pages

- **Welcome** — Introduction to the wiki ([welcome.md](pages/welcome.md))
```

**`<wiki_root>/log.md`** — LLM-written chronicle:

```markdown
# Wiki Log

### <date> — Wiki Created
Initialized deep-wiki knowledge base. Ready for first ingest.
```

### 4. Create Seed Page

Create a welcome page at `pages/welcome.md` to prevent cold-start issues:

```markdown
---
title: "Welcome to Deep-Wiki"
sources: []
tags:
  - meta
aliases:
  - home
  - index
---

# Welcome to Deep-Wiki

This wiki is managed by Claude Code using the deep-wiki plugin.

## How It Works

- Use `/wiki-ingest` to add knowledge from sources (files, URLs, text)
- Use `/wiki-query` to search and ask questions
- Use `/wiki-lint` to check wiki health
- Use `/wiki-rebuild` to regenerate the index

Knowledge accumulates here over time, creating a persistent knowledge base.
```

### 5. Check Recommended Tools

#### 5a. CLI Tools

Check if the following CLI tools are installed:

```bash
which qmd 2>/dev/null   # markdown search engine (BM25 + vector search)
which marp 2>/dev/null   # markdown slide generator
```

Report the status of each tool and provide install commands for any that are missing:

| Tool | Purpose | Install |
|------|---------|---------|
| **qmd** | Local markdown search with BM25/vector search and LLM re-ranking. Can be used as an MCP server for tighter agent integration. | `npm install -g @tobilu/qmd` |
| **marp** | Generate slide presentations from markdown wiki pages. | `npm install -g @marp-team/marp-cli` |

#### 5b. Obsidian Plugin Check (if Obsidian vault)

If the wiki root is inside an Obsidian vault (i.e., a `.obsidian/` directory exists in a parent directory), check for recommended Obsidian plugins:

```bash
# Find the vault root (nearest ancestor with .obsidian/)
VAULT_ROOT="<detected_vault_root>"
PLUGINS_DIR="$VAULT_ROOT/.obsidian/plugins"
```

Check for these plugins:

| Plugin | Directory Name | Purpose |
|--------|---------------|---------|
| **Dataview** | `dataview` | Query page frontmatter to generate dynamic tables and lists from wiki metadata |
| **Marp Slides** | `marp-slides` | Render Marp slide decks directly in Obsidian |
| **Obsidian Web Clipper** | — (browser extension) | Browser extension to clip web articles as markdown for quick ingest |

For each missing plugin, print a recommendation:

```
Recommended Obsidian plugins:
  ✓ Dataview — installed
  ✗ Marp Slides — not found
    → Install from Obsidian Settings > Community Plugins > Browse > "Marp Slides"
  ℹ Obsidian Web Clipper — browser extension
    → Install from https://obsidian.md/clipper
```

If the wiki is NOT inside an Obsidian vault, skip this check entirely.

#### 5c. Obsidian CLI Detection

> **Windows note:** The `obsidian` command must be on PATH within the shell running Claude Code. Typical install location: `%LOCALAPPDATA%\Programs\Obsidian\`. If `obsidian version` fails in Git Bash, the user must add the directory containing `obsidian.exe` to PATH before re-running setup.

If the wiki root is inside an Obsidian vault (detected in 5b), check for the Obsidian CLI:

**Step 1 — Detect CLI and running app:**

```bash
obsidian version 2>/dev/null
```

- If a version string is returned → CLI is installed and Obsidian app is running
- If the command fails or returns empty → CLI not installed or app not running → skip to step 6

**Step 2 — Get vault info:**

```bash
obsidian vault
```

Extract the vault name and path from the output. If the output format is unexpected, fall back to:
- `vault_path` = the `.obsidian/` parent directory already detected in Step 5b
- `vault_name` = the directory name of `vault_path`

**Step 3 — Compute `wiki_prefix`:**

Strip `vault_path` from `wiki_root` to get the vault-relative path:
- Example: vault_path=`/path/to/vault`, wiki_root=`/path/to/vault/deep-wiki` → prefix=`deep-wiki`
- **Edge case: wiki at vault root** — If `wiki_root == vault_path`, the prefix is empty. In this case, store `wiki_prefix: "."` and ensure all downstream path compositions use `pages/...` directly (not `./pages/...` or `/pages/...`). Callers must normalize: when `wiki_prefix` is `"."`, emit `pages/<page>.md` instead of `./<pages>/<page>.md`.

**Step 4 — Update config:**

If the config already contains an `obsidian_cli` block, **remove it first** (handles re-runs and CLI removal).

If CLI detection succeeded, append to `~/.claude/deep-wiki-config.yaml`:

```yaml
obsidian_cli:
  available: true
  vault_name: "<detected_vault_name>"
  vault_path: <detected_vault_path>
  wiki_prefix: "<computed_prefix>"
```

If CLI detection failed and an old `obsidian_cli` block exists, **delete it** to prevent stale config.

**Report in Step 7:**

If detected:
```
Obsidian CLI: ✓ detected (vault: "<vault_name>")
  → Wiki operations will use Obsidian CLI for search, backlinks, and orphan detection when available
```

If not detected:
```
Obsidian CLI: ✗ not detected
  → Using filesystem access only (enhanced search and graph features unavailable)
  → To enable: Obsidian 1.12.7+ required, then Settings → General → Command line interface
  → Troubleshooting: https://obsidian.md/help/cli#Troubleshooting
```

### 6. Log the Setup Event

Append to `log.jsonl`:

> **Timestamp format:** All `ts` and `generated_at` values MUST be UTC ISO 8601 with a `Z` suffix. Generate with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Never use local timezone offsets (e.g. `+09:00`) — the wiki's log is consumed by tooling that assumes a single canonical timezone.

```json
{"ts":"<iso_timestamp>","action":"setup","source":"deep-wiki-init","pages_created":["welcome.md"],"pages_updated":[]}
```

### 7. Confirm

Report to the user:
- Wiki root location
- Created directory structure
- Next step: run `/wiki-ingest <source>` to start building the wiki
