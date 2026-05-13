# deep-wiki — Project Guide for Claude

이 파일은 **새 Claude 세션 시작 시 자동 로드**됩니다. deep-wiki 플러그인의 개요, 구조, 그리고 **반드시 지켜야 하는 cross-repo 업데이트 워크플로우**를 담습니다.

상세한 변경 이력은 [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md)를 참조하세요. 이 파일은 짧은 개요 + drift하지 않는 구조/스키마 정보만 유지합니다 — 버전별 release notes는 의도적으로 제외합니다.

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

**deep-wiki에 어떤 변경사항이 release되면 반드시 다음 작업이 함께 수행되어야 합니다.**

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

### 2. deep-wiki CHANGELOG (양쪽) 갱신 (필수)

- `CHANGELOG.md` + `CHANGELOG.ko.md` 양쪽에 새 버전 항목 추가
- `.claude-plugin/plugin.json` + `package.json` version bump

**CLAUDE.md (이 파일)에 새 버전을 inline 기재하지 않습니다** — CHANGELOG가 single source of truth. 단, 아래 schema-coupled 섹션 (Storage layout, Lifecycle actions, Critical invariants)에 **schema 자체가 변경**되면 함께 갱신.

### 3. Release 체크리스트

```
[ ] PR merged to main (deep-wiki repo)
[ ] CHANGELOG.md + CHANGELOG.ko.md updated (양쪽)
[ ] .claude-plugin/plugin.json + package.json version bumped
[ ] (schema 변경 시) CLAUDE.md schema 섹션 sync
[ ] deep-suite marketplace.json sha + description updated
[ ] deep-suite README.md / README.ko.md table + section updated
[ ] deep-suite committed + pushed
```

이 cross-update가 누락되면 다음 세션의 Claude가 stale info로 작업하게 됩니다.

---

## Directory Structure

```
deep-wiki/
├── .claude-plugin/plugin.json     # plugin manifest (version, name, description)
├── agents/                         # subagent definitions
│   ├── wiki-synthesizer-analysis.md   # Stage 1 single-source A5 analysis (Write absent)
│   ├── wiki-synthesizer-worker.md     # multi-source A4 worker + 2nd-pass merge (Write absent)
│   ├── wiki-synthesizer-inline.md     # DORMANT — frozen v1.3.0 contract for restoration
│   └── wiki-page-writer.md            # A5 page-body generator (tools: [])
├── commands/                       # slash commands (자동 인식 — plugin.json 미언급)
│   ├── wiki-setup.md              # /wiki-setup — 초기화
│   ├── wiki-ingest.md             # /wiki-ingest — 소스 읽고 페이지 생성/갱신
│   ├── wiki-query.md              # /wiki-query — 위키 검색 + grounded 답변
│   ├── wiki-lint.md               # /wiki-lint — health check (schema, orphans, links)
│   └── wiki-rebuild.md            # /wiki-rebuild — index 재생성
├── skills/wiki-schema/             # 위키 schema 정의 + validation rules
│   ├── SKILL.md
│   └── wiki-schema.yaml           # machine-readable schema
├── hooks/
│   ├── hooks.json                 # SessionStart hook 등록
│   └── scripts/
│       ├── scan-vault-changes.sh         # vault에서 modified .md 감지 → /wiki-ingest 트리거
│       ├── envelope.js                   # M3 envelope shared lib (ULID, wrap/unwrap)
│       ├── wrap-index-envelope.js        # CLI writer (atomic temp+rename)
│       ├── read-index-envelope.js        # CLI reader (envelope unwrap + legacy pass-through)
│       └── test-helpers/run-scan-vault.js  # hermetic test helper
├── scripts/                        # plugin-level utility scripts
│   ├── lint-agent-tools.sh        # frontmatter lint (4-agent manifest, Bash 3.2)
│   └── validate-envelope-emit.js  # release-lint, suite envelope schema mirror
├── tests/                          # `npm test` (Node test runner)
│   ├── envelope-{emit,chain}.test.js
│   ├── auto-ingest-golden.test.js
│   ├── pending-scan-recovery.test.js
│   └── fixtures/
├── package.json                    # test runner manifest (private, no runtime deps)
├── CHANGELOG.md / CHANGELOG.ko.md
├── README.md / README.ko.md
├── docs/                           # 로컬 author artifacts (gitignored, untracked)
├── test-wiki/                      # 예시 wiki (small)
└── .deep-review/                   # gitignored — review 사이클 artifacts
```

---

## Key Concepts

### Storage layout (`<wiki_root>/`)

```
<wiki_root>/
├── index.md                # LLM-written human-readable catalog (artifact)
├── log.md                  # LLM-written human-readable chronicle (artifact)
├── log.jsonl               # append-only structured event log (machine-readable)
├── pages/                  # 모든 wiki 페이지 (flat, kebab-case .md)
└── .wiki-meta/
    ├── index.json                   # machine-readable catalog (M3 envelope-wrapped, rebuildable)
    ├── sources/                     # per-source provenance YAML (optional `partial_fail` sentinel)
    ├── .config.json                 # optional knobs (a5_fanout_threshold, a5_worker_timeout_sec)
    ├── .versions/                   # 페이지 backup (write 전 snapshot, last 3)
    ├── .wiki-lock/                  # mkdir-based concurrency lock
    ├── .last-scan                   # 마지막 committed scan window
    ├── .pending-scan                # 진행 중인 scan window (promote 안 됨 = ingest 미완료)
    ├── .failed-sources.tsv          # partial-fail multi-source retry manifest
    └── .pending-scan-retry-count    # 3-strike ingest-fail trigger counter
```

### Lifecycle actions (log.jsonl `action` field)

