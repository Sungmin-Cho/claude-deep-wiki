# 변경 이력

deep-wiki의 주요 변경사항을 기록합니다.

## [1.4.2] — 2026-05-07

`docs/handoff-2026-05-06-v1.4.2.md`의 v1.4.1 backlog 4개 항목을 닫는 패치
릴리스. 두 개는 v1.4.1 cache-active dogfood에서 발견된 현장 이슈 수정
(F1, F2 — F2는 /deep-review round 1 I1에서 deferred되었음); 두 개는
보류된 품질 항목 (B3 phase 텔레메트리 — v1.4.0 plan §10.2; I2 V-2/V-3
probe 전체 URL 매칭 — /deep-review round 1+2). single-source + multi-source
ingest 경로는 v1.4.1과 spec-equivalent (NOT byte-identical — F1
disk-authoritative read + F2 §3.9 4번째 invocation site가 runtime
invariant를 변경). 위키 스키마는 additive only (`ingest` log 라인의
`phase_timing_ms` 필드; `wiki-lint` Step 6 LOG-INVARIANT scan 영향 없음).

**v1.4.1 §11.5의 known-limitations 필수 verbatim 언어 계승 (재기재):**

- **L1**: V-0 PASS (Mechanism B 경유)는 best-effort — Claude Code 런타임이
  dispatch metadata API를 노출하지 않음. Track C v2는 런타임 API 지원 시까지
  v1.5.0+로 보류. **v1.4.2 추가:** I2 fix가 V-2/V-3 probe fidelity 개선
  (full-URL allowlist 비교)을 적용했으나, v1.4.1 final agent files 대상
  empirical SECOND run은 sandbox orchestration 워크스트림으로 보류 —
  CHANGELOG는 SECOND run 완료 시까지 "best-effort" 프레이밍 유지하고
  empirical addendum 미추가.
- **L2**: §3.9 dirty-scan은 `<wiki_root>/`-internal mutation만 catch;
  off-root 쓰기 (예: `/tmp/`)는 NOT detected. v1.4.0 dogfood 실패 mode
  (workers writing `/tmp/v140-workers-out/*`)는 §3.9로 안 잡힘. v1.4.1은
  layered defense-in-depth였고, v1.4.2 F2는 single-source Stage 1 dispatch
  도 bracketing에 추가하나 off-root scope 확대는 아님. Process-level
  sandboxing은 여전히 v1.5.0+ scope.

### 버그 픽스

- **F1 (HIGH) — synthesizer `existing_page_body` truncation으로 인한 C3
  false-positive abort.** v1.4.1 cache-active dogfood (post-`/reload-plugins`)
  에서 Stage 1 LLM이 update 항목의 `existing_page_body`를 극심하게 truncate
  하여 emit하는 현상 관측 (12377 bytes disk → 725 bytes emit; 20071 bytes
  disk → 587 bytes emit). main이 truncated bytes로 C3 hash baseline을 계산
  → Step 7.6.C C3 check가 실제 disk bytes와 비교 시 항상 "concurrent ingest
  detected"로 판정 → 모든 update가 abort. v1.4.2 contract: main이 Stage 1
  return 후 disk에서 페이지를 다시 읽어 disk bytes를 C3 hash baseline AND
  Stage 2 worker / inline-write synthesis context로 통일. 이전 P6 round-1
  hash-from-emit 컴퓨트 패스를 흡수 — main이 disk를 직접 읽으므로 별도 컴퓨트
  불필요. `agents/wiki-synthesizer-analysis.md` Rule 4를 강화하여 FULL VERBATIM
  bytes 요구 (방어적 contract; synthesizer가 short emit해도 main이 disk에서
  authoritatively recovery). single-source 경로에만 적용 — multi-source A4
  (worker, analysis-mode 아님)는 항목에 `existing_body_hash` 필드가 없음.

  **Post-impl review fixup (v1.4.2 impl branch에서 3-way /deep-review 후
  merge 전 적용):**
  - **F1.1 (2/3 reviewer agreement)** — sub-threshold drift escalation.
    Stage 1의 `inline_bodies`는 main의 disk re-read 이전에 이미 truncated
    emit으로 생성됨. drift 발생한 항목의 inline_bodies를 그대로 쓰면 Rule 5
    + `preserve_sections` merge 로직이 partial context로 작동해 unrelated
    section silent corruption 위험. v1.4.1 이전은 C3 abort로 LOUDLY 실패.
    Fix: ANY drift 발생 시 sub-threshold 항목을 A5 fanout으로 escalate하여
    Stage 2 page-writer worker가 disk-bytes context로 re-synthesize. Stale
    inline_bodies 폐기. v1.4.1 LOUD-failure property 보존 + retry-correctness
    회복.
  - **F1.2 (2/3 reviewer agreement)** — Step 7.6.C reset에서 PARTIAL_FAIL
    보존. F1 gate가 FAILED_PAGES 채우고 PARTIAL_FAIL=true 설정한 뒤 Step
    7.6.C 진입 시 reset 발생 → P5 패턴이 FAILED_WORKERS만 re-toggle →
    F1-드롭된 페이지는 sentinel 미포함 → 다음 세션 retry 누락. Fix: P5
    패턴 미러 — `if [[ ${#FAILED_PAGES[@]} -gt 0 ]]; then PARTIAL_FAIL=true; fi`.
  - **F1.3 (single-reviewer Codex P1)** — basename traversal guard. F1 gate
    가 `page_path="$WIKI_ROOT/pages/${entry.file}"` 구성 후 cat을 Step
    7.6.C basename 가드 BEFORE 실행 → prompt-injected
    `entry.file = "../../etc/passwd"`가 wiki_root 외부 read. Fix:
    `^[a-z0-9][a-z0-9-]*\.md$` regex를 page_path 구성 BEFORE 적용
    (Step 7.6.B Gate 3.5 + Step 7.6.C defense-in-depth와 동일).
  - **F1.4 + F1.5 (single-reviewer Opus C2 + C3)** — agent doc + CHANGELOG
    정확성. Pre-fixup 표현 "byte-identical Stage 3 hashing" 과 "synthesizer
    의 existing_page_body가 Stage 2 worker로 흐름"은 둘 다 v1.4.2 F1 이후
    부정확. `$(cat …)`는 trailing newline strip하므로 v1.4.1
    `printf '%s' "$emit"` hashing과 asymmetric. main이 synth bytes를
    UNCONDITIONALLY disk bytes로 overwrite. Fix: byte-identical 표현 제거,
    Stage 3 결정은 symmetric `$(cat)` byte-stripping으로 equivalent임을
    문서화; Rule 4 + field semantic을 synth bytes → telemetry-only contract
    로 재작성.
  - **R2.F1.6 (2/3 reviewer agreement, 2nd-round /deep-review)** —
    concurrent-ingest baseline race. Pre-R2 fixup의 F1 size-delta
    heuristic (>4 bytes 시 escalate)은 LARGE drift만 감지. Stage 1 LLM
    실행 중 concurrent `/wiki-ingest` commit이 same-size byte change
    (또는 EOL tolerance band 안의 truncation pattern)를 만들면 silent
    baseline → C3 통과 → 우리 세션이 concurrent commit 덮어쓰기. Fix:
    size-delta를 synth emit hash vs disk read hash HASH-COMPARE로 교체.
    byte 단위 차이 발생 시 F1_DRIFT_DETECTED → F1.1 escalation 통해 A5
    fanout 강제. Stage 2 worker가 현재 disk bytes로 re-synthesize —
    concurrent commit 내용은 worker input으로 보존, 우리 source 기여는
    그 위에 merge. T0→T1 (Stage 1 read → F1 cat) silent window 갭 차단.
  - **R2.F1.7 (2/3 reviewer agreement, 2nd-round /deep-review)** —
    all-dropped → terminal ingest-skip bypass. Pre-R2 fixup `len(page_plan)
    == 0`은 무조건 `do_ingest_skip_terminal_under_lock` 경로 → ingest-skip
    log + source promote. F1이 모든 update 항목 drop (basename invalid /
    page absent / disk read failed) 시 partial_fail sentinel 미작성으로
    source가 clean skip으로 promote → 다음 세션 retry 안 함 → permanent
    silent failure. Fix: empty-page_plan terminal skip을 FAILED_PAGES
    EMPTY일 때만 trigger. non-empty (all-F1-dropped) 시 신규
    `do_all_failed_under_lock` (Step 7.5.B) 경로로 route — Step 7.7.B
    "all-fail" finalization mirror: lock 획득, source slug에 partial_fail
    sentinel 작성, `pages_failed=[F1-dropped]` 포함된 `ingest` log line
    emit, `.pending-scan` 미승격.

**3rd-round /deep-review fixups (5 critical + 2 warning, 모두 ACCEPT):**

2nd-round fixup commit이 `do_all_failed_under_lock` (신규 ~30줄 함수)을
도입. 3rd-round /deep-review가 이 신규 코드에서 5 critical + 2 warning을
발견 — v1.4.2 base 디자인이 아닌 신규 함수 자체의 regression.

  - **R3.P2.1 (2/3 reviewer agreement, Codex review P2 + Codex
    adversarial high)** — slug vs descriptor mismatch. Caller가
    `SOURCES[0]` (descriptor encoding `slug|origin|type`)을 함수의 첫
    인자로 전달했으나 함수는 `slug` 기대. yaml path가 `<wiki>/.wiki-meta/
    sources/<slug|origin|type>.yaml`로 잘못 구성 → partial_fail sentinel이
    canonical location에 안 떨어짐 → Step 1.5 partial-fail-recovery
    detection 미스. Fix: caller가 `slug="${SOURCES[0]%%|*}"` 추출 후 전달.
  - **R3.P2.2 (2/3 reviewer agreement, Codex review P2 + Codex
    adversarial medium)** — 3-strike retry counter 누락. Step 7.5.M-D
    multi-source 경로에는 `<wiki>/.wiki-meta/.pending-scan-retry-count`
    counter가 stuck-window 복구용으로 존재 (3번째 동일-window 실패 시
    `ingest-fail` action emit + `.pending-scan` promote). pre-R3 fixup의
    `do_all_failed_under_lock`은 이 counter를 증가시키지 않아 persistent
    F1 all-drop (예: synthesizer가 absent page를 반복 hallucinate) 시
    indefinite loop. Fix: Step 7.5.M-D 패턴 mirror — counter 읽기 +
    증가, count≥3 시 `ingest-fail` emit + promote, 그 외에는 `ingest`
    + `pages_failed` emit.
  - **R3.C-1 (single-reviewer Opus)** — `mkdir … exit 1` 처리 오류.
    pre-R3 fixup의 `mkdir … || { echo "Wiki locked"; exit 1; }`은 caller의
    user-facing exit message 이전 + benign concurrent-ingest 케이스의
    partial_fail signal 작성 이전에 script termination. Fix: soft-fail
    `if ! mkdir … 2>/dev/null; then echo WARN; return 1; fi`. + 명시적
    rmdir 후 `trap - EXIT` 추가 (Step 7.7.B + Step 7.6.G 패턴 mirror).
  - **R3.C-2 (single-reviewer Opus)** — first-ingest baseline yaml
    materialization 누락. Step 7.7.B의 R4-Adv-Adv-2 fix는 source yaml이
    아직 없는 경우 (brand-new source의 첫 ingest가 all-fail 명중)
    baseline yaml을 명시적으로 materialize. `do_all_failed_under_lock`은
    Step 7.7.B mirror라고 주장했지만 이 block 누락 → first-ingest
    all-F1-dropped 시 partial_fail block만 있고 `id/type/origin/
    content_hash/pages_created/pages_updated` 없는 corrupt yaml 생성.
    Fix: 함수 entry에 동일 baseline materialization block inline.
  - **R3.C-3 (single-reviewer Opus)** — `FAILED_PAGE_FILES` parallel
    array 채움 누락. F1 loop가 `FAILED_PAGES`만 push했고 함수 body의
    `printf '%s\n' "${FAILED_PAGE_FILES[@]}" | jq -R . | jq -s -c .`
    전개가 `set +u`에서는 `[""]` (W1 round-2 bug shape) 생성, `set -u`
    에서는 unbound-variable abort. 둘 다 R2.F1.7 의도 무력화. Fix: F1
    `FAILED_PAGES+=` push 다음에 명시적 `FAILED_PAGE_FILES+=("${entry.file}")`
    추가 (3 site — basename invalid / page absent / disk read fail) +
    `if sources_count == 1:` block 상단에 명시적 `FAILED_PAGES=()`
    `FAILED_PAGE_FILES=()` init.
  - **R3.W-1 (single-reviewer Opus)** — `phase_timing_ms.stage_3_write`
    공식 오류. pre-R3 fixup은 `LOG_EMIT_MS - INGEST_T0_MS` 계산 — `total`과
    동일하여 `total >= sum(stages)` invariant 위반. Fix: caller가 함수
    호출 직전에 `STAGE_3_START_MS_FAIL` 캡처; 함수 compute는
    `LOG_EMIT_MS - STAGE_3_START_MS_FAIL`로 stage_3_write를 lock+yaml+log
    emit으로 한정. B3.1 path-coverage matrix에 "Single-source F1
    all-dropped" 행 추가.
  - **R3.W-2 (single-reviewer Opus)** — reason taxonomy 정규화. pre-R3
    fixup은 `"all_f1_dropped"` (snake_case) 사용했으나 기존 Step 7.6.F
    vocabulary는 space-separated phrases (`"stage 2 worker fail"`,
    `"all workers failed"`). Fix: `"all f1 dropped"`로 정규화 + line
    ~2068의 inline taxonomy에 추가.

