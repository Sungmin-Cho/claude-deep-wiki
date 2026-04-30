# deep-wiki — Project Guide for Claude

이 파일은 **새 Claude 세션이 시작될 때 자동으로 로드**됩니다. deep-wiki 플러그인의 개요, 구조, 그리고 **반드시 지켜야 하는 cross-repo 업데이트 워크플로우**를 담고 있습니다.

---

## Project Overview

**deep-wiki**는 Karpathy의 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 철학을 구현한 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 플러그인입니다. RAG처럼 매번 지식을 다시 발견하는 대신, 영속적인 markdown wiki에 지식을 누적합니다 — wiki 자체가 결과물이고, 대화는 일시적입니다.

**Three-layer model:**
1. **Raw Sources** — 불변 입력 (file, URL, text, deep-work report)
2. **Wiki** — LLM이 관리하는 markdown 페이지 (누적된 지식)
3. **Schema** — wiki 관리 규칙 (`skills/wiki-schema/`)

**Marketplace presence**: 이 플러그인은 [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) 마켓플레이스의 6개 plugin 중 하나입니다 (`deep-work` / `deep-wiki` / `deep-evolve` / `deep-review` / `deep-docs` / `deep-dashboard`).

---

## 🚨 CRITICAL — Plugin Update Workflow

**deep-wiki에 어떤 변경사항이 release되면 (version bump, 새 feature, 동작 변경) 반드시 다음 작업이 함께 수행되어야 합니다:**

### 1. deep-suite 마켓플레이스 동기화 (필수)

`/Users/sungmin/Dev/claude-plugins/deep-suite/` 에 다음 파일을 갱신:

- **`.claude-plugin/marketplace.json`** — `deep-wiki` 항목의:
  - `sha`: 새 main의 merge commit hash (full 40자, `git rev-parse HEAD`)
  - `description`: 새 버전의 핵심 기능 한 줄 요약
- **`README.md`** — Plugins 표의 `deep-wiki` 행 (version + description)
- **`README.md`** — `## deep-wiki` 섹션 끝의 version별 bullet list에 새 버전 항목 추가
- **`README.ko.md`** — 위 모든 한국어 미러

deep-suite 변경 후:
```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
git add .claude-plugin/marketplace.json README.md README.ko.md
git commit -m "chore: bump deep-wiki to vX.Y.Z — <one-line summary>"
git push
```

### 2. deep-wiki CLAUDE.md (이 파일) 갱신 (필수)

이 파일도 **항상** plugin 변경과 함께 갱신되어야 합니다:

- **현재 버전 / 핵심 기능**이 본문 내용과 일치하도록 (Architecture 섹션의 version-tagged bullets, Directory Structure의 새 파일 등)
- **새 워크플로우/규칙이 추가됐다면** "Workflows & conventions" 섹션에 추가
- 변경 후 deep-wiki PR에 함께 포함

이 cross-update가 누락되면 다음 세션의 Claude가 stale info로 작업하게 되어 사용자에게 잘못된 안내를 합니다.

### 3. Release 체크리스트 (사용자 확인용)

```
[ ] PR merged to main (deep-wiki repo)
[ ] CHANGELOG.md / CHANGELOG.ko.md updated (양쪽 모두)
[ ] .claude-plugin/plugin.json version bumped
[ ] CLAUDE.md (이 파일) updated
[ ] deep-suite marketplace.json sha + description updated
[ ] deep-suite README.md / README.ko.md table + section updated
[ ] deep-suite committed + pushed
[ ] (선택) docs/followup-*.md 작성 (큰 release면)
```

---

## Directory Structure

```
deep-wiki/
├── .claude-plugin/
│   └── plugin.json              # plugin manifest (version, name, description)
├── agents/
│   └── wiki-synthesizer.md      # subagent for source reading + page I/O
├── commands/
│   ├── wiki-setup.md            # /wiki-setup — 초기화
│   ├── wiki-ingest.md           # /wiki-ingest — 소스 읽고 페이지 생성/갱신
│   ├── wiki-query.md            # /wiki-query — 위키 검색 + grounded 답변
│   ├── wiki-lint.md             # /wiki-lint — health check (schema, orphans, links)
│   └── wiki-rebuild.md          # /wiki-rebuild — index 재생성
├── skills/
│   └── wiki-schema/             # 위키 schema 정의 + validation rules
│       ├── SKILL.md
│       ├── wiki-schema.yaml     # machine-readable schema
│       ├── references/
│       └── templates/
├── hooks/
│   ├── hooks.json               # SessionStart hook 등록
│   └── scripts/
│       └── scan-vault-changes.sh  # vault에서 modified .md 감지 → /wiki-ingest 트리거
├── CHANGELOG.md / CHANGELOG.ko.md
├── README.md / README.ko.md
├── docs/                        # 로컬 author artifacts (gitignored, untracked)
│   ├── superpowers/plans/       # implementation plans
│   ├── followup-*.md            # release follow-up notes
│   └── ultrareview-*.md         # ultrareview reports
├── test-wiki/                   # 예시 wiki (small)
└── .deep-review/                # gitignored — review 사이클 artifacts
```