- `ingest` — 정상 처리, 새/갱신 페이지 emit. partial-fail 시 `pages_failed` field 첨부. `phase_timing_ms` 텔레메트리 field 첨부.
- `ingest-skip` — bytes hash unchanged AND wiki state intact → skip
- `ingest-repair` — bytes unchanged BUT wiki state drift → 자가복구 (`pages_created:[]` 제약)
- `ingest-fail` — 같은 `.pending-scan` window에서 3회 연속 all-workers-fail → window promote despite failure
- `update` — 직접 페이지 수정
- `lint` — health check 실행 + auto-fix
- `rebuild` — index 재생성
- `delete` — 페이지 삭제
- `query-filed` — `/wiki-query` cross-page synthesis 자동 페이지화
- `setup` — `/wiki-setup` 초기화 시 seed (welcome.md)

### Critical invariants

- **`pages_created` exactly-once across log** — 어떤 페이지 filename도 `pages_created` 배열 전체 history에서 한 번만 등장. `ingest-repair`은 항상 `pages_created:[]`이라 면제 (lifecycle restoration ≠ creation).
- **`.last-scan` monotonic** — 절대 역행 안 함.
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

대안 패턴: newline-delimited string + `grep -Fxq` 또는 TSV 임시파일.

### UTC ISO 8601 timestamps (필수)

모든 `ts` / `generated_at` / `ingested_at` 값은 `YYYY-MM-DDTHH:MM:SSZ` 형식 (Z suffix). `date -u +"%Y-%m-%dT%H:%M:%SZ"`로 생성. 로컬 타임존 offset (`+09:00` 등) 사용 금지 — log.jsonl의 lexicographic 비교가 numeric 순서와 일치한다는 가정 위에 깔려있음.

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

### Spec/Plan ordering instructions

위치 지시("above X", "below Y", "before Z")가 있는 spec/plan은 surrounding pattern 명시. 예: "Insert vX.Y.Z above vX.Y-1 (chronological-newest-first ordering)" — 모호한 "above"는 reviewer가 잘못 해석할 수 있음. CHANGELOG, version-tagged bullet list, 순서가 의미 있는 모든 list 편집 시 적용.

### Review cycle (deep-review)

큰 변경은 다음 사이클 따름:
1. plan 작성 (`docs/superpowers/plans/YYYY-MM-DD-feature.md`)
2. `/deep-review` 3-way (Opus + Codex review + Codex adversarial)
3. `/deep-review --respond` (각 issue ACCEPT/REJECT/DEFER)
4. plan 업데이트 후 재 review (수렴까지)
5. 구현 (subagent-driven 또는 inline)
6. implementation 완료 후 다시 `/deep-review` (regression check)
7. PR push + merge
8. **이 파일의 "CRITICAL" 섹션에 따라 CHANGELOG + deep-suite 동기화**

각 cycle의 review/response artifact는 `.deep-review/{reports,responses}/`에 timestamp별 저장 (gitignored).

**Lesson**: config / hook / parser-driven 변경은 spec text가 self-consistent해도 실제 parser 실행으로 검증해야 함 (self-coherent ≠ executable).

### docs/ folder policy

`.gitignore`에 `docs/`가 통째로 ignored되어 있음. plan, followup, ultrareview 등은 **author-local artifact**으로 commit되지 않음. PR review 자료는 PR description에 inline.

### `.claude/.hook-tool-input.*`

Claude Code hook 실행 중에 만들어지는 transcript artifact (session ID + transcript path + command inputs/outputs + 사용자 vault path 포함). `.gitignore`에 패턴 추가됨 — leak 방지.

---

## Release history

전체 변경 이력은 [`CHANGELOG.md`](CHANGELOG.md) (English) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md) (한국어)를 참조하세요.

현재 버전: `jq -r .version .claude-plugin/plugin.json`

---

## Quick references

| 질문 | 답 위치 |
|---|---|
| 새 명령 추가? | `commands/` 에 새 `.md` 만들면 자동 인식 (`plugin.json` 미언급) |
| Schema 변경? | `skills/wiki-schema/wiki-schema.yaml` (machine) + `SKILL.md` (LLM-readable) 둘 다 |
| Hook 트리거 추가? | `hooks/hooks.json` + `hooks/scripts/<new>.sh` (15초 timeout 안에 끝나야) |
| Subagent 추가? | `agents/<name>.md` (frontmatter + prompt) — qualified namespace `deep-wiki:<name>` 사용 |
| 위키 schema 위반? | `/wiki-lint` (auto-fix 가능한 항목은 `--fix`) |
| ingest 느림? | `auto_ingest:` config + `/wiki-lint --fix` |

---

## Related repositories

- **deep-suite (marketplace)**: https://github.com/Sungmin-Cho/claude-deep-suite — `/Users/sungmin/Dev/claude-plugins/deep-suite`
- **deep-work**: https://github.com/Sungmin-Cho/claude-deep-work
- **deep-evolve**: https://github.com/Sungmin-Cho/claude-deep-evolve
- **deep-review**: https://github.com/Sungmin-Cho/claude-deep-review
- **deep-docs**: https://github.com/Sungmin-Cho/claude-deep-docs
- **deep-dashboard**: https://github.com/Sungmin-Cho/claude-deep-dashboard

---

**🔁 Reminder**: 이 CLAUDE.md는 의도적으로 짧게 유지됩니다. 새 버전 release 시:

1. **CHANGELOG에 상세 기록** (이 파일이 아님 — drift 방지)
2. **schema 변경 (Storage layout / Lifecycle actions / Critical invariants 영향)** 있으면 해당 섹션만 sync
3. **deep-suite marketplace 동기화** (위 "CRITICAL" 섹션)