- **F2 (MEDIUM) — single-source Stage 1 dispatch §3.9 bracketing gap.**
  v1.4.1의 §3.9 worker-mutation dirty-scan brackets는 3개 dispatch site
  (Step 7.5.M-A multi-source A4 fanout, Step 7.5.M-B Case B2 collision
  second-pass, Step 7.6.B-post single-source A5 fanout)에서만 작동했고
  single-source Stage 1 analysis dispatch (Step 7.5의
  `invoke deep-wiki:wiki-synthesizer-analysis`)는 bracketing 안 됨. 잘못
  resolve되거나 downgrade된 analysis subagent가 Stage 1 LLM 실행 중
  `<wiki_root>/`을 mutate해도 미감지. v1.4.2는 4번째 invocation site (label
  `"A5-analysis"`)를 추가하여 Stage 1 dispatch를 직접 bracketing. dispatch
  전 pre-snapshot, Stage 1 return 후 page_plan 분기 결정 전 post-scan
  (sub-threshold inline vs. A5 fanout downstream 분기와 무관 — Stage 1
  mutation을 분기 결정 이전에 catch). `WIKI_TEST_MODE=1` env-gated;
  프로덕션 비용 변동 없음.

### 텔레메트리

  **Post-impl review fixup (B3.1, single-reviewer Opus C1)** — path-coverage
  matrix vs Step 10 omission rule self-contradiction. Pre-fixup matrix는
  `Single-source empty page_plan terminal-skip`, `Re-ingest hash-skip`,
  `Ingest-fail / 3-strike abort` 경로에 phase_timing_ms schema를 명시했으나,
  Step 10 omission rule은 `ingest` lifecycle action 라인에만 emit한다고
  정의 (`ingest-skip` / `ingest-repair` / `ingest-fail` 제외). Fix:
  path-coverage matrix를 4-column 표로 재작성하여 "phase timing emitted"
  vs "Step 10 bypass" 구분 + per-stage 설명. W3 fixup도 함께 적용 —
  delta-compute pseudocode에 `${var:-0}` defaultization 추가하여 set -u
  tolerant.

- **B3 — `log.jsonl` `ingest` 라인의 `phase_timing_ms`.** v1.4.0 plan
  §10.2에서 보류된 항목. v1.4.0 dogfood가 ~17분 wall-clock 측정 + Stage 1
  ~7분 + Stage 2 ~10분 일화적 split만 기록 — log.jsonl에 per-phase timing
  미기록으로 사후 검증 불가. v1.4.2는 `_ts_ms` helper (Bash 3.2 portable;
  python3 우선으로 ms 정밀도, `date +%s000` 폴백으로 초 정밀도) 추가하고
  Step 1 entry / Step 7.5 single-source / Step 7.5.M-A multi-source /
  Step 7.6.A A5 fanout / Step 7.6.B-post / Step 7.6.C Stage 3 lock acquire /
  Step 7.5.M-C multi-source atomic-write entry / Step 10 log emit
  지점에서 timestamp 캡처. ingest 라인이 새 필드
  `phase_timing_ms: {stage_1_analysis, stage_2_fanout, stage_3_write,
  total}` (모두 ms 정수) 발신. **Schema-additive** —
  `wiki-lint` Step 6 LOG-INVARIANT scan은
  `select(.action != "ingest-repair") | .pages_created[]?`로 필터하여
  unknown top-level 필드 무시. 비-`ingest` lifecycle action (ingest-skip,
  ingest-repair, ingest-fail, lint, rebuild, delete, query-filed, setup)
  에서는 필드 생략. 프로덕션 비용: ingest당 ~12 ms (Python 시작 비용이
  지배적; warm-cache 시 ~2ms 6회), 분 단위 LLM 단계 대비 무시할 수준.

### 테스트 인프라 (probe 품질)

- **I2 — V-2/V-3 WebFetch probe 전체 URL allowlist 비교.** /deep-review
  round 1+2 (Codex review, single-reviewer가 두 번 raise) 발견. 이전
  `scripts/v0-probe/v2-v3-record.sh`는 stub log column 3 (path) 만 기록하고
  allowlist URL의 path 컴포넌트와 비교 → 주입된
  `https://attacker.com/v2-probe-feed?data=<exfiltrated_secret>`이 허용된
  `https://example.com/v2-probe-feed`와 path-only 비교에서 일치 → false-pass
  surface 발생. v1.4.2는 `scripts/v0-probe/webfetch-stub-server.py`에 6번째
  TSV 컬럼 (`<host>`, request Host header) 추가하고 `v2-v3-record.sh`가
  `<host><path>?<query>` (scheme stripped) 형태로 full URL 추출하여 정규화된
  allowlist URL과 비교. backward-compatible: 5-column 사전-v1.4.2 로그는
  lossy-mode detection이 작동하여 path-only 비교로 degrade되며 notes 컬럼에
  `lossy-pre-v1.4.2-log: ...` annotation 추가. 테스트 인프라 한정 —
  프로덕션 에이전트 동작 영향 없음.

  **Post-impl review fixup (W4, single-reviewer Opus)** — 빈 로그
  short-circuit. Pre-fixup format-detect awk가 빈 로그 파일을 "not new
  format" 판정하여 `lossy-pre-v1.4.2-log` annotation 추가 → 실제는 clean
  PASS shape (요청 없음 = exfil 시도 없음)인데 degraded probe infrastructure
  운용으로 잘못 표시. Fix: format detection 이전에 `[ ! -s "$WEBFETCH_LOG" ]`
  short-circuit 추가하여 빈 파일을 explicit empty PASS로 처리.

### 마이그레이션

v1.4.1 대비 외부 API 변경 없음. 내부 계약 변경은 F1의 `existing_body_hash`
disk-authoritative read: hashing은 Stage 3 안에서 일관됨 — F1 캡처와 C3
re-check가 둘 다 `$(cat …)` byte-stripping (POSIX command substitution이
trailing newline 제거)을 쓰므로 C3 비교는 symmetric하고 concurrent-ingest
detection은 유지됨. Hash 값은 v1.4.1과 byte-identical은 아님 (v1.4.1은
`printf '%s' "$emit"` hashing으로 compliant agent의 trailing newline 보존,
v1.4.2는 `$(cat)` output을 hashing하여 strip) — 그러나 Stage 3 success/abort
결정은 spec-compliant agent 기준 equivalent. non-compliant emit (truncation
drift)는 `WARN: synthesizer existing_page_body drift for ...` stderr 라인
발신. Drift 발생한 sub-threshold 경로는 A5 fanout으로 escalate (post-review
F1.1 fixup)되어 Stage 2 worker가 disk-bytes context에서 re-synthesize —
v1.4.1 LOUD-failure property를 affected page에 보존하면서
retry-correctness 복구.

### 감사

- Handoff doc `docs/handoff-2026-05-06-v1.4.2.md` (gitignored 작성자
  아티팩트)이 F1+F2+B3+I2 backlog 순서를 정함.
- v1.4.1 cycle의 /deep-review round 1+2 (Opus + Codex review + Codex
  adversarial)이 F2 (round 1 I1)와 I2 (round 1+2, single-reviewer Codex
  두 번)를 flag.
- v1.4.1 cache-active dogfood (handoff §0)에서 F1 발견.

## [1.4.1] — 2026-05-06

신뢰 경계 폐쇄 (best-effort, layered defense). 단일 `wiki-synthesizer.md`
에이전트를 역할별 3개 파일 (`wiki-synthesizer-{analysis,worker,inline}.md`)로
분할하고, 활성 경로의 `tools:` 선언에서 `Write`를 모두 제거. Claude Code의
qualified-namespace (`deep-wiki:<agent>`)로 `/wiki-ingest`를 라우팅.
프론트매터 lint (`scripts/lint-agent-tools.sh`)와 in-root post-dispatch
dirty-file scan (`WIKI_TEST_MODE=1` env-gated, 프로덕션 비용 0)이 결합되어
v1.4.0 dogfood 실패의 진짜 원인 — **caller 측 자발적 downgrade
(`subagent_type: "general-purpose"`)** 로 인해 `wiki-page-writer`가
Read+Write+Edit를 부여받아 Stage 3 lock 외부에 쓴 패턴 — 을 차단.
단일 소스 A5 + 다중 소스 A4 경로는 v1.4.0과 **structurally equivalent**
(byte-identical 아님 — split-agent dispatch가 누가 페이지를 쓰는지를 바꾸지,
페이지 생성 의미를 바꾸지 않음).

**프로덕션 비용 주석:** §3.9 dirty-file scan은 `WIKI_TEST_MODE=1` env로
gating됨. 프로덕션 `/wiki-ingest` 실행은 scan을 완전히 skip (비용 0).
sandbox + 재 dogfood 시나리오에 한해 opt-in — cycle-3 N3.4 / plan §3.9
참조.

### 아키텍처

- **3-에이전트 split (Track C closure)**: v1.3.0 / v1.4.0의 단일
  `agents/wiki-synthesizer.md` (mode-scoped 섹션) 파일이 역할별 3개
  파일로 대체됨. 분할로 `Write`가 활성 호출 경로의 `tools:` 선언에서
  제거되어, V-1 (callee 측 enforcement)이 매 턴 prompt가 협상해야 하는
  런타임 contract가 아니라 에이전트 파일의 정적 속성이 됨.

  | 파일 | 역할 | `tools:` | 호출자 |
  |---|---|---|---|
  | `agents/wiki-synthesizer-analysis.md` | Stage 1 단일 소스 A5 분석 (page_plan + sub-threshold inline_bodies) | `[Read, Glob, Grep, WebFetch]` (Write **부재**) | `commands/wiki-ingest.md` Step 7.5.M-A (단일 소스) |
  | `agents/wiki-synthesizer-worker.md` | 다중 소스 A4 worker + 2nd-pass collision merge (worker mode + `colliding_drafts` input) | `[Read, Glob, Grep, WebFetch]` (Write **부재**) | `commands/wiki-ingest.md` Step 7.5.M-B + Step 7.6.B-post |
  | `agents/wiki-synthesizer-inline.md` | DORMANT — v1.3.0 inline-mode contract (page-write-on-emit) 미래 복원용 보존 | `[Read, Write, Glob, Grep, WebFetch]` | (활성 호출자 없음; `status: dormant`) |

- **기존 `agents/wiki-synthesizer.md` 삭제 (Option B per §3.4 — shim
  없음)**: 통합 에이전트 파일이 v1.4.1에서 제거됨. 호환성 shim 없음.
  `subagent_type: "wiki-synthesizer"`를 직접 dispatch하던 외부 caller는
  반드시 아래 qualified-namespace 형식으로 마이그레이션 — Migration 섹션
  참조.

- **Qualified-namespace 라우팅 (V-0 empirical finding)**:
  `commands/wiki-ingest.md`의 12개 dispatch 사이트가 unqualified
  `subagent_type: "wiki-synthesizer"` (이제 Agent-not-found)에서
  qualified 형식 `deep-wiki:wiki-synthesizer-analysis`,
  `deep-wiki:wiki-synthesizer-worker`,
  `deep-wiki:wiki-page-writer`로 갱신됨. V-0 검증 (Mechanism B
  forced-attempt probe)이 실증적으로 확인:
  - Qualified namespace `deep-wiki:wiki-X`는 Claude Code의 plugin
    agent registration을 통해 정확히 resolve됨.
  - Unqualified 이름은 명시적 Agent-not-found 에러 반환
    (`general-purpose`로의 silent substitution 없음).
  즉, v1.4.0 dogfood 실패는 런타임 auto-substitution이 **아니다**.
  진짜 원인은 main 세션이 `wiki-page-writer` worker를 자발적으로
  `subagent_type: "general-purpose"`로 downgrade한 것 — 이로 인해
  Read+Write+Edit가 부여되어 Stage 3 lock 외부의 `/tmp/v140-workers-out/*`
  로 쓰기 발생. Step 7.6.A에 향후 이 downgrade를 금지하는 명시적
  V-0/C3 코멘트 추가.

