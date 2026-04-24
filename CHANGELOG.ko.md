# 변경 이력

deep-wiki의 주요 변경사항을 기록합니다.

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
