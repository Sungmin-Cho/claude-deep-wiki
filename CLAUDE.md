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
│   ├── wiki-synthesizer-analysis.md    # (v1.4.1+) Stage 1 single-source A5 analysis (Write absent)
│   ├── wiki-synthesizer-worker.md      # (v1.4.1+) multi-source A4 worker + 2nd-pass merge (Write absent)
│   ├── wiki-synthesizer-inline.md      # (v1.4.1+) DORMANT — preserves v1.3.0 contract for restoration
│   └── wiki-page-writer.md             # (v1.4.0+) A5 page-body generator (tools: [])
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
│       ├── scan-vault-changes.sh  # vault에서 modified .md 감지 → /wiki-ingest 트리거
│       ├── envelope.js            # (v1.5.0+) M3 envelope shared lib (ULID, detectGit, wrap/unwrap)
│       ├── wrap-index-envelope.js # (v1.5.0+) CLI writer: payload → envelope, atomic temp+rename
│       ├── read-index-envelope.js # (v1.5.0+) CLI reader: envelope unwrap + legacy pass-through
│       └── test-helpers/
│           └── run-scan-vault.js  # (v1.5.1+) hermetic test helper (scrubHostEnv, runScanVault, parseHookOutput)
├── scripts/                     # (v1.4.1+) plugin-level utility scripts
│   ├── v0-probe/                # V-0/V-1/V-2/V-3 verification harness
│   ├── lint-agent-tools.sh      # frontmatter lint (4-agent manifest, Bash 3.2)
│   └── validate-envelope-emit.js  # (v1.5.0+) release-lint, suite envelope schema mirror
├── tests/                       # (v1.5.0+) Node test runner (`npm test`)
│   ├── envelope-emit.test.js          # wrap roundtrip + identity gates + parseArgs edge
│   ├── envelope-chain.test.js         # multi-source contract + reader pass-through + atomic write
│   ├── auto-ingest-golden.test.js     # (v1.5.1+) scan-vault-changes.sh fixture-corpus golden (M5.5 #3)
│   ├── pending-scan-recovery.test.js  # (v1.5.2+) .pending-scan recovery 7 cases A-G (M5.5 #5)
│   └── fixtures/
│       ├── sample-index.json          # release sample (Phase 3 payload-registry input)
│       └── golden/                    # (v1.5.1+) 8-scenario auto-ingest corpus + README
├── package.json                 # (v1.5.0+) test runner manifest (private, no runtime deps)
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
    │                            # (v1.4.0+) optional `partial_fail:
    │                            # {ts, failed_pages, reason}` field —
    │                            # written by Step 7.6.F when any page
    │                            # in a fanout run fails; removed on
    │                            # repair-on-success (Case ii); causes
    │                            # Step 1.5 to force REPAIR override
    │                            # via `partial-fail-recovery`
    │                            # repair_reason on next session.
    ├── .config.json             # (v1.4.0+) optional A5 knobs:
    │                            # {a5_fanout_threshold (default 3),
    │                            #  a5_worker_timeout_sec (default 90,
    │                            #  aspirational per W9)}. Loaded via
    │                            # python3 (preferred) or jq (fallback).
    │                            # Absence = defaults; no migration.
    ├── .versions/               # 페이지 backup (write 전 snapshot, last 3)
    ├── .wiki-lock/              # mkdir-based concurrency lock
    ├── .last-scan               # SessionStart hook의 마지막 committed scan window
    ├── .pending-scan            # 진행 중인 scan window (promote 안 됨 = ingest 미완료)
    ├── .failed-sources.tsv      # (v1.3.0+) Path-level retry manifest for
    │                            # partial-fail multi-source ingest. TSV:
    │                            # <source_path>\t<reason>\t<ts>. Hook reads
    │                            # alongside .pending-scan; cleared on full
    │                            # success.
    └── .pending-scan-retry-count  # (v1.3.0+) All-workers-fail counter for
                                 # 3-strike ingest-fail trigger. Format:
                                 # <window_epoch>:<count>. Cleared on
                                 # success or 3-strike trigger.