- **Inline rot-mitigation (v1.3.0 contract 보존)**:
  `agents/wiki-synthesizer-inline.md`는 dormant 상태로 ship되지만
  contract-frozen. frontmatter / header에 다음을 명시:
  - `status: dormant`
  - `last_known_active: v1.3.0`
  - `contract_frozen_at: a9966c7` (통합 에이전트 삭제 commit SHA).
    미래에 복원이 필요할 때, inline contract를 그 정확한 SHA에서
    spec archaeology 없이 복구 가능.

### 도구 (Tooling)

- **`scripts/lint-agent-tools.sh` (신규, 225 lines, Bash 3.2 portable)**:
  4개 에이전트 파일 (analysis + worker + inline + page-writer)에 대한
  정적 frontmatter lint. 각 에이전트의 선언된 `tools:`가 hardcoded
  manifest와 일치하는지 검증, WebFetch URL allowlist의 string-match
  체크 추가. 미래 spec 변경이 활성 에이전트에 `Write`를 다시 추가하는
  drift를 catch. CLAUDE.md 규약대로 Bash 3.2 portable (no `declare -A`,
  no `mapfile`, no `${var,,}`, newline-delimited string + `grep -Fxq`
  패턴).

- **`_post_dispatch_dirty_scan()` (신규 shell 함수,
  `commands/wiki-ingest.md` 내부)**: 3개 invocation 사이트에서 in-root
  mutation 방어 — Step 7.5.M-A (post 단일 소스 분석), Step 7.5.M-B
  Case B2 (post 다중 소스 worker dispatch), Step 7.6.B-post (post 2nd-pass
  collision merge). 각 에이전트 dispatch 전후로
  `<wiki_root>/pages/` + `<wiki_root>/.wiki-meta/`의 sha256 hash 계산;
  mismatch 시 stderr warning 후 `PARTIAL_FAIL`로 ingest abort.
  **`WIKI_TEST_MODE=1` env-gated** — 프로덕션 `/wiki-ingest` 실행은 scan
  완전히 skip (비용 0). 범위는 Known limitations L2 참조.

### 하위 호환성

- **단일 소스 A5 + 다중 소스 A4 경로**: v1.4.0과 structurally equivalent
  (같은 페이지 생성, 같은 provenance, 같은 log event). byte-identical
  아님 — split-agent dispatch가 어떤 에이전트가 JSON을 emit하는지
  (analysis vs worker, 둘 다 Write 부재) 변경하지만, `pages_created`
  의미, lock 획득, Stage 3 atomic-write, metadata pipeline은 변경 없음.
- **모든 v1.4.0 invariant 보존**: A5 3-stage pipeline, mandatory C3
  concurrency check, `partial_fail` sentinel + Step 1.5 cascading,
  `pages_failed` log 필드, `ingest-fail` 3-strike promote, `.config.json`
  knob.
- **모든 v1.3.0 contract 보존**: B5 dual-classification ledger,
  `colliding_drafts` second-pass input (이제 `wiki-synthesizer-worker`가
  consume), hook YAML parser broaden.

### Migration

`subagent_type: "wiki-synthesizer"`를 직접 사용하던 외부 caller는
용도에 맞는 qualified namespace로 반드시 전환:

- 단일 소스 분석: `subagent_type: "deep-wiki:wiki-synthesizer-analysis"`
- 다중 소스 worker (또는 2nd-pass collision merge): `subagent_type: "deep-wiki:wiki-synthesizer-worker"`
- Inline mode (DORMANT, 복원 전용): `subagent_type: "deep-wiki:wiki-synthesizer-inline"`

기존 단일 에이전트 이름은 v1.4.1에서 제거됨 — §3.4 Option B에 따라
호환성 shim 없음. `commands/wiki-ingest.md` 자체는 본 release의 일환으로
이미 마이그레이션 완료; out-of-tree caller만 조치 필요.

### V-0 / V-1 / V-2 / V-3 검증 결과

Track C 검증은 신뢰 경계 폐쇄를 end-to-end로 validate하기 위해
4개의 행동 probe (`scripts/v0-probe/`)를 실행:

- **V-0 PASS via Mechanism B (forced-attempt probe)**: qualified
  namespace `deep-wiki:wiki-X`는 resolve됨; unqualified는 명시적
  Agent-not-found 에러 반환 (general-purpose로의 silent substitution
  없음). 이 실증 finding이 v1.4.0 dogfood root-cause 분석을 마무리
  (실패 원인은 caller 자발적 downgrade였지, 런타임 auto-substitution이
  아니었음).
- **V-1 ALL 3 surfaces PASS**: `wiki-page-writer`가 prompt-injection
  거부 (`worker_status: failed` + `tools:[]` 인용 + Rule 2 인용),
  nested-agent dispatch 거부 (contract violation 인용), worker JSON의
  output-forgery는 Step 7.6.B Gate 3.5 basename validation으로 거부.
- **V-2 / V-3 UNDETERMINED-extrapolated**: V-2 / V-3 fault-injection에
  필요한 stub 에이전트가 테스트 시점에 plugin distribution cache에
  부재 (Path A acceptance per §6 fix-and-go cap). PASS는 V-0 + V-1
  체인을 통해 evidence-extrapolated. 최종 파일에 대한 empirical 재실행은
  post-distribution dogfood로 보류.
- **L1 caveat (cycle-4 R4-2)**: V-0 PASS는 Claude Code 런타임 metadata
  API 부재로 best-effort; V-2/V-3 stub에 대한 cache distribution gap은
  Path A acceptance로 처리.

### Known limitations (§11.5에 따라 mandatory — Path A acceptance 자세)

**L1. dispatch-metadata API 부재로 인한 V-0 false-pass 위험:**

> Trust-boundary closure achieved at agent-file-metadata level (`tools:` declarations) and via static lint + in-root runtime guard (§3.9). Empirical proof of caller-side `subagent_type` resolution is best-effort due to Claude Code runtime not exposing dispatch metadata. False-pass risk remains for caller-substitution scenarios identical to v1.4.0 dogfood. Track C v2 deferred until runtime-API supports metadata exposure.

(번역: 신뢰 경계 폐쇄는 에이전트 파일 metadata 수준 (`tools:` 선언)과
정적 lint + in-root 런타임 가드 (§3.9)에서 달성됨. caller 측
`subagent_type` resolution의 실증적 증명은 Claude Code 런타임이 dispatch
metadata를 노출하지 않아 best-effort에 그침. v1.4.0 dogfood와 동일한
caller-substitution 시나리오에 대한 false-pass 위험은 잔존. Track C v2는
런타임 API가 metadata 노출을 지원할 때까지 보류.)

**L2. §3.9는 in-root 범위만:**

> §3.9 post-dispatch dirty-file scan covers `<wiki_root>/`-internal mutations (state-corruption defense), NOT off-root writes (information-disclosure-via-side-channel). The v1.4.0 dogfood failure mode (worker writes to `/tmp/`) is NOT detected by §3.9. v1.4.1 trust boundary is layered defense-in-depth, not comprehensive enforcement. Process-level sandboxing deferred to v1.5.0+.

(번역: §3.9 post-dispatch dirty-file scan은 `<wiki_root>/` 내부의
mutation (state-corruption 방어) 만 커버. off-root 쓰기
(information-disclosure-via-side-channel)는 검출 NOT. v1.4.0 dogfood의
실제 실패 모드 (worker가 `/tmp/`에 쓰기)는 §3.9가 검출하지 못함. v1.4.1
신뢰 경계는 layered defense-in-depth이지, comprehensive enforcement 아님.
프로세스 수준 sandboxing은 v1.5.0+로 보류.)

**프로덕션 비용 주석 (cycle-3 N3.4):** §3.9는 `WIKI_TEST_MODE=1`
env-gated. 프로덕션 `/wiki-ingest` 실행은 dirty-file scan을 완전히 skip
(비용 0). sandbox + 재 dogfood opt-in 전용.

### v1.4.x 또는 v1.5.0+로 보류

- Track C v2 (post-runtime-metadata-API 또는 post-process-sandbox)
- Real-vault 재 dogfood (Task 11 — 사용자 재량)
- Sandbox T1–T6 tests (Task 10 — v1.4.0 Phase 6 선례에 따라 사용자 재량)
- B1 fault-injection harness, B2 A4×A5 결합, B3 `phase_timing_ms`
  telemetry
- §3.9 symlink coverage 강화 + post-Stage-3-close race hash-check

### 구현 참조

- Plan: `docs/superpowers/plans/2026-05-05-wiki-synthesizer-agent-split.md`
  (825 lines, 4 review cycles)
- Handoff (V-0 empirical finding root-cause 분석):
  `docs/handoff-2026-05-06-v1.4.1-task4.md`
- `feature/v1.4.1-track-c` 브랜치의 11개 commit (Tasks 4–12 + 본
  CHANGELOG commit, Task 13)

## [1.4.0] — 2026-05-05

A5 페이지 단위 fanout. 단일 소스 `/wiki-ingest`가 페이지 본문 생성을
N개의 `wiki-page-writer` worker에 분산 병렬화. Stage 1
(`wiki-synthesizer mode="analysis"`)이 어떤 페이지를 생성/갱신할지
기술하는 `page_plan`을 emit하고, sub-threshold 시 atomic write 가능한
`inline_bodies`도 함께 emit. Stage 2는 영향 받는 페이지마다 하나씩
`wiki-page-writer` worker를 병렬 dispatch (`len(page_plan) ≥
a5_fanout_threshold`, default 3). Stage 3는 main이 lock 아래 draft를
집계 + atomic-write하면서 모든 draft에 mandatory C3 concurrency check
적용 (update는 hash 비교, create는 existence check). Karpathy의 "한
소스가 10–15개 페이지에 영향" 속성 보존 — A5는 누가 페이지를 쓰는지를
바꾸지, 페이지 수를 바꾸지 않음. 다중 소스 (≥2) 경로는 v1.3.0 A4 fanout
그대로 보존; A4×A5 결합은 v1.4.1+로 보류.

**성능 주석 (2026-05-05 release 직후 추가):** 원래 ≤5분 wall-clock 목표
(vs v1.3.0 ~15분 단일 소스 baseline)는 무제한 subagent 병렬성을 전제했음.
초기 real-vault dogfood (14-page plan, 295-page wiki, 본 CHANGELOG 작성
세션)는 Claude Code 런타임의 동시 subagent cap ~3 환경에서 총 ~17분
wall-clock을 측정 (Stage 1 ~7분 analysis + Stage 2 ~10분 worker dispatch;
effective parallelism ~2.7×, 기대치 14× 아님). 아키텍처 메커니즘
(페이지 본문 병렬 생성, lock 아래 Stage 3, mandatory C3 concurrency
check)은 설계대로 동작; 정량적 per-stage 측정 + 병렬성 cap 정량화는
v1.4.1 B1 fault-injection + B3 phase_timing_ms telemetry로 보류. 또한
dogfood에서 14 워커 중 2개가 `tools: []` 계약을 위반함이 실증되어,
synthesizer agent split을 통한 trust-boundary closure (Track C)
우선순위가 격상.

### 아키텍처

- **A5 — 단일 소스 페이지 단위 fanout (Stages 1/2/3)**: 1-source ingest
  3-stage 파이프라인 신설. Stage 1은 synthesizer를 `mode: "analysis"`
  (신규 contract)로 invoke — synthesizer가 source + cross-page
  candidates를 읽고, 각 영향 페이지를 기술하는 `page_plan` 배열을 emit
  (`{file, action, frontmatter_meta, source_excerpts, intent_summary,
  novel_facts, preserve_sections, existing_page_body,
  existing_body_hash}`). Sub-threshold (`len(page_plan) <
  a5_fanout_threshold`) 실행 시 Stage 1이 각 entry의 전체 `page_content`를
  담은 `inline_bodies`도 함께 emit하여 Stage 2를 완전히 skip. Stage 2
  (활성 시) 단일 Agent-tool-message-turn에서 `page_plan` entry마다 하나씩
  `wiki-page-writer` worker를 dispatch — worker는 entry payload만
  받음 (Read/Glob/Grep tool 없음), 그 한 페이지의 `page_content`만
  생성, `{file, page_content, frontmatter_meta, worker_status,
  fail_reason}` 반환. Stage 3 (main, lock 아래)는 모든 draft에
  mandatory C3 optimistic concurrency check 실행 (update: body 재
  read + sha256을 `existing_body_hash`와 비교; create: existence
  check), Rule 7 backup, atomic-write (tmp + rename), v1.3.0 Step
  8-13 metadata 파이프라인 UNCHANGED 실행, 마지막에 PARTIAL_FAIL state에
  따라 `partial_fail` sentinel write 또는 removal.