---

## Key Concepts

### Storage layout (`<wiki_root>/`)

```
<wiki_root>/
├── index.md                     # LLM-written human-readable catalog (artifact)
├── log.md                       # LLM-written human-readable chronicle (artifact)
├── log.jsonl                    # append-only structured event log (machine-readable)
├── pages/                       # 모든 wiki 페이지 (flat, kebab-case .md)
└── .wiki-meta/
    ├── index.json               # machine-readable page catalog (rebuildable)
    ├── sources/                 # per-source provenance YAML
    ├── .versions/               # 페이지 backup (write 전 snapshot, last 3)
    ├── .wiki-lock/              # mkdir-based concurrency lock
    ├── .last-scan               # SessionStart hook의 마지막 committed scan window
    └── .pending-scan            # 진행 중인 scan window (promote 안 됨 = ingest 미완료)
```

### Lifecycle actions (log.jsonl `action` field)

- `ingest` — 정상 처리, 새/갱신 페이지 emit
- `ingest-skip` (v1.2.0+) — bytes hash unchanged AND wiki state intact → skip
- `ingest-repair` (v1.2.0+) — bytes unchanged BUT wiki state drift → 자가복구 (`pages_created:[]` 제약)
- `update` — 직접 페이지 수정
- `lint` — health check 실행 + auto-fix
- `rebuild` — index 재생성
- `delete` — 페이지 삭제
- `query-filed` — `/wiki-query`가 cross-page synthesis를 자동 페이지화
- `setup` — `/wiki-setup` 초기화 시 seed (welcome.md)

### Critical invariants

- **`pages_created` exactly-once across log** — 어떤 페이지 filename도 `pages_created` 배열 전체 history에서 한 번만 등장. `ingest-repair`은 항상 `pages_created:[]`이라 면제 (lifecycle restoration ≠ creation).
- **`.last-scan` monotonic** — 절대 역행 안 함. v1.1.4 promotion regression guard가 강제.
- **Lock atomicity** — `mkdir <wiki>/.wiki-meta/.wiki-lock` 으로 single-writer 보장.
- **Source provenance** — 모든 wiki page의 frontmatter `sources:` slug는 `<wiki>/.wiki-meta/sources/<slug>.yaml`에 대응 yaml 파일 존재.

---

## Workflows & Conventions

### Bash 3.2 portability (필수)

macOS 기본 `/bin/bash`은 3.2.57. 모든 hook script + spec 안의 bash pseudocode는 다음 미사용:

- `declare -A` (associative array — bash 4+)
- `mapfile` / `readarray`
- `${var,,}` / `${var^^}` (case modification)
- `&>/dev/null` (use `>/dev/null 2>&1`)
- `[[ =~ ]]` 안의 일부 ERE feature

`${arr[@]}` 사용 시 `set -u` 보호: `[ ${#arr[@]} -gt 0 ]` 가드 필요.

대안 패턴: newline-delimited string + `grep -Fxq` 또는 TSV 임시파일 (v1.1.4 D1 선례).

### UTC ISO 8601 timestamps (필수)

모든 `ts` / `generated_at` / `ingested_at` 값은 `YYYY-MM-DDTHH:MM:SSZ` 형식 (Z suffix). `date -u +"%Y-%m-%dT%H:%M:%SZ"`로 생성. 로컬 타임존 offset (`+09:00` 등) 사용 금지 — log.jsonl을 lexicographic 비교가 numeric 순서와 일치한다는 가정 위에 깔려있음.

### Cross-platform date parsing

`scan-vault-changes.sh`의 tri-branch pattern:
```bash
if command -v gdate >/dev/null 2>&1; then ...gdate -d... ;
elif [[ "$(uname)" == "Darwin" ]]; then ...date -j -f... ;
else ...date -d... ; fi
```

새 epoch parsing 코드를 추가할 때 이 패턴 재사용.

### Atomic commit hygiene