```

### Lifecycle actions (log.jsonl `action` field)

- `ingest` — 정상 처리, 새/갱신 페이지 emit. **(v1.4.0+)** additive
  `pages_failed: [<file>...]` field on `ingest` lines whenever
  FAILED_PAGES OR FAILED_WORKERS is non-empty (A5 fanout partial-fail
  audit; wiki-lint Step 6 LOG-INVARIANT scan unaffected — additive
  field). **(v1.4.2+)** additive `phase_timing_ms:
  {stage_1_analysis, stage_2_fanout, stage_3_write, total}` (ms
  integers) field on `ingest` lines (B3 telemetry; wiki-lint Step 6
  unaffected — schema-additive). Field omitted from non-`ingest`
  lifecycle actions.
- `ingest-skip` (v1.2.0+) — bytes hash unchanged AND wiki state intact → skip
- `ingest-repair` (v1.2.0+) — bytes unchanged BUT wiki state drift → 자가복구 (`pages_created:[]` 제약). **(v1.2.1+)** Triggers expanded: now also fires on `log.jsonl` absence and `no-prior-terminal-log` (R3W2). Slug allocator (R3W1, in-batch ledger + on-disk yaml) prevents same-batch basename cross-attribution before this check fires. Caveat (W-α): when triggered by log absence, historical creation records are not synthesized — log-based audit reconstruction will be incomplete; per-source yaml is the authoritative provenance record.
- `update` — 직접 페이지 수정
- `lint` — health check 실행 + auto-fix
- `rebuild` — index 재생성
- `delete` — 페이지 삭제
- `query-filed` — `/wiki-query`가 cross-page synthesis를 자동 페이지화
- `setup` — `/wiki-setup` 초기화 시 seed (welcome.md)
- `ingest-fail` (v1.3.0+) — emitted when the all-workers-fail retry counter
  reaches 3 consecutive batches on the same `.pending-scan` window.
  Promotes the window despite failure (releases stuck state) and records
  affected source paths + 3 prior failure timestamps. Counter
  (`<wiki>/.wiki-meta/.pending-scan-retry-count`, format
  `<window_epoch>:<count>`) resets on any successful batch (full or
  partial — partial relies on `.failed-sources.tsv` for per-source
  retry).

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

### Spec/Plan ordering instructions (v1.3.0+)

When a spec/plan directs a code or doc change involving relative position
("above X", "below Y", "before Z"), name the surrounding pattern so the
implementer can verify intent against context. v1.2.1 cycle-3 lesson —
ambiguous "above" instruction conflicted with surrounding
chronological-oldest-first pattern; the implementer caught it via atomic
fixup commit, but the spec writer could have been more precise.

- Bad: "Insert v1.2.1 above v1.2.0"
- Good: "Insert v1.2.1 above v1.2.0 (chronological-newest-first ordering — newest version at top)"
- Good: "Insert v1.2.1 below v1.2.0 (chronological-oldest-first ordering — keep historical order)"

Apply this whenever editing CHANGELOG, Recent releases, version-tagged
bullet lists, or any list whose insertion order matters.

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

**Implementation review (Step 6) lesson (v1.2.1 cycle-3):** for config /
hook / parser-driven changes, verify spec text execution against the actual
parser, not just self-consistent spec text. v1.2.1 cycle-3 found a config
syntax mismatch that cycles 1+2 missed because they verified the spec was
internally coherent without testing parser execution. (A companion change
in the deep-review repo's `commands/deep-review.md` reinforces this in the
final code-reviewer prompt — see deep-review v1.3.x release notes; merge
status is optional for deep-wiki releases.)

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
- **v1.2.0** (2026-04-30) — throughput + lint hardening + ingest-repair self-healing
- **v1.2.1** (2026-05-02) — patch: Step 1.5 hash-skip integrity hardening (R3W1 slug-collision allocator with in-batch ledger, R3W2 forced-repair on missing log signal, parser fixes for inline-list/single-quote yaml + explicit array init), wiki-lint false-positive elimination (T10 http(s) URL exclusion, W7 multi-line indented code block strip with `in_indented_code` state), per-source provenance preservation (B5 dual-classification scheme), README cloud-mirror corrections, RW5+CR-E hook frontmatter line-1 opening guard, RW6 synthesizer message-boundary count covers Phase 1c, B5 Step 10 prose update.
- **v1.3.0** (2026-05-02) — minor: A4 synthesizer fanout (Approach B — workers parallel-analyze, main aggregates + writes under single lock; lock branch-scoped: multi-source Phase 0, single-source Phase 3) for multi-source `/wiki-ingest` (~30-50% wall-clock reduction on 3+ source batches); cross-worker page collisions trigger second-pass synthesis in worker mode with new `colliding_drafts` input. Hook YAML parser broaden (inline + dotted forms accepted in addition to block; same broaden applied to `wiki-lint.md` `lint.orphan_ignore` mirror parser; pre-existing latent multi-item block-list drop bug also fixed). 6 polish items (1.1 awk-based delimiter-aware slug-allocator extractor [v1.3.0 plan reframe of Cycle-1 CV-3 sed bug], 1.2 tab-indent code block strip, 1.3 post-list 2-blank reset, 1.4 spec/plan ordering convention, 1.5 implementation review prompt tweak [+ optional companion deep-review repo PR], 1.6 README config syntax sweep). New `ingest-fail` lifecycle action for stuck-window recovery after 3 consecutive all-workers-fail batches. New `.failed-sources.tsv` manifest for partial-fail per-source retry. Tier 3 D=status-quo, E=defer-v1.4.0+. Single-source ingest byte-identical to v1.2.1.
- **v1.5.2** (2026-05-12) — **(현재)** patch: M5.5 #5 — `.pending-scan` recovery integration test. tests-only release, production code 변경 없음. 신규 `tests/pending-scan-recovery.test.js` (7 node:test 케이스, hermetic via `HOME=tmpRoot` + tmpRoot config — 실제 `~/.claude/deep-wiki-config.yaml` / 실 vault 미접근). 케이스 A-G: A) invalid `.pending-scan` (non-ISO-8601) → fresh timestamp overwrite + no-crash. B) valid `.pending-scan` → **verbatim 보존** across hook fires (H1 regression guard from ultrareview bug_006 — every-fire overwrite 시 oldest-detection-window lower bound 소실 차단). C) dangling `.pending-scan` (older than `.last-scan`) → 양쪽 preserved + no-crash (wiki-lint Step 11 State B target). D) `.last-scan` 부재 + valid `.pending-scan` → pending이 LAST_SCAN으로 사용 + preserved. E) fresh install (둘 다 부재) → 현재 ISO-8601 timestamp로 `.pending-scan` 생성. F) empty `.pending-scan` (truncate mid-write crash 시뮬) → valid timestamp overwrite. G) corrupt UTF-8 → clean overwrite, no non-printable bytes 잔존. `wiki-lint.md` Step 11/12 stale-detection-and-fix protocol (Claude follows markdown protocol — directly testable 아님)의 executable companion. Test count 119 → 126 (+7). `.claude-plugin/plugin.json` + `package.json` 1.5.1 → 1.5.2; `scripts.test` glob에 `tests/pending-scan-recovery.test.js` 추가. PR #15 (M5.5 #3, v1.5.1) 위 stack. Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #5.
- **v1.5.1** (2026-05-12) — patch: M5.5 #3 — `hooks/scripts/scan-vault-changes.sh` (SessionStart auto-ingest detection) golden test pin. tests-only release, production code 변경 없음; detected-count / file-list / exit-code / `.pending-scan` preservation 컨트랙트가 fixture corpus로 regression-protected. 신규 `hooks/scripts/test-helpers/run-scan-vault.js` — hermetic helper: `scrubHostEnv()` HOME/CLAUDE_PROJECT_DIR/DEEP_WIKI_ROOT 제거 (개발자 실제 config + vault leak 차단), `runScanVault()` `HOME=tmpRoot` spawn + tmpRoot/.claude/ 안에 yaml materialize, `parseHookOutput()` 한국어 헤더 카운트 + 파일 라인 추출. `claude-deep-work` PR #29 phase-guard golden pattern mirror. 신규 `tests/auto-ingest-golden.test.js` — node:test driver: `tests/fixtures/golden/<name>.{input,expected}.json` pair 발견, half-commit loud-fail, `vault_tree` tmpdir materialize, `mtime_offsets` via `fs.utimesSync` (deterministic mtime 비교), `.last-scan` / `.pending-scan` pre-seed → exit code + 헤더 카운트 + expected/forbidden 파일 셋 + `pending_scan_preserved` assert. 신규 `tests/fixtures/golden/` — 8 시나리오: (1) empty vault → silent exit, (2) 3 new .md → 전부 detect, (3) `.obsidian/` + `.trash/` 제외 (find prune), (4) `.last-scan`보다 오래된 파일 필터, (5) `auto_ingest.require_tag: project` → 태그 있는 것만, (6) `auto_ingest.ignore_globs: [archive/**]` → archive 제외, (7) `deep-wiki-config.yaml` 부재 → silent exit, (8) valid `.pending-scan` verbatim 보존. deep-work reference 대비 deviation: free-form 한국어 systemMessage stdout이라 JSON `{decision, reason}` parse 대신 헤더 regex + 파일 라인 parse; `${VAULT_ROOT}` / `${WIKI_ROOT}` template substitution + `mtime_offsets` 추가 (vault-fixture mtime control이 hook intrinsic). obsidian-cli supplement (`obsidian recents`)는 helper가 PATH에 obsidian 미배치 → 자연 skip (mock shim out of scope). `package.json` test glob에 추가; `.claude-plugin/plugin.json` 1.5.0 → 1.5.1. Test count 111 → 119 (+8). Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #3.
- **v1.5.0** (2026-05-11) — minor: M3 envelope adoption. `<wiki_root>/.wiki-meta/index.json`이 M3 cross-plugin envelope (claude-deep-suite/docs/envelope-migration.md §1) wrapper 안으로 들어감. legacy `{pages, generated_at}` 구조는 그대로 `payload` 보존 — 기존 jq pipeline 은 envelope-aware reader (`hooks/scripts/read-index-envelope.js`) 를 통해 수정 없이 동작 (legacy + envelope 양쪽 통과). 새 helpers: `hooks/scripts/{envelope,wrap-index-envelope,read-index-envelope}.js` (zero-dep, atomic write temp+rename, ULID MSB-first, plugin.json literal-cwd-resolve), `scripts/validate-envelope-emit.js` (release-lint, suite envelope schema mirror, additionalProperties strict, ULID/SemVer 2.0.0/RFC 3339/kebab-case regex, identity check + corrupt-payload defense). 새 tests: `tests/{envelope-emit,envelope-chain}.test.js` 87+ tests (wrap roundtrip, identity gates, parseArgs 빈 값 거부 — scalar AND repeatable, atomic-write residue, envelope-aware reader legacy pass-through, multi-source aggregator contract — parent_run_id 부재, source_artifacts path-only). 새 fixture: `tests/fixtures/sample-index.json` (Phase 3 payload-registry replacement input). `commands/{wiki-setup,wiki-rebuild,wiki-ingest,wiki-query,wiki-lint}.md` 의 index.json reader/writer path 가 envelope-aware helpers 호출로 전환; in-memory merge 는 unwrapped payload 위에서 동작하므로 기존 ingest 로직 그대로. `skills/wiki-schema/SKILL.md` §Index 가 envelope wrapper + identity contract 문서화. **Multi-source aggregator** — index.json 은 page frontmatter scan 결과로 단일 parent 가 없으므로 `parent_run_id` omit, page paths 만 `provenance.source_artifacts[]` path-only 기록 (markdown — envelope detect 불가). 사용자 wiki 의 legacy index.json 은 reader 가 graceful 통과 — `/wiki-rebuild` 시 envelope 형태로 재포장 (데이터 변경 없음). **M3 Phase 2 의 6 번째 (마지막) plugin** — suite-side Phase 3 (marketplace.json SHA bump, payload-registry schema 교체, adoption ledger 갱신) 가 본 PR merge 후 진행됨. T+0 timer 기록 + ledger 갱신은 본 PR 에서 의도적으로 하지 않음 — Phase 2 §1 정책이 모든 suite-repo 변경을 Phase 3 일괄 처리에 예약.
- **v1.4.2** (2026-05-07) — patch: 4-item v1.4.1 backlog 닫기 + 2-round /deep-review post-impl fixups. F1 (HIGH) — synthesizer `existing_page_body` truncation으로 인한 C3 false-positive abort 차단: main이 Stage 1 return 후 disk에서 페이지를 다시 읽어 disk bytes를 C3 hash baseline + Stage 2/inline-write context로 사용 (이전 P6 hash-from-emit 패스 흡수). v1.4.1 cache-active dogfood에서 발견 (12377B disk → 725B emit 등). F2 (MEDIUM) — single-source Stage 1 dispatch §3.9 4번째 invocation site 추가 (label `"A5-analysis"`); v1.4.1의 3-site 브래킷 (A4-fanout / A4-second-pass / A5-fanout)이 single-source Stage 1을 미보호한 갭 닫음. /deep-review round 1 I1 deferred. B3 (MEDIUM) — `log.jsonl` `ingest` 라인의 `phase_timing_ms` 텔레메트리 (`{stage_1_analysis, stage_2_fanout, stage_3_write, total}` ms 정수, schema-additive). v1.4.0 plan §10.2 deferred. `_ts_ms` helper (Bash 3.2 portable; python3 우선, `date +%s000` 폴백). I2 (LOW) — V-2/V-3 WebFetch probe full-URL 매칭: `webfetch-stub-server.py`에 6번째 TSV column `<host>` 추가 + `v2-v3-record.sh` full-URL `<host><path>?<query>` 비교; cross-host + query-string exfil 양쪽 detect. /deep-review round 1+2 deferred. **Post-impl fixups (3-way /deep-review 3 rounds, 13 critical + 4 warning 모두 ACCEPT)**: F1.1 sub-threshold drift→A5 fanout escalate (silent corruption 차단), F1.2 Step 7.6.C entry에서 PARTIAL_FAIL 보존 (sentinel 누락 차단), F1.3 basename regex pre-disk-read 가드 (path traversal 차단), B3.1 path-coverage matrix를 Step 10 omission rule과 정합 (4-column 표), F1.4+F1.5 byte-identical claim 제거 + agent doc Rule 4 정확성 (synth bytes → telemetry-only), W3 set -u defaultization, W4 v2-v3-record empty log short-circuit, **R2.F1.6 hash-compare로 size-delta 대체** (concurrent-ingest baseline race 차단 — synth_hash != disk_hash 시 force fanout), **R2.F1.7 all-dropped→`do_all_failed_under_lock`** (terminal-skip bypass 차단 — partial_fail sentinel 항상 작성), R2.C1 CLAUDE.md byte-identical 표현 drift 정정, **R3.P2.1 slug-vs-descriptor mismatch 차단** (`slug="${SOURCES[0]%%|*}"` 추출), **R3.P2.2 single-source F1 all-fail 3-strike retry counter** (Step 7.5.M-D 패턴 mirror — count≥3 시 ingest-fail emit + .pending-scan promote), R3.C-1 mkdir soft-fail + `trap - EXIT` 정상화, R3.C-2 first-ingest baseline yaml R4-Adv-Adv-2 mirror 적용, R3.C-3 `FAILED_PAGE_FILES` parallel array init + push, R3.W-1 stage_3_write를 STAGE_3_START_MS_FAIL로 한정, R3.W-2 reason taxonomy "all f1 dropped" 추가. L1 + L2 mandatory verbatim language v1.4.1 §11.5에서 계승 (L1는 V-2/V-3 SECOND run empirical addendum 미포함 명시, L2는 §3.9 in-root scope 유지). 외부 API 변경 없음; F1 `existing_body_hash` disk-authoritative read는 hash 값 v1.4.1과 byte-identical 아님 (`$(cat)` newline-strip vs v1.4.1 `printf '%s' "$emit"`), 그러나 `$(cat)`이 F1 capture와 C3 re-check 양쪽에 symmetric이라 Stage 3 success/abort 결정은 spec-compliant agent 기준 동등; non-compliant emit은 stderr WARN 라인 + sub-threshold drift 시 A5 fanout escalate (F1.1).
- **v1.4.1** (2026-05-06) — patch: Track C trust-boundary closure (best-effort, layered defense). 단일 `agents/wiki-synthesizer.md` 삭제 (Option B per §3.4 — shim 없음) + 역할별 3개 에이전트로 split (`wiki-synthesizer-{analysis,worker,inline}.md`); 활성 경로 (analysis + worker)는 `tools:` 선언에서 `Write` 부재, inline은 DORMANT (`status: dormant`, `last_known_active: v1.3.0`, `contract_frozen_at: a9966c7`). `commands/wiki-ingest.md` 12개 dispatch 사이트가 qualified namespace `deep-wiki:wiki-synthesizer-{analysis|worker}` + `deep-wiki:wiki-page-writer`로 라우팅; Step 7.6.A V-0/C3 코멘트가 `general-purpose` downgrade 금지. V-0 empirical finding: qualified resolve, unqualified는 명시적 Agent-not-found (silent substitution 없음) — v1.4.0 dogfood 실패의 진짜 원인은 caller 자발적 downgrade. 신규 도구: `scripts/lint-agent-tools.sh` (4-에이전트 manifest, Bash 3.2 portable, WebFetch URL allowlist string-match) + `_post_dispatch_dirty_scan()` shell 함수 (3개 사이트, `WIKI_TEST_MODE=1` env-gated, 프로덕션 비용 0). V-runs: V-0 PASS via Mechanism B, V-1 ALL 3 surfaces PASS, V-2/V-3 UNDETERMINED-extrapolated (Path A acceptance per §6 fix-and-go cap). Known limitations (mandatory per §11.5): L1 (V-0 best-effort without runtime metadata API) + L2 (§3.9 in-root scope only, NOT off-root writes — v1.4.0 dogfood 실패 모드 미커버). 단일 소스 A5 + 다중 소스 A4 경로 v1.4.0과 structurally equivalent (NOT byte-identical). 외부 caller 마이그레이션: `subagent_type: "wiki-synthesizer"` → qualified `deep-wiki:wiki-synthesizer-{inline|analysis|worker}` (shim 없음).
- **v1.4.0** (2026-05-05) — minor: A5 page-level fanout. Single-source `/wiki-ingest`가 페이지 본문 생성을 N `wiki-page-writer` worker에 병렬화 (≤5분 wall-clock 목표는 무제한 subagent 병렬성을 전제했으나, 2026-05-05 real-vault dogfood [14-page plan, 295-page wiki]에서 Claude Code 런타임 concurrent-subagent cap ~3 환경 기준 ~17분 측정 — Stage 1 ~7분 + Stage 2 ~10분; v1.3.0 ~15분 baseline 대비 미감소. CHANGELOG 성능 주석 + `docs/handoff-2026-05-05-v1.4.x-followup.md` Section A 참조; 정량적 per-stage 측정은 v1.4.1 B1+B3로 보류; M1 trust-boundary 실증으로 Track C agent split 우선순위 격상). Stage 1 (`wiki-synthesizer mode="analysis"`)이 page_plan + (sub-threshold 시) inline_bodies emit; Stage 2가 영향 받는 페이지마다 하나씩 `wiki-page-writer` worker 병렬 dispatch (`len(page_plan) ≥ a5_fanout_threshold`, default 3); Stage 3 main이 lock 아래 aggregate + atomic-write, mandatory C3 concurrency check (update: hash 비교, create: existence check). Karpathy "10–15 page touches per source" 속성 보존 — A5는 누가 쓰는지 바꾸지 페이지 수 안 바꿈. **Single-source semantics 보존하나 byte-identical NOT** (v1.3.0의 inline-mode 대신 analysis-mode routing으로 ~10–25% wall-clock variance). 다중 소스 (≥2) 경로 v1.3.0 A4 그대로; A4×A5 결합은 v1.4.1+로 보류. 새 schema: `partial_fail` sentinel in `sources/<slug>.yaml` (A1 hash-skip override + Step 1.5 cascading), `pages_failed` log 필드 (additive), 신규 optional `<wiki>/.wiki-meta/.config.json` (`a5_fanout_threshold`, `a5_worker_timeout_sec`). 신규 `partial-fail-recovery` repair_reason 값. 신규 agent: `wiki-page-writer` (tool `[]` — 파일 I/O 없음, JSON 객체만 emit하고 main이 Stage 3 lock 아래 write). `wiki-synthesizer`에 `mode: "analysis"` 추가 (additive; inline+worker mode v1.3.0 byte-identical). Failure handling: Step 7.7.A-F (per-worker / all-fail / mid-loop / C3 abort / timeout / R4 metadata pipeline recovery). R-P1 dual fallback (`shasum -a 256 || sha256sum`) Linux portability. Plan 4 review cycles (18→7→9→7 items, fix-and-go cap; 38 substantive fixes 적용). Phase 6 sandbox tests 사용자 재량으로 보류, W2 fault-injection v1.4.1.

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