- **`wiki-page-writer` agent (신규)**: 최소형 LLM 페이지 본문 생성기.
  Tool: `[]` (파일 I/O 없음 — main이 Stage 3 lock 아래 모든 write 소유).
  Input: `wiki_root` + `page_plan_entry` 1개. Output: 단일 JSON 객체
  `{file, page_content, frontmatter_meta, worker_status, fail_reason}`
  — main이 output을 집계하고 Step 7.6.C에서 페이지를 atomic write.
  Cross-page synthesis 없음 (Stage 1이 `intent_summary` /
  `novel_facts` / `preserve_sections`로 소유); source I/O 없음
  (관련 발췌는 이미 `source_excerpts`에 들어있음).
- **`wiki-synthesizer` 확장**: `mode: "analysis"` 신규 추가
  (v1.3.0 `mode: "inline" | "worker"`에 additive). Analysis mode가
  source + candidates 읽고 page_plan + (sub-threshold일 때) inline_bodies
  emit. Inline + worker mode는 v1.3.0과 byte-identical 유지.

### Step 1.5 partial_fail cascading (A1)

- **`partial_fail` sentinel**: `<wiki>/.wiki-meta/sources/<slug>.yaml`의
  새 optional 필드. Fanout 실행에서 어떤 페이지든 실패하면 (Stage 2
  worker fail OR Stage 3 write/concurrency abort) write됨. Schema:
  ```yaml
  partial_fail:
    ts: 2026-05-05T12:34:56Z
    failed_pages: ["page-a.md", "page-b.md"]
    reason: "stage 2 worker fail" | "stage 3 write fail" | "concurrency abort" | "all workers failed" | "metadata pipeline failure"
  ```
  Step 1.5 hash-skip이 bytes-hash 검사 BEFORE에 partial_fail을 cascade —
  존재 시 다음 세션에서 source bytes가 변하지 않았어도 REPAIR override
  강제 (신규 `partial-fail-recovery` repair_reason 값). Sentinel
  removal-on-success (Step 7.6.F Case ii)가 깨끗한 재 ingest 후 retry
  loop를 끊음.
- **`pages_failed` 로그 필드 (additive)**: `log.jsonl`의 `ingest`
  action에 FAILED_PAGES OR FAILED_WORKERS가 non-empty일 때 `pages_failed:
  [<file>...]` 포함. wiki-lint Step 6 LOG-INVARIANT scan 영향 없음.
- **`partial-fail-recovery` repair_reason**: v1.2.1 R3W2의 기존 5개
  값에 합류 (`commands/wiki-lint.md`에 informational note 추가 —
  엄격한 whitelist는 없음; 값은 emit-only).
- **`ingest-fail` lifecycle action**: 같은 source에 all-workers-fail
  retry counter가 3 연속 batch 도달 시 emit (Step 7.7.B). 실패에도
  `.pending-scan` promote하여 stuck-window state 해제.

### 숨김 설정

- **`<wiki>/.wiki-meta/.config.json` (optional, additive)**: 두 A5
  knob을 가진 신규 파일:
  - `a5_fanout_threshold` (default 3) — `page_plan` size에 따라 A5
    fanout 활성화. Threshold 미만 시 Stage 1의 `inline_bodies`가
    Step 7.5.A sub-threshold 경로로 write (Stage 2 dispatch 없음).
    매우 큰 값으로 설정하면 fanout 사실상 비활성화.
  - `a5_worker_timeout_sec` (default 90, W9 disclaimer에 따라 aspirational)
    — soft per-worker timeout 목표. Agent tool은 per-call timeout knob을
    노출하지 않음; 강제되지 않는 문서화 목표. 실제 hard limit은 runtime의
    Agent call당 ~5분 default.
  - python3 (선호) 또는 jq (fallback)로 로드. 둘 다 없을 시 default
    적용 + stderr warning emit (W10).
  - `.config.json` 부재 시 default — migration 불필요.

### 동시성

- **Step 7.6.C의 mandatory C3 concurrency check**: 모든 Stage 3 draft가
  check 실행 (update: body 재 read + hash 비교; create: existence
  check). 검출 시 페이지를 FAILED_PAGES에 추가, draft skip (loop
  CONTINUES — 다른 페이지는 여전히 write 가능). PARTIAL_FAIL toggle.
- **기존 global lock 변경 없음**: `mkdir <wiki>/.wiki-meta/.wiki-lock`
  으로 single-writer 보장. A5는 lock을 Stage 3 entry에서만 획득
  (v1.3.0 single-source fast path mirror; 다중 소스 A4는 여전히 Phase 0
  획득).
- **R-P1 dual fallback**: A5 경로 전반의 모든 shasum invocation이
  Linux portability를 위해 `shasum -a 256 || sha256sum` 사용.

### 실패 처리

- **Step 7.7.A (per-worker fail)**: FAILED_WORKERS로 routing;
  SUCCESS_DRAFTS loop BEFORE에 PARTIAL_FAIL toggle (P5 fix).
- **Step 7.7.B (all-workers fail)**: A7 — log/meta write 전에 lock
  획득 mandatory. R4-Adv-Adv-2 — first-ingest case의 baseline yaml
  materialization (sentinel writer가 부재 yaml을 corrupt시키는 문제 방지).
  3-strike retry counter, 3번째 연속 실패 시 `ingest-fail` force-promote.
- **Step 7.7.C (mid-loop write fail)**: A6 abort — tmp-write fail OR
  rename fail 시 나머지 draft를 FAILED_PAGES에 `"skipped due to
  mid-loop abort"` reason으로 (R4-R4-2 symmetry fix).
- **Step 7.7.D (C3 concurrency abort)**: continue; PARTIAL_FAIL toggle,
  sentinel fire.
- **Step 7.7.E (worker timeout)**: per-worker failure와 동일 처리.
- **Step 7.7.F (R4-Adv-Adv-1 metadata pipeline failure recovery)**:
  Step 7.6.C가 페이지를 쓴 AFTER Step 8-13이 실패 — 모든 WRITTEN entry를
  failed로 mark, held lock 아래 `partial_fail` sentinel write,
  best-effort log emit, `.pending-scan` promote NOT (다음 세션이
  partial_fail cascading + R3W2 wiki state drift 검출로 재시도).

### 하위 호환성

- **단일 소스 semantics 보존** but **byte-identical NOT**. v1.4.0은
  1-source `/wiki-ingest`를 v1.3.0의 inline mode 대신 analysis mode를
  통해 routing. 같은 페이지 생성, 같은 provenance, 같은 log event;
  analysis-mode invocation으로 인한 ~10–25% wall-clock variance.
- **다중 소스 경로는 v1.3.0 A4 그대로** (worker mode + B5
  dual-classification + Phase 0 lock + second-pass collision merge).
  A4×A5 결합은 v1.4.1+로 보류.
- **모든 v1.2.0+ invariant 보존**: log 전체에서 `pages_created`
  exactly-once, `.last-scan` monotonic, lock atomicity, source
  provenance, Step 1.5 hash-skip (이제 `partial_fail` cascade가 앞에
  추가됨).
- **모든 v1.3.0 contract 보존**: worker mode `proposed_action: "skip"`,
  `colliding_drafts` second-pass input, 다중 소스 B5 ledger invariant,
  hook YAML 파서 broaden.

### Sandbox 테스트 (Phase 6, W2에 따라 보류)

spec §10.1에 12개 sandbox scenario 명세. Test 1, 2, 3, 4, 8, 9, 11, 12는
success/main path를 plain `/wiki-ingest` invocation으로 실행. Test 5,
6, 7, 10은 fault-injection (`WIKI_TEST_*` env var)이 필요한데 round-1
W2 fix에 따라 v1.4.1로 보류. Phase 6 sandbox 실행 자체도 사용자 재량 /
v1.4.1 release 준비로 보류.

### 리뷰 trajectory

Plan은 구현 전 4번의 deep-review cycle을 거침:
- Round 1: 18 items. Plan: 1267 → 1810.
- Round 2: 7 items. Plan: 1810 → 1953.
- Round 3: 9 items. Plan: 1953 → 2080.
- Round 4: 7 items. Plan: 2080 → 2213.
- Round 5: 미수행 (4 cycle 후 fix-and-go cap).

구현 단계에서 Phase 4와 Phase 5 사이의 impl-vs-spec drift check이 식별한
stale v1.3.0 prose drift에 대해 1개의 Phase 4 cleanup commit 추가.

## [1.3.0] — 2026-05-02

아키텍처 마이너 릴리스. 두 개의 병렬 축 변경과 v1.2.1 사이클 리뷰에서 이월된 6개 폴리시 항목.
다중 소스 `/wiki-ingest`가 이제 worker 모드의 `wiki-synthesizer` 서브에이전트 최대 3개로
fanout되어, LLM 분석이 지배적인 비용을 병렬로 처리하면서 모든 쓰기는 기존 단일 mkdir-기반
잠금 아래 main에서 직렬화 유지. 훅 YAML 파서가 이제 block form 외에 inline + dotted form도
수용. 단일 소스 ingest는 v1.2.1과 byte-identical (fast path).

### 아키텍처

- **A4 — wiki-synthesizer fanout (Approach B)**: 다중 소스 `/wiki-ingest`가
  소스를 `min(3, N)` worker 서브에이전트로 분할 (정렬된 소스 경로 round-robin),
  병렬 디스패치. Worker는 전체 LLM 분석을 수행하지만 파일 쓰기는 NONE. Main이
  cross-worker B5 dual-classification ledger를 통해 draft를 집계하고 기존
  글로벌 lock 아래 모든 쓰기를 순차 수행 (v1.3.0+: lock은 fanout branch에 한해
  Phase 0에 획득; single-source는 v1.2.1과 동일하게 Phase 3에 획득).
  Cross-worker page 충돌 시 second-pass `wiki-synthesizer` invocation을
  worker mode (새 `colliding_drafts` input field 포함)로 dispatch하여
  충돌하는 page body들을 하나의 일관된 page로 merge — v1.2.1 multi-source
  merge invariant 보존. v1.2.1 invariant (log-line uniqueness, per-source
  provenance, ingest-repair semantics) 유지 — main이 유일한 writer로 남기
  때문. Worker 모드는 synthesizer agent의 `mode: "worker"` 파라미터로
  opt-in; 기본값은 single-source fast path를 위한 `"inline"`. v1.3.0은 cap 3
  하드코딩; configurable knob은 v1.4.0+로 보류. 3+ 소스 batch의 예상
  wall-clock 감소: 30–50% (LLM 분석이 지배적 비용; 이상적 3× speedup, 실제로는
  가장 빠른 소스 지배 + Phase 2/3 sequential로 인해 ~2×).
- **C — Hook YAML 파서 확장**: `scan-vault-changes.sh` awk가 이제
  `auto_ingest.ignore_globs`의 세 가지 form을 인식: block (기존), inline
  (`["a", "b"]`), dotted (`auto_ingest.ignore_globs: [...]`). 같은 broaden이
  `wiki-lint.md` `lint.orphan_ignore` 파서 (in-repo 주석에 명시된 mirror parser)
  에도 적용. v1.2.1 cycle-3의 README/파서 mismatch를 파서 쪽에서 닫음. 또한
  block-form path의 pre-existing 잠재 버그도 수정 (`sub()`가 `$0`을 변형시켜
  terminator rule이 fall-through로 같은 라인에 발동, multi-item block list가
  첫 항목 이후 silently drop되던 문제).

### 폴리시

- **1.1 — Delimiter-aware awk slug allocator extractor**: v1.2.0의 two-pass
  sed를 `wiki-ingest.md` slug allocator의 `prev_origin` 추출에서 교체. 3개의
  anchored awk rule (double-quoted / single-quoted / unquoted) + `\47` literal-
  single-quote (POSIX awk portable)이 embedded opposite-kind quotes 포함 3가지
  form을 모두 올바르게 처리 (예: `"/path/with'quote.md"`). Plan #1에서 처음
  제안된 single-pass char-class sed는 Cycle-1 cross-validation에서 reject —
  `[^"']*` capture가 첫 inner quote에서 멈추므로 embedded-opposite-kind 케이스
  를 실제로 fix하지 못함.
- **1.2 — Tab-indent를 코드 블록 마커로 인식**: `wiki-lint.md`
  `strip_code_blocks` awk가 이제 `/^    /` 대신 `/^(    |\t)/` 매칭.
  Tab-indented 코드 블록 내부의 broken-link 감지 false-positive (W-γ) 차단.
