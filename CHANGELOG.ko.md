# 변경 이력

deep-wiki의 주요 변경사항을 기록합니다.

## [1.1.0] — 2026-04-08

### 추가

- **Obsidian CLI 통합** — `/wiki-setup`이 위키가 Obsidian vault 안에 있을 때 Obsidian CLI(`obs`)를 자동 감지합니다. 감지되면 위키 명령어들이 Obsidian의 전문 텍스트 검색, 백링크 그래프, 고아 페이지 감지, 미해결 링크 추적을 활용하여 더 정확한 결과를 제공합니다.
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