각 commit은 하나의 task에 정확히 대응. `git add -A` 사용 금지 (민감 파일 leak). 각 task는:
1. spec change (markdown / yaml / shell)
2. sandbox 시나리오 검증
3. 정확한 file 명시 git add
4. HEREDOC commit message (Co-Authored-By trailer 포함)

### Review cycle (deep-review)

큰 변경은 다음 사이클 따름:
1. plan 작성 (`docs/superpowers/plans/YYYY-MM-DD-feature.md`)
2. `/deep-review` 3-way (Opus + Codex review + Codex adversarial)
3. `/deep-review --respond` (각 issue ACCEPT/REJECT/DEFER)
4. plan 업데이트 후 재 review (수렴까지)
5. 구현 (subagent-driven 또는 inline)
6. implementation 완료 후 다시 `/deep-review` 한 번 더 (regression check)
7. PR push + merge
8. **이 CLAUDE.md + deep-suite 동기화** (위 "CRITICAL" 섹션)

각 cycle의 review/response artifact는 `.deep-review/{reports,responses}/`에 timestamp별 저장 (gitignored).

### docs/ folder policy

`.gitignore`에 `docs/`가 통째로 ignored되어 있음. plan, followup, ultrareview 등은 **author-local artifact**으로 commit되지 않음. v1.1.1 plan 선례 — `git log -- docs/` 빈 결과. PR review 자료는 PR description에 inline.

### `.claude/.hook-tool-input.*` (v1.2.0+)

Claude Code hook 실행 중에 만들어지는 transcript artifact. session ID + transcript path + command inputs/outputs + 사용자 vault path 포함. `.gitignore`에 패턴 추가됨 (v1.2.0). leak 방지.

---

## Recent releases

- **v1.0.0** (2026-04-07) — 초기 stable release
- **v1.0.1** (2026-04-07) — auto-ingest SessionStart hook
- **v1.1.0** (2026-04-08) — Obsidian CLI integration
- **v1.1.1** (2026-04-17) — Windows compatibility, .pending-scan introduction, security
- **v1.1.2** (2026-04-21) — wiki-synthesizer subagent delegation (always-on)
- **v1.1.3** (2026-04-24) — parallel tool dispatch
- **v1.1.4** (2026-04-24) — hash normalization + promotion regression guard
- **v1.2.0** (2026-04-30) — **(현재)** throughput + lint hardening + ingest-repair self-healing

전체 history는 `CHANGELOG.md` 참조.

---

## Quick references

| 질문 | 답 위치 |
|---|---|
| 새 명령 추가하려면? | `commands/` 에 새 `.md` 만들고 `.claude-plugin/plugin.json` 미언급 (자동 인식) |
| Schema 변경하려면? | `skills/wiki-schema/wiki-schema.yaml` (machine) + `SKILL.md` (LLM-readable) 둘 다 |
| Hook 트리거 추가하려면? | `hooks/hooks.json` + `hooks/scripts/<new>.sh` (15초 timeout 안에 끝나야) |
| Subagent 추가하려면? | `agents/<name>.md` (frontmatter + prompt) |
| 위키 schema 위반 발견 시? | `/wiki-lint` (auto-fix 가능한 항목은 `--fix`) |
| 사용자가 ingest 너무 느리다고? | v1.2.0의 `auto_ingest:` config + `/wiki-lint --fix` 권고 |
| 사용자가 broken link false positive? | v1.2.0+ wiki-lint Step 4가 fenced code block strip; URL은 v1.3.0+ candidate (followup doc) |

---

## Related repositories

- **deep-suite (marketplace)**: https://github.com/Sungmin-Cho/claude-deep-suite — `/Users/sungmin/Dev/claude-plugins/deep-suite`
- **deep-work**: https://github.com/Sungmin-Cho/claude-deep-work
- **deep-evolve**: https://github.com/Sungmin-Cho/claude-deep-evolve
- **deep-review**: https://github.com/Sungmin-Cho/claude-deep-review
- **deep-docs**: https://github.com/Sungmin-Cho/claude-deep-docs
- **deep-dashboard**: https://github.com/Sungmin-Cho/claude-deep-dashboard

---

**🔁 Reminder**: 이 CLAUDE.md는 plugin이 변경될 때마다 갱신해야 합니다. "Recent releases" 섹션, "Architecture" 섹션의 version-tagged 항목, "Lifecycle actions" 같은 schema-coupled 섹션은 plugin 변경에 따라 drift할 수 있습니다. PR을 merge하기 전 이 파일이 최신 상태인지 확인하고, deep-suite 동기화도 함께 하세요.