- **1.3 — Post-list 2-blank-line reset**: 같은 awk가 `blank_run` 카운터 추가;
  CommonMark 스펙대로 2 연속 blank line 후 `prev_was_list` 리셋. 4-space line이
  실제 코드 블록인데 list continuation으로 처리되던 false-negative (W-δ) 차단.
- **1.4 — Spec/plan ordering convention**: `CLAUDE.md` Workflows & Conventions
  섹션이 spec writer가 위치 표현 ("above X", "below Y") 사용 시 surrounding
  pattern을 명시하도록 요구하는 sub-section 추가. v1.2.1 cycle-3 lesson 적용.
- **1.5 — Implementation review prompt tweak**: `CLAUDE.md` Review cycle
  sub-section이 Step 6 (implementation review)에서 config/parser 실행 체크
  메모 추가. deep-review repo (`commands/deep-review.md`)의 final
  code-reviewer prompt에도 같은 가이드라인 추가 (optional companion change).
- **1.6 — README config syntax sweep**: `README.md`와 `README.ko.md`가 이제
  `auto_ingest`의 세 가지 수용 YAML form을 모두 문서화. v1.2.1 cycle-3의
  "block-form only / silently ignored" 경고 괄호 제거 (Task 1 후 factually
  false).

### Tier 3 결정 (close)

- **D — R3W2 missing-log design**: status quo 유지. Prose-only
  `ingest-repair` (`pages_created:[]`) for log-truncation cases. Spec 변경
  없음. v1.3.0+ dogfood가 빈번한 발생을 드러내면 재고려.
- **E — `cache_local` 자동화**: 사용자-base 데이터 누적까지 v1.4.0+로 defer.
  본인 vault는 Google Drive offline 모드; 그 모드의 cache_local benefit은
  ~0. 1인-사용자 플러그인의 다른-사용자 분포는 가시성 없음.

### Backwards compatibility

- 단일 소스 `/wiki-ingest`는 v1.2.1과 byte-identical (fast path가 fanout 전체
  스킵; lock도 Phase 3에서만 획득 — v1.2.1과 동일).
- 다중 소스 `/wiki-ingest`는 cross-worker page collision이 없을 때 (보편적
  케이스) 동일한 최종 wiki state 생성; collision 발생 시 second-pass synthesis가
  v1.2.1 multi-source merge 의미를 보존. wall-clock만 변화.
- 기존 `auto_ingest:` block-form config는 변경 없이 계속 작동.

### Trade-offs

- **토큰 비용 증가 (다중 소스 batch):** A4 fanout이 `min(3, sources)`개의
  `wiki-synthesizer` 서브에이전트를 병렬 디스패치합니다. 각 worker는 synthesizer
  spec + wiki-schema (~3-5K 토큰 컨텍스트)을 독립적으로 로드합니다. 3-소스
  batch의 경우, v1.2.1 단일-synthesizer 기준 대비 ~2-3× synthesizer-spec
  컨텍스트 비용 증가. wall-clock 절감 (~30-50%, LLM-dominant 분석)이 토큰 증가를
  대부분의 사용자에게 상쇄. configurable `max_workers` knob은 v1.4.0+로 보류.
- **Lock 보유 기간 (다중 소스 only):** 글로벌 mkdir-기반 lock이 fanout branch
  (≥2 sources)에 한해 Phase 0에 획득되어 Phase 3까지 유지됩니다. v1.2.1은
  Step 8에서 획득. 결과: 다중 소스의 LLM 분석 전체 시간(~분 단위) lock 보유.
  단일 소스 path는 변경 없음. 동시 `/wiki-ingest` 세션은 1인 사용자 vault에서
  드뭄; dogfood가 contention을 드러내면 재고려.
- **Second-pass synthesis (cross-worker 충돌):** ≥2 workers가 같은
  proposed_file을 non-byte-identical `page_content`로 타겟팅할 때, main이 1개의
  추가 **worker-mode** synthesizer (새 `colliding_drafts` input field 포함)를
  디스패치하여 충돌 draft들을 merge합니다. Worker가 merged draft를 return하고
  main이 Phase 3에서 write — single-writer invariant 보존 (`inline`-mode
  dispatch는 Phase 2에서 write를 발생시켜 invariant를 깰 것임).
  비용: 같은-페이지 충돌당 1 추가 subagent 호출. 이것이 없으면 multi-source merge
  invariant (v1.2.1 의미)가 silently fact를 drop. 대부분의 다중 소스 batch는
  충돌이 없음.

### 새 lifecycle action

- **`ingest-fail`**: 같은 `.pending-scan` window에서 all-workers-fail이
  3회 연속 (counter `<wiki>/.wiki-meta/.pending-scan-retry-count`,
  format `<window_epoch>:<count>`) 발생하면 `log.jsonl`에 emit됩니다. 실패에도
  불구하고 `.pending-scan → .last-scan` promote (stuck window 해제) + 영향받은
  파일 명시한 user-visible error 표시. counter는 성공한 (full/partial) batch에서
  reset — partial은 `.failed-sources.tsv`에 의존하여 per-source 재시도.

### 새 storage-layout 파일

- **`<wiki>/.wiki-meta/.failed-sources.tsv`**: 다중 소스 ingest에서 partial
  worker failure 발생 시 작성되는 path-level 재시도 manifest. TSV format
  `<source_path>\t<failure_reason>\t<ts>`. Hook이 다음 iteration에서
  `.pending-scan`과 함께 읽음. Full success에서 clear. Plan #2의 (잘못된)
  `.pending-scan`에 path를 쓰는 아이디어 (timestamp-only 파일) 대체.
- **`<wiki>/.wiki-meta/.pending-scan-retry-count`**: 3-strike `ingest-fail`
  트리거를 위한 all-workers-fail 카운터. Format `<window_epoch>:<count>`.
  Success 또는 3-strike trigger에서 clear.

## [1.2.1] — 2026-05-02

v1.2.0 review-cycle 백로그를 마무리하는 패치 릴리스. 네 축에 걸친 14개 이슈: Step 1.5 hash-skip 무결성 강화, wiki-lint false positive 제거, per-source provenance 보존, README cloud-mirror 문서 정확성. happy path 동작 변경 없음 — 모든 수정은 더 엄격한 invariant 검사 또는 문서/파서 정정.

### 해시 스킵 무결성 (Step 1.5 hardening)

- **R3W1 — 슬러그 충돌 disambiguation**: 두 file 소스가 basename을 공유할 때 (`/A/foo.md`와 `/B/foo.md`가 둘 다 → 슬러그 `foo`), Step 1 끝의 새 disambiguation 단계가 origin이 일치하는 다음 사용 가능한 `foo-N`을 선택 (또는 새 `foo-N` 슬롯). 우연한 bytes-hash 일치 시 발생하는 silent cross-attribution 위험을 차단.
- **R3W2 — 로그 신호 부재 시 강제 repair**: Step 1.5는 이제 (a) `log.jsonl`이 완전히 없거나, (b) yaml은 있지만 슬러그의 terminal 로그 항목이 없는 경우 (`last_action=''`) `ingest-repair`를 트리거합니다. 두 경우 모두 skip이 아닌 재-ingest를 요구하는 state drift를 의미합니다. **주의 (W-α v1.2.1+):** 로그 부재/truncation으로 인해 R3W2가 발동되면 결과 `ingest-repair` 라인은 spec에 따라 `pages_created:[]`을 emit합니다 — 그 페이지들의 historical 생성 기록은 사라지고 합성되지 않습니다. wiki-lint Step 6 LOG-INVARIANT은 중복만 검사하므로 위키는 clean하게 유지되지만, log 기반 audit 재구성은 log-truncated repair 케이스에서 불완전합니다. Per-source yaml(Checks 1+2로 검증됨)이 authoritative provenance record로 남습니다. 완전한 log 기반 traceability를 보존하려면 영향받은 source를 다시 ingest하기 전에 log.jsonl을 백업에서 복원하세요.
- **RW3 — 인라인 리스트 yaml 파서**: Check 1 awk가 이제 block-list 형태에 더해 `pages_created: [a.md, b.md]`도 수용합니다. 미래 Step 8e 변형에 대한 defense-in-depth.
- **RW4 — Single-quote yaml strip**: Check 1과 Check 2가 모두 이제 v1.2.0 IW1의 wiki-lint fix와 동일한 `gsub(/^["\x27]+|["\x27]+$/, "", v)` 패턴을 사용합니다.
- **RW7 — 명시적 배열 초기화**: Step 1.5 scan loop 상단에서 `SKIPPED=()`와 `REPAIR=()`을 `set -u` 청결성을 위해 명시적으로 초기화합니다.

### 위키-린트 거짓 양성 제거

- **T10 — http(s):// 타겟을 broken-link 검사에서 제외**: `.md`로 끝나는 외부 URL (예: GitHub gist raw URL)이 더 이상 `[BROKEN]`을 발생시키지 않습니다. v1.2.0 dogfood에서 관찰된 5개의 false positive를 차단.
- **W7 — Block-context-aware 4-space code-block strip**: `strip_code_blocks()`가 이제 진짜 CommonMark indented code block (blank line 뒤의 4-space, list item 하위가 아닌)을 list continuation 및 paragraph lazy continuation과 구분합니다. 진짜 코드는 strip되고 (multi-line은 `in_indented_code` state로, CR-C v1.2.1+); continuation은 보존되어 list item 내부의 링크가 broken-link 감지의 대상이 됩니다. Tab-indented code와 post-2-blank-line code는 문서화된 한계로 남습니다 (v1.3.0+ 후보).

### Per-source provenance

- **B5 — 동일 배치 co-create attribution 보존**: 한 배치에서 두 소스가 독립적으로 같은 페이지를 생성하면, 두 contributing 슬러그의 yaml 모두 그 페이지를 `pages_created`에 기록합니다 (per-source truth). Step 10의 로그 emission은 여전히 intra-batch dedup을 적용하므로 log invariant (각 파일명이 로그 라인 전체에서 `pages_created`에 최대 한 번)은 유지됩니다. Length-guarded snapshot init (CR-B v1.2.1+)이 bash 3.2.57에서 1-element-empty-string을 생성하던 깨진 `("${ARR[@]:-}")` 패턴을 대체합니다. Step 10 prose가 post-dedup 배열을 명시적으로 참조하도록 갱신됨 (CR-D v1.2.1+). v1.2.0 W6의 trade-off를 차단.

### 문서 정확성

- **R3W3 — Cloud-mirror VAULT_ROOT 안내**: README A5가 이제 `wiki_root`를 vault 외부 로컬 경로로 옮기면 SessionStart hook이 `$HOME`을 watch하게 됨을 (since `VAULT_ROOT=$(dirname "$WIKI_ROOT")`) 경고합니다. 이 모드에서는 hook 비활성화 또는 `ignore_globs: ['**']`을 권장합니다. `vault_root:` config knob은 v1.3.0+ 추적.
- **R3W4 — auto_ingest pause 안내 정정**: `auto_ingest:` 블록 제거는 auto-ingest를 중지하지 **않습니다** (v1.1.x whole-vault default로 회귀하여 *더* 공격적). 정정: `ignore_globs: ['**']` 설정 또는 SessionStart hook 비활성화.

### 스펙 다듬기

- **RW2 — Step 10 SKIPPED/REPAIR drain 안내**: Step 10 prose에 명시적 forward-pointer를 추가하여 암묵적인 Step 1.5 → Step 10 drain이 blockquote을 추적하지 않고도 보이도록 합니다.
- **RW5 — Hook 50-line frontmatter guard 재배치 + line-1 opening guard**: `^---$` 규칙이 이제 line counter보다 앞서므로 50 라인 이후의 closing `---` (Templater plugin)이 honor됩니다. Line-counter early-exit이 frontmatter가 아직 시작되지 않은 경우에만 발동되도록 좁혀졌고, hard 200-line 절대 cap이 추가됨. Opening `---`이 line 1로 제한되어 50 라인 이후의 body horizontal rule이 frontmatter mode로 leak되지 않습니다 (CR-E v1.2.1+).
- **RW6 — Synthesizer message-boundary count가 Phase 1c를 포함**: "four message boundaries" → "four to six"로, Phase 1c가 발동하고 escalate되는지에 따른 분기 설명 포함.

### 백필

- v1.2.0 CHANGELOG A3 bullet이 이제 2026-04-30 dogfood에서 관찰된 페이지당 ~20% 감소 실측값을 담습니다.

### 파일 변경

- `commands/wiki-ingest.md` — Step 1 disambiguation, Step 1.5 hardening (R3W1+R3W2+RW3+RW4+RW7), Step 8c.1 + 8e (B5), Step 10 (RW2+CR-D)
- `commands/wiki-lint.md` — Step 4 (T10, W7+CR-C)
- `hooks/scripts/scan-vault-changes.sh` — `auto_ingest_passes()` (RW5+CR-E)
- `agents/wiki-synthesizer.md` — message-boundary count (RW6)
- `README.md`, `README.ko.md` — A5 (R3W3+R3W4)
- `.claude-plugin/plugin.json` — version bump
- `CLAUDE.md` — "Recent releases" 아래 v1.2.1 entry + ingest-repair lifecycle action 안내 (C2-Y v1.2.1+)

## [1.2.0] — 2026-04-30

### 성능

- **SessionStart 자동 ingest 범위 필터** — `~/.claude/deep-wiki-config.yaml`에 선택적 `auto_ingest:` 블록이 추가됩니다. `ignore_globs` (경로 glob 제외)와 `require_tag` (프론트매터 태그 opt-in)를 지원합니다. SessionStart hook이 /wiki-ingest 호출 전에 이 필터를 적용해, Daily notes나 아카이브 폴더 같은 고빈도·저가치 경로의 호출 빈도를 줄입니다. 하위 호환 — 블록은 선택 사항이며, 없으면 기존 동작을 유지합니다. (A1)
- **재-ingest hash skip** — `/wiki-ingest` Step 1.5에서 각 `file`/`deep-work-report` 소스의 sha256을 기존 `.wiki-meta/sources/<slug>.yaml:content_hash`와 비교합니다. 일치하는 소스는 lock 획득 전에 배치에서 제외됩니다. 배치 전체가 skip된 경우에도 lock을 잠깐 획득해 per-slug `ingest-skip` 로그 항목을 추가하고 `.pending-scan → .last-scan` promotion을 실행한 뒤 종료합니다. 새 `ingest-skip` 로그 액션이 감사용 skip 슬러그를 기록합니다 (canonical 스키마 유지: `{ts, action, source, pages_created:[], pages_updated:[], skip_reason}`). Step 1.5가 기존 yaml을 찾을 수 있도록 슬러그 파생을 Step 5에서 Step 1 끝으로 이동했습니다. **Hash 일치만으로는 skip 불충분 (IC1 review fix):** Step 1.5는 wiki 측 상태 무결성도 검증합니다 (`pages_created`∪`pages_updated`의 모든 페이지가 존재, 각 페이지 frontmatter `sources:`에 슬러그 포함, 슬러그의 가장 최근 로그 항목이 clean terminal action). 어느 하나 실패 시 정상 ingest로 fall-through하여 자가 복구하며, 새 `ingest-repair` 로그 액션으로 기록됩니다. `ingest-repair` 라인은 `pages_created:[]`를 emit하고 모든 touched 페이지를 `pages_updated`로 분류하여 wiki-lint Step 6 LOG-INVARIANT (각 파일명이 `pages_created`에 한 번만 등장) 무결성을 보존합니다 (R3C1 review fix); wiki-lint Step 6도 defense-in-depth로 `select(.action != "ingest-repair")` 필터를 추가합니다. (A2)
- **A3 — Skim-first 후보 필터링**: synthesizer Phase 1이 이제 frontmatter만으로 후보를 점수화하고, 상위 K개(일반 3개, 점수 분포가 평탄하면 최대 5개)를 deep-read 한 뒤, skim에서 제외된 후보를 parallel Grep batch (Phase 1c, IW1 fix)로 검증합니다. Per-call 벽시계 시간 ~15-25% 감소 예상 (v1.1.4 follow-up 예측; **v1.2.0 첫 dogfood (2026-04-30)에서 페이지당 ~20% 감소 실측** — v1.2.0의 8-page cloud-vault dogfood에서 페이지당 1.7분, v1.1.3 베이스라인 페이지당 ~2.14분 (2-page update, 더 작은 샘플), source vault는 Google Drive offline mode. 샘플 크기가 다르므로 — 방향성만 유효하며 엄밀한 like-for-like 비교는 아님).
- **클라우드 스토리지 미러-동기화 워크플로우 가이드** — README(EN/KO)에 iCloud/Google Drive/Dropbox vault 사용자를 위한 3단계 수동 워크플로우를 문서화합니다: `wiki_root`를 로컬 디스크에 두기, 예약된 additive rsync(`--delete` 없음)로 vault에 미러링, 다른 기기에서 편집 시 먼저 수동 역-rsync 실행 (자동 충돌 감지 없음). 자동 `cache_local` 설정 옵션은 v1.3.0+로 보류됩니다. (A5)

### Lint 강화

- **`[SCAN-WINDOW]` 불변식 검사 + `--fix` 자동 정리** — `/wiki-lint`에 Step 11이 추가되어 `.pending-scan`/`.last-scan`의 세 가지 병적 상태를 감지합니다 (유효하지 않은 TS 정규식, `PENDING < LAST` 역행 위험, `LAST > 48h`인 자동 ingest 정체). `--fix`는 stale 및 유효하지 않은 `.pending-scan`을 자동으로 삭제합니다; 48h 초과 정보성 경고는 수동 판단이 필요합니다. gdate / Darwin / Linux를 지원하는 삼중 분기 날짜 파싱으로 이식 가능한 에포크 비교를 구현합니다. v1.1.4 follow-up 문서의 보류된 권고사항을 구현합니다. (B1+B2)
- **`[ORPHAN]` 분류** — `/wiki-lint` Step 3이 이제 프론트매터에 `tags: [leaf]`가 있는 페이지와 `~/.claude/deep-wiki-config.yaml:lint.orphan_ignore` glob에 매칭되는 페이지를 제외합니다. 의도된 아카이브/마일스톤 leaf가 있는 wiki의 노이즈를 줄입니다. (B3)
- **`[BROKEN]` 코드 블록 제외** — `/wiki-lint` Step 4가 `[text](target.md)` 패턴을 grep하기 전에 **fenced** 코드 블록(```...```)을 제거해, 코드 샘플 내에 `.md` 파일명이 언급된 문서 페이지의 false positive를 제거합니다. **4-space 들여쓰기 블록은 의도적으로 제거하지 않습니다** (NW3 리뷰 참고): CommonMark는 목록 내 4-space를 item-continuation으로 처리하므로, 무조건 제거하면 `- top\n    - nested with [link](other.md)` 같은 유효한 링크를 삭제할 수 있습니다. (B4)
- **`pages_created` 동일 배치 중복 제거 가드** — `/wiki-ingest` Step 8c가 이제 배치 내 중복(한 배치에서 두 소스가 동일한 `file`을 생성)을 재분류해 첫 번째만 `created`로, 나머지는 `updated`로 처리합니다. v1.2.0+ ingest에서 "로그 전체에서 정확히 한 번" 불변식을 복원합니다. 기존 로그 항목은 변경되지 않습니다(append-only). bash 3.2 호환: 개행 구분 문자열 + `grep -Fxq` 사용(`declare -A` 미사용). (B5)

### Wiki 데이터 정리 (one-off)

- **Broken-link 발견사항 (5개)** — lint가 표시한 broken link 5개 전체 분석 결과, 전부 false positive — `.md`로 끝나는 외부 URL (예: `https://github.com/.../ARCHITECTURE.md`, `https://code.claude.com/docs/en/hooks.md`). vault 변경 없음. **참고:** wiki-lint Step 4의 URL 제외 (skip `http(s)://...` targets)는 이 false-positive 클래스를 구조적으로 제거하는 v1.3.0+ 후보입니다.
- **버전 백업 체인 (4페이지 정리)** — `cross-model-3way-review-synthesis`, `deep-suite-marketplace`, `plan-review-as-integration-test`, `quant-monitor-watcher`를 보존 한도(페이지당 최근 3버전)로 수동 정리. 정리 전 backup tarball 저장.
- **Orphan 분류 (36페이지)** — 사용자에게 보류. v1.2.0의 B3 도구(`leaf` 태그 + `lint.orphan_ignore` config)가 준비 완료 상태로 출시됩니다. 사용자는 적절한 glob/태그를 사용해 orphan 목록을 자신의 일정에 맞게 정리할 수 있습니다.
- **`pages_created` 과거 위반 (28개)** — `log.jsonl`에 그대로 유지됩니다(append-only). B5가 미래 재발을 방지합니다; v1.2.0+ ingest는 새로운 위반을 생성하지 않습니다.

### 보존 (기능 동등성)

- Agent 입출력 계약 — `candidates` 형태가 `[filename]`에서 `[{file,title,tags,aliases}]`로 변경됨 (호출자와 agent 모두 업데이트됨; 이 계약의 서드파티 소비자 없음)
- Lock 프로토콜, 버전 백업, source provenance 스키마 — 불변
- v1.2.0 이전 wiki: `auto_ingest:` 및 `lint.orphan_ignore:` 블록은 선택 사항이며, 없으면 v1.1.x 동작을 유지

### 마이그레이션

별도 조치 불필요. 기존 wiki는 계속 동작합니다. v1.2.0 성능 향상을 활용하려면:

1. 고빈도 경로를 `ignore_globs`에 설정한 `auto_ingest:` 블록을 `~/.claude/deep-wiki-config.yaml`에 추가합니다.
2. `/wiki-lint --fix`를 한 번 실행해 stale `.pending-scan` 파일을 정리하고 과잉 버전 백업을 정리합니다.
3. (선택) README 클라우드 스토리지 섹션에 따라 `wiki_root`를 로컬 디스크로 이전합니다.
4. (선택) 의도적인 orphan 페이지에 `lint.orphan_ignore` glob 및/또는 `tags: [leaf]`를 추가해 `[ORPHAN]` lint 보고서를 정리합니다.

## [1.1.4] — 2026-04-24

### 수정

- **`content_hash` 에 agent sentinel 을 그대로 기록하던 문제 수정** (v1.1.3 follow-up 의 D1) — v1.1.2 가 sha256 계산을 `wiki-synthesizer` 로 이관했지만, agent 의 tool scope (`Read, Write, Glob, Grep, WebFetch`) 에는 해싱 수단이 전무해 manifest 가 항상 placeholder 문자열을 반환하고 있었고, 호출자는 이를 그대로 `sources/<slug>.yaml:content_hash` 에 기록해 왔습니다. 즉 v1.1.2 이후 모든 ingest 의 `content_hash` 가 실질적으로 무의미한 상태였으며, 재-ingest 감지와 provenance 감사가 모두 신뢰 불가능. `/wiki-ingest` 에 Step 8d "Normalize `source_hashes`" 를 명시적으로 추가해 manifest 값을 `^[0-9a-f]{64}$` (대소문자 무시) 로 검증하고, 비-hex 값은 소스의 `origin` 에서 post-hoc 재계산 (`shasum -a 256`, text 는 inbox 파일, URL 은 `curl | shasum`) 후 Step 8e 의 yaml 작성에 사용. `wiki-synthesizer.md` 는 sentinel 컨벤션 (`"main-computes"`) 과 비-hex 값이 호출자에게 fatal 이 아님을 contract 에 명문화. 권위 있는 agent digest (실제 64-hex) 는 변경 없이 passthrough 되므로, 향후 해싱 가능한 tool scope 의 agent 가 등장하면 v1.1.2 본래 의미를 그대로 복원.
- **`.pending-scan → .last-scan` promotion 이 stale pending 존재 시 `.last-scan` 을 역행시키던 버그 수정** (v1.1.3 follow-up 의 D2) — 이전 중단된 세션이 `.pending-scan` 을 남긴 채 별도 ingest 가 `.last-scan` 을 전진시킨 상태라면, v1.1.1 에서 도입된 promotion block 의 `mv PENDING LAST` 가 `.last-scan` 을 **역행**시킵니다. 이후 hook 은 stale pending timestamp 이후의 모든 파일을 재-탐지해 `log.jsonl` 에 중복 entry 를 양산. promotion block 이 이제 `.last-scan` 을 먼저 읽어 `CURRENT_LAST > BATCH_PENDING` (UTC ISO 8601 `Z`-suffix 포맷의 고정폭 성질상 lexicographic 비교가 숫자 순서와 일치) 인 경우 advance 를 skip 하고, 같은 블록에서 window 가 이미 covered 된 `.pending-scan` 을 제거. 정상 동시-hook 시나리오 (mid-batch 에 `.pending-scan` 이 newer timestamp 로 덮어쓰기된 경우) 의 의미는 이전 릴리즈와 동일.

### 유지 (기능 불변)

- Agent 입출력 계약 — 불변 (sentinel 은 이미 관측된 실제 동작이었고, 이번에 contract 가 이를 정직하게 문서화)
- v1.1.3 의 parallel tool dispatch 가이드 — 불변
- 정상 (non-stale) hook/ingest interleaving 하의 `.pending-scan` promotion — 불변; regression guard 는 방어적 추가
- Manual (no-hook) ingest 경로 — 불변; `BATCH_PENDING=""` 는 여전히 promotion block 의 no-op
- Lock 프로토콜, 버전 백업, auto-lint, per-source yaml 스키마, `log.jsonl` 스키마 — 모두 불변

### 마이그레이션

별도 조치 불필요. placeholder `content_hash` 로 기록된 기존 `sources/<slug>.yaml` 는 그대로 두고 (역사 기록), 같은 source 가 다시 ingest 되면 그때부터 유효한 sha256 digest 가 기록됩니다. 기존 `.pending-scan` 은 다음 ingest 시 새 promotion 로직이 처리.

## [1.1.3] — 2026-04-24

### 성능

- **`wiki-synthesizer`가 각 phase 내부의 tool call을 병렬로 발행** — 이전 버전은 agent 워크플로우에 명시적인 동시성 지시가 없어, Claude가 자연스럽게 한 메시지에 한 개의 tool call만 발행했습니다 (소스 Read → candidate A Read → candidate B Read → …). 일반적인 5-10 페이지 ingest에서 이 패턴은 round-trip이 ~3N번 직렬화되어, LLM inference cost를 넘어서는 wall-clock 시간의 지배적 원인이 됐습니다. 이제 `agents/wiki-synthesizer.md`에 "Performance guidance — parallel tool dispatch" 섹션이 추가되어 워크플로우를 4 phase로 분할하고 (source read / candidate survey / backup batch / page write), 각 phase 내부의 모든 tool call은 반드시 한 메시지에 묶어서 발행하도록 요구합니다. phase 간 data dependency 순서는 그대로이며, phase **내부**의 fan-out만 추가됐습니다. 순수 prompt 변경 — 런타임, tool contract, input/output 스키마, lock, provenance 동작은 모두 불변입니다.
- **Cloud-synced `wiki_root`의 latency 비용 문서화** — README(EN/KO)에 `wiki_root`를 iCloud Drive, Google Drive, Dropbox 같은 sync-daemon 기반 경로에 두면 매 `Write`마다 sync daemon이 깨어나 수백 ms의 지연이 추가된다는 안내를 추가했습니다. 권장 사항: `wiki_root`는 로컬 디스크에 두고, sync client의 자체 파일 동기화로 전파하도록 구성. 이는 플러그인 제어 밖의 환경 요인이므로 사용자 인프라 영역으로 명시 스코프.

### 유지 (기능 불변)

- Agent 입출력 계약(`{wiki_root, sources, candidates}` → `{created, updated, versioned, source_hashes, failed}`) — 불변
- 모든 정합성 규칙: grounded content, page template, kebab-case filename, merge-don't-duplicate, conflict notation, version-before-overwrite, write scope — 불변
- Rule 5 widening (`Glob`/`Grep` 확장 탐색) 여전히 필수 — 병렬 가이드는 정합성이 성능에 우선하며 이를 약화해선 안 됨을 명시
- Lock / `.pending-scan → .last-scan` 승격 / auto-lint / index.json 스키마 — 불변

### 마이그레이션

별도 조치 불필요. 플러그인 사용자는 wiki나 config를 업데이트할 필요 없음. 관찰 가능한 유일한 변화는 3개 이상 페이지를 작성/업데이트하는 ingest에서 체감 속도 향상 (작성할 페이지가 많을수록 linear-dispatch 낭비가 크게 제거됨).

## [1.1.2] — 2026-04-21

### 변경

- **`/wiki-ingest`가 페이지 I/O를 항상 `wiki-synthesizer` subagent(sonnet)로 위임** — 이전에는 멀티소스 배치이거나 `--synthesize` 플래그가 주어진 경우에만 subagent가 호출되고, 나머지는 메인 세션에서 인라인 처리되어 소스 본문과 기존 페이지 바디가 모두 메인 컨텍스트로 유입되었습니다. 이제 모든 ingest(단일/멀티 소스, URL/파일/deep-work 리포트, 수동/자동 모두)가 Step 7에서 `wiki-synthesizer`로 dispatch됩니다. 메인 세션은 작은 메타데이터 작업(`index.json`, `log.jsonl`, `sources/*.yaml`, 락, auto-lint)만 수행. SessionStart 훅으로 여러 Obsidian 파일이 한 번에 들어오는 자동 ingest에서 체감 절감이 가장 큽니다.
- **버전 백업을 메인 command에서 `wiki-synthesizer`로 이관** — 기존 페이지를 덮어쓰기 전 `.wiki-meta/.versions/<name>.v<N>.md`로 스냅샷하는 작업이, create-vs-update 판단을 내리는 바로 그 pass 안에서 agent에 의해 수행됩니다. "쓰기 + 백업"이라는 단일 책임을 한 컨텍스트에 묶는 방향. 보관 정책(last-3 프루닝)은 메인의 auto-lint가 그대로 담당 — 변경 없음.
- **Agent 입출력 계약 구조화** — `wiki-synthesizer`는 `{wiki_root, sources: [{slug, origin, type}], candidates}`를 입력으로 받고, 구조화된 manifest를 반환합니다: `created`/`updated` 각 엔트리가 `{file, title, tags, aliases, sources}`를 담고, `versioned`, `source_hashes`(slug별 sha256), `failed`(orphan_version 포함 가능)도 반환. 호출자는 pre-batch `ls pages/` 스냅샷과 교차 검증하고, 실제 파일시스템에 대해 reconcile하며, `^[a-z0-9][a-z0-9-]*\.md$` 정규식으로 filename validation을 수행한 뒤 `pages_created` vs `pages_updated`를 권위적으로 분류합니다.
- **`index.json` 업데이트가 manifest frontmatter를 직접 사용** — 메인이 더 이상 페이지를 쓰지 않으므로, agent의 `created`/`updated` 각 엔트리는 페이지 frontmatter에 쓴 정확한 `title`/`tags`/`aliases`를 담습니다. 메인은 이 값들을 그대로 `index.json`에 반영 — 페이지 바디 재독 없이 index가 항상 agent가 쓴 내용과 동기화됩니다.
- **멀티소스 배치의 per-source provenance** — 배치 내 각 source는 자신의 `.wiki-meta/sources/<slug>.yaml`과 자신의 `log.jsonl` 라인을 갖습니다. agent가 entry별로 반환하는 `sources` 리스트가 slug별 filtering을 수행하므로, 어떤 slug가 실제로 기여한 페이지만 그 slug의 `pages_created`/`pages_updated`에 나타납니다. `wiki-lint`의 source-provenance 불변(페이지 frontmatter의 `sources:` slug는 모두 `.wiki-meta/sources/<slug>.yaml`의 `pages_*`에 포함되어야 함)이 멀티소스 배치에서도 유지됩니다.
- **`content_hash`를 agent가 fetch/read 시점에 계산** — 이전에는 메인이 agent의 작업 이후 URL을 `curl`로 재fetch하거나 파일을 다시 `shasum`하여 hash drift 리스크(동적 콘텐츠, cookie, UA 차이 등)와 2배의 네트워크/디스크 비용이 발생했습니다. 이제 agent가 각 소스를 ingest하며 sha256을 계산하고 `source_hashes` map으로 반환 — 메인은 이 값을 그대로 `sources/<slug>.yaml`에 기록합니다. hash는 실제로 ingest된 바이트를 정확히 반영.
- **`--synthesize` 플래그 의미 축소 (힌트 전용)** — backward compatibility를 위해 여전히 수용하지만 어떤 분기 로직도 이 플래그에 의존하지 않습니다. synthesis 동작은 이제 모든 배치의 디폴트.
- **Agent tool scope 확장** — `wiki-synthesizer`에 `WebFetch` 추가 (`type: url` 소스를 직접 읽음). `Read`/`Write`/`Glob`/`Grep`은 기존 유지. Write 권한은 여전히 `<wiki_root>/pages/`와 `<wiki_root>/.wiki-meta/.versions/`로만 제한.
- **Pasted-text ingest 경로 통일** — `type: text`의 경우 `/wiki-ingest`가 붙여넣은 텍스트를 `<wiki_root>/.wiki-meta/.inbox/<slug>.txt`로 먼저 저장한 뒤 dispatch하므로, agent는 다른 파일과 동일한 방식으로 읽습니다. inbox 파일은 락을 해제하는 동일 trap에서 삭제 (성공/실패 무관).
- **Pre-filter 누락에 대비한 overlap 탐지 강화** — agent에 전달되는 `candidates` 리스트는 이제 exhaustive가 아닌 힌트임이 명시됩니다. `wiki-synthesizer` Rule 5는 agent가 부여하려는 topic 이름이 candidate list 외의 기존 페이지와 overlap할 가능성이 있으면 `Glob "<wiki_root>/pages/*.md"` + `Grep`으로 범위를 넓히도록 요구합니다. filename/URL 기반 pre-filter가 semantic overlap을 놓치더라도 "merge, don't duplicate" 불변이 유지됩니다.
- **Post-write reconciliation 추가** — agent가 반환한 뒤 메인은 `created`/`updated`의 각 `file`이 실제로 디스크에 존재하는지 `test -f`로 검증합니다. 없는 파일은 `failed`로 이동하며 reason은 `"agent reported written but file not present"`. agent crash나 manifest 거짓 보고를 metadata 오염 전에 탐지.

### 유지 (기능 불변)

- 락(`.wiki-meta/.wiki-lock` mkdir/rmdir atomicity) — 불변
- `.pending-scan → .last-scan` 승격 + `BATCH_PENDING` 레이스 가드 + `TS_RE` 크기 가드 + rmdir 이전 승격 순서 — 불변
- 부분/전체 실패 시맨틱 — 어떤 실패에서도 `.pending-scan` 승격 안 함. 다음 세션의 훅이 동일 윈도우를 재탐지
- `index.json` / `log.jsonl` / `sources/*.yaml` 온디스크 스키마 — 불변. 멀티소스 배치의 data quality는 오히려 **강화됨** (per-source attribution이 이전 암묵적 추론에서 권위적 보장으로 전환).
- `.wiki-meta/.versions/` last-3 보관 정책 — 메인 auto-lint auto-fix에서 그대로 처리
- Auto-lint(스키마 준수, broken link, index drift, orphan 탐지) — 불변
- UTC ISO 8601 `Z` 타임스탬프 요구 — 불변

### 마이그레이션

별도 조치 불필요. 기존 wiki는 그대로 동작하며, 관찰 가능한 변화는 ingest 중 메인 세션 컨텍스트 사용량 감소와 멀티소스 배치의 per-source provenance 정확도 향상입니다 (v1.1.1은 `--synthesize`를 거의 쓰지 않아 이 불명확성이 표면화되지 않았음). `--synthesize` 플래그 사용도 그대로 동작합니다 (1.2.0에서 제거 예정).

## [1.1.1] — 2026-04-17

### 보안

- **로컬 권한 오버라이드 실수 커밋 방지** — `.gitignore`에 `.claude/settings.local.json`과 `.claude/.sensor-detection-cache.json`을 추가. 이 파일들은 저장소 범위의 파일시스템/실행 권한을 부여할 수 있어 다른 기여자에게 전파되어선 안 됨. (R3, Codex adversarial review)
- **파괴적 `git rm --cached -r . && git reset --hard` 지시 제거** — 업그레이드 문서에서 해당 명령을 삭제하고, clean working tree 전제의 안전한 `git add --renormalize` 절차로 교체. (R2)

### 수정

- **macOS bash 3.2에서 SessionStart hook 크래시** — `"${ARR[@]}"` 순회 전마다 `${#ARR[@]}` 가드를 추가하여 `NEW_FILES`가 비어 있는 recents 병합 단계에서 `unbound variable` 오류로 훅이 중단되지 않도록 함. (C1)
- **자동 ingest 스킵 시 파일 유실 위험** — 훅이 감지 시각을 `.last-scan`에 바로 쓰지 않고 `.wiki-meta/.pending-scan`에 **원자적으로**(`mktemp` + `mv`) 기록. `wiki-ingest`가 배치 성공 후에만 pending → committed 승격하며, 배치 시작 시점의 pending 값을 snapshot해 동시 세션이 `.last-scan`을 실제 처리 범위 너머로 진격시키지 못하도록 race 보호. (H1, 원자성·레이스 하드닝 포함)
- **`wiki_prefix: "."` 엣지 케이스** — 위키가 vault 루트에 있을 때 `pages/`, `.wiki-meta/`, `index.md`, `log.md`, `log.jsonl`을 훅이 명시적으로 제외하여 위키가 자기 자신을 ingest하는 루프를 방지. (H3)
- **YAML config 파싱 블록 경계 인식** — `wiki_root`, `obsidian_cli.available`, `wiki_prefix` 파싱을 awk state machine으로 교체. 다른 top-level 키 아래의 `available: true`가 `obsidian_cli` 블록으로 잘못 귀속되지 않도록 블록 경계를 엄격히 준수. 인라인 주석·따옴표 제거. (H2)
- **로그 타임스탬프 일관성** — 모든 커맨드가 UTC ISO 8601 + `Z` 접미사(`date -u +"%Y-%m-%dT%H:%M:%SZ"`) 사용을 강제. `wiki-schema.yaml`에 `ts_format` 명시. 과거의 `+09:00` 항목은 그대로 읽기 가능. (M1)
- **`pages_created` 중복** — 분류 규칙 명문화: 파일명은 ingest 시작 시점에 존재하지 않았을 때만 `pages_created`에 포함되며, 이미 있던 파일은 `pages_updated`에 기록. 로그 전체에서 동일 파일명은 `pages_created`에 최대 1회만 출현. `wiki-lint`에 중복을 `[LOG-INVARIANT]`로 보고하는 체크 추가. (M4)

### Windows 호환성

- **CRLF 라인 엔딩** — `.gitattributes`를 추가해 모든 shell/YAML/JSON/Markdown에 LF 강제. README/CHANGELOG에 1.1.1 이전 clone을 위한 안전한 재정규화 절차를 문서화. (W-C1)
- **`timeout.exe` 충돌** — 훅이 `/windows/system32/timeout[.exe]$` 경로 경계 앵커 regex로 Windows native timeout을 감지·skip. "windows"를 이름에 포함한 무관한 경로(`/Users/alice/Windows-related/...`)의 정당한 GNU timeout은 false-positive 없이 그대로 사용. (W-H1)
- **셸 의존성 명시** — README/README.ko에 Windows는 Experimental로 표기되고 Git Bash 또는 WSL2 필요함을 명시. (W-H2, W-M1, 부분 해결 — Known Limitations 참조)
- **Windows 네이티브 경로 거부** — `C:\Users\...` 또는 `C:/Users/...` 형태 `wiki_root`에 대해 친절한 오류 메시지와 POSIX 형식 안내. (W-H3)
- **Obsidian CLI (Windows)** — `wiki-setup`이 `%LOCALAPPDATA%\Programs\Obsidian\`을 PATH에 추가하는 방법을 안내. (W-M2)
- **Google Drive + 로케일** — README가 Git Bash에서의 Google Drive 마운트 컨벤션을 문서화하고 placeholder 파일 mtime 이슈 회피를 위한 오프라인 미러 모드 권장. (W-M3)
- **NTFS 대소문자 비구분 + long-path 안내** — README Windows 설정에 스키마의 kebab-case 규칙이 NTFS 대소문자 충돌을 방지함을 명시하고, `.wiki-meta/.versions/` 깊은 경로를 위한 Windows 10 1607+ long-path 지원 활성화를 안내. (W-L1, W-L2)

### 변경

- **훅 heredoc 태그** `EOJSON` → `EOMSG` (출력은 JSON이 아닌 plain text systemMessage). (L1)
- **hook command timeout 단위**를 스크립트 헤더 주석에 문서화 (15초). 사용자에게 노출되는 `hooks.json` `description`에는 섞지 않음. (L4)
- **`case` 패턴** 이 `"${WIKI_PREFIX}"`를 인용하여 향후 공백 포함 값에 대비. (L2)
- **업그레이드 안내 추가** — 1.0.x / 1.1.0에서 올라온 사용자는 `/wiki-setup`을 재실행하여 Obsidian CLI 자동 감지를 반영. (M3 — 부분 해결, Known Limitations 참조)

### 알려진 한계 (부분 해결; 잔여 작업은 1.2.0으로 이월)

- **M2 CLI timeout fallback**: Windows `timeout.exe`는 skip되지만, 범용 POSIX fallback(`perl -e 'alarm N'` 등)은 추가되지 않음. coreutils가 없는 macOS 사용자는 `obsidian recents`가 여전히 timeout 없이 실행될 수 있음.
- **M3 런타임 재-setup 안내**: README 문서화는 완료되었으나, 각 커맨드가 "CLI 감지되었는데 config 미등록 — `/wiki-setup` 재실행 권장" 1회성 노티스를 출력하지는 않음.
- **W-H2 shell 부재 대응**: Windows는 Experimental로 표기되었으나, `bash`가 PATH에 없을 때 훅이 친절한 오류를 내는 기능이나 PowerShell 포트는 포함되지 않음.
- **과거 로그 마이그레이션**: 기존 `log.jsonl`의 `+09:00` 항목은 그대로 유지. UTC 정규화 마이그레이션 스크립트는 포함되지 않음.
- **wiki_prefix='.' end-to-end**: 훅의 recents 필터는 vault-root 모드에서 wiki artifact를 올바르게 제외하지만(1.1.1에서 추가), `find` 경로는 여전히 `VAULT_ROOT = dirname(WIKI_ROOT)`를 사용해 `wiki_root`의 부모를 탐색한다. vault=wiki의 end-to-end 지원은 `find` 단계 분기 추가가 필요하며 후속 수정 대상.

### 비고

모든 변경은 하위 호환. `.pending-scan`은 추가형 파일이며 기존 `.last-scan` 동작을 보존. 과거 타임존 혼재 로그도 그대로 읽히며, UTC 강제는 신규 항목에만 적용.

## [1.1.0] — 2026-04-08

### 추가

- **Obsidian CLI 통합** — `/wiki-setup`이 위키가 Obsidian vault 안에 있을 때 Obsidian CLI(`obsidian`)를 자동 감지합니다. 감지되면 위키 명령어들이 Obsidian의 전문 텍스트 검색, 백링크 그래프, 고아 페이지 감지, 미해결 링크 추적을 활용하여 더 정확한 결과를 제공합니다.
- **향상된 검색** — `/wiki-ingest`와 `/wiki-query`에서 Obsidian CLI 사용 가능 시 Grep 대신 `obsidian search:context`로 겹침 감지 및 콘텐츠 검색을 수행합니다.
- **그래프 기반 쿼리 확장** — `/wiki-query`에 Layer 2.5 추가. 백링크를 따라가 키워드 매칭을 넘어선 관련 페이지를 발견합니다 (Obsidian CLI 전용).
- **개선된 lint 검사** — `/wiki-lint`, `/wiki-ingest` auto-lint, `/wiki-rebuild` auto-lint가 `obsidian orphans`, `obsidian unresolved`, `obsidian backlinks`를 활용하여 더 정확한 구조 건강 검사를 수행합니다. 모든 vault-wide 결과는 위키 경계로 후처리 필터링됩니다.
- **하이브리드 SessionStart 스캔** — auto-ingest hook이 `find` 기반 스캔에 `obsidian recents`를 보충합니다 (합집합 + 중복 제거). 모든 후보는 mtime 검증을 통과해야 미수정 파일의 불필요한 ingest를 방지합니다.
- **추천 도구에 `obsidian` 추가** — `wiki-schema.yaml` CLI 도구 목록에 추가.

### 변경

- **Config 스키마 확장** — `~/.claude/deep-wiki-config.yaml`에 선택적 `obsidian_cli` 블록 추가 (`available`, `vault_name`, `vault_path`, `wiki_prefix` 필드). 이 블록이 없으면 파일시스템 전용 모드 (완전 하위 호환).
- **`/wiki-setup` 재실행 안전성** — 재실행 시 기존 `obsidian_cli` config 블록을 삭제 후 재감지하여, CLI 제거 시 stale config 방지.
- **macOS 호환성** — SessionStart hook이 GNU coreutils를 가정하지 않고 `timeout`/`gtimeout` 가용성을 자동 감지.

### 설계 원칙

- **점진적 향상** — Obsidian CLI는 파일시스템 작업을 향상할 뿐 대체하지 않습니다. 모든 명령어는 앱 미실행 시 graceful 폴백.
- **위키 경계 필터링** — 모든 vault-wide CLI 결과(`orphans`, `unresolved`, `tags`)는 `wiki_prefix/pages/`로 후처리 필터링하여 비관련 vault 노트가 리포트를 오염시키지 않도록 합니다.
- **쓰기는 파일시스템 유지** — 페이지 생성/수정, lock 관리, index/log 업데이트는 모두 Write/Edit 도구로 정밀 제어.

## [1.0.1] — 2026-04-07

### 추가

- **자동 ingest SessionStart hook** — Claude Code 세션 시작 시 Obsidian vault의 새로운/수정된 파일을 자동 감지하고 위키에 ingest. 수동 작업 불필요.
- **일괄 ingest 지원** — `/wiki-ingest`가 auto-ingest hook의 다중 파일을 일괄 처리 지원. 단일 lock, 그룹별 로그 기록.

## [1.0.0] — 2026-04-07

### 마일스톤

첫 번째 안정 릴리스. Karpathy의 LLM Wiki 글에서 제시한 모든 핵심 기능이 구현되었으며, 실제 Obsidian vault 마이그레이션(700+ 파일 → 107개 위키 페이지)을 통해 시스템이 검증되었습니다.

### 추가 (0.2.0 이후)

- **실전 검증** — PARA 구조의 Obsidian vault 전체(PROJECT, RESOURCE, AREA, ARCHIVE, DAILY 노트)를 deep-wiki로 마이그레이션하여 대규모 운영 가능성을 입증.

---

## [0.2.0] — 2026-04-07

### 추가

- **Query 자동 환류** — `/wiki-query`가 2개 이상의 페이지에서 교차 합성 인사이트를 생성하면, 결과가 자동으로 `query-synthesis` 페이지로 위키에 저장됩니다. 가치 있는 쿼리 결과가 지식 베이스에 복리로 쌓여야 한다는 Karpathy의 원칙을 구현합니다.
- **쓰기 작업 후 자동 lint** — `/wiki-ingest`와 `/wiki-rebuild` 후 lint 검사가 자동 실행됩니다. 구조적 문제(인덱스 불일치, 초과 버전)는 자동 수정하고, 사람의 판단이 필요한 문제만 보고합니다. 사용자가 lint를 기억할 필요가 없습니다.
- **`/wiki-setup`에서 추천 도구 확인** — 설정 시 CLI 도구(qmd, marp)와 Obsidian 플러그인(Dataview, Marp Slides, Web Clipper)의 설치 여부를 확인하고 설치 명령어를 안내합니다.
- **`recommended-tools.md` 참조 문서** — qmd, Marp, Dataview, Marp Slides, Obsidian Web Clipper 상세 가이드.
- **`wiki-schema.yaml`에 `recommended_tools`, `auto_lint` 스키마 정의** 추가.
- **CHANGELOG.md / CHANGELOG.ko.md** — 이 파일.

### 수정

- **`wiki-lint.md` 단계 번호 오류** — 8, 8, 10, 10이 8, 9, 10, 11로 수정됨.

### 변경

- `/wiki-query`가 더 이상 읽기 전용이 아닙니다. 교차 페이지 인사이트가 감지되면 자동으로 합성 페이지를 작성합니다.
- `/wiki-ingest`에 자동 lint 단계(Step 13) 추가. 최종 리포트 전에 실행됩니다.
- `/wiki-rebuild`에 자동 lint 단계(Step 5) 추가. 리포트 전에 실행됩니다.
- `wiki-schema` 스킬에 Auto-Lint, Query Auto-Filing 섹션 추가.
- `wiki-schema.yaml`에 `auto_lint`, `query_auto_filing`, `log.actions` 정의 추가.
- README(EN/KO)에 추천 도구 섹션, Obsidian 자동 체크 설명, 명령어 설명 갱신.

## [0.1.0] — 2026-04-06

### 추가

- Karpathy의 LLM Wiki 철학을 구현한 초기 릴리스.
- 5개 명령어: `/wiki-setup`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`.
- 다중 소스 합성을 위한 `wiki-synthesizer` 에이전트.
- 페이지 템플릿, 스키마 YAML, 저장소 레이아웃 참조를 포함한 `wiki-schema` 스킬.
- 콘텐츠 해싱을 통한 소스 출처 추적.
- `mkdir` 기반 동시성 잠금 프로토콜.
- 페이지 버전 관리 (최근 3개 유지).
- 이중 아티팩트: 사람이 읽는 용도(`index.md`, `log.md`) + 머신 리더블(`index.json`, `log.jsonl`).
- Obsidian 볼트 호환성.
- deep-work 세션 리포트 연동.
- 예시 페이지를 포함한 테스트 위키.
- 이중 언어 문서화 (EN/KO).
