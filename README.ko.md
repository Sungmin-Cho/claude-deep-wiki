# deep-wiki

**[English](README.md)**

LLM이 관리하는 마크다운 위키 — [Karpathy의 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 철학을 구현한 Claude Code 플러그인.

> *"대부분의 사람들이 LLM과 문서를 사용하는 방식은 RAG입니다. 파일 모음을 업로드하면 LLM이 쿼리 시점에 관련 청크를 검색하고 답변을 생성합니다. 이건 작동하지만, LLM은 매번 질문할 때마다 지식을 처음부터 재발견하고 있습니다. 축적이 없습니다."*
> — Andrej Karpathy

## 핵심 아이디어

매번 지식을 재발견하는 RAG 대신, Claude Code가 **점진적으로 영구 위키를 구축하고 유지**합니다 — 구조화되고 상호 연결된 마크다운 파일 모음입니다. 새 소스를 추가하면 LLM이 읽고, 핵심 정보를 추출하고, 기존 위키에 통합합니다. 지식은 한 번 컴파일되고 최신 상태로 유지되며, 매 쿼리마다 다시 도출되지 않습니다.

**위키는 영구적이고 복리로 쌓이는 산출물입니다.** 교차 참조는 이미 되어 있고, 모순은 이미 표시되어 있고, 합성은 이미 읽은 모든 것을 반영합니다.

## 아키텍처

Karpathy의 3계층 모델 기반:

```
Raw Sources  →  Wiki (마크다운 페이지)  →  Schema (관리 규칙)
    ↑                   ↑                       ↑
 wiki-ingest        pages/              wiki-schema skill
```

| 계층 | 설명 | 소유자 |
|------|------|--------|
| **Raw Sources** | 변경 불가 입력 — 파일, URL, 텍스트, 리포트 | 사용자가 큐레이션 |
| **Wiki** | LLM이 생성한 교차 참조 마크다운 페이지 | LLM이 작성, 사용자가 읽음 |
| **Schema** | 위키 구조와 유지 방법을 규정하는 규칙 | 함께 발전 |

## 설치

### 사전 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 설치 및 설정 완료

### Git을 통한 설치

```bash
# 1. 플러그인 리포지토리 클론
git clone https://github.com/Sungmin-Cho/claude-deep-wiki.git

# 2. 로컬 마켓플레이스에 추가
claude plugin marketplace add /path/to/claude-deep-wiki

# 3. 플러그인 설치
claude plugin install deep-wiki@<marketplace-name>
```

이미 로컬 마켓플레이스가 설정되어 있다면:

```bash
# 1. 로컬 마켓플레이스 plugins 디렉토리에 클론
git clone https://github.com/Sungmin-Cho/claude-deep-wiki.git ~/.claude/local-marketplace/plugins/deep-wiki

# 2. marketplace.json에 플러그인 항목 추가
# 3. 업데이트 및 설치
claude plugin marketplace update <marketplace-name>
claude plugin install deep-wiki@<marketplace-name>
```

## 시작하기

```bash
# 1. 위키 초기화
/deep-wiki:wiki-setup ~/Obsidian/MyVault/wiki

# 2. 소스를 위키에 추가
/deep-wiki:wiki-ingest https://example.com/article
/deep-wiki:wiki-ingest ./document.pdf
/deep-wiki:wiki-ingest  # 텍스트를 직접 붙여넣기

# 3. 위키에서 질문
/deep-wiki:wiki-query React hooks의 규칙은?

# 4. 건강 점검
/deep-wiki:wiki-lint
```

## 명령어

| 명령어 | 설명 |
|--------|------|
| `/wiki-setup` | 위키 초기화 및 디렉토리 구조 생성 |
| `/wiki-ingest` | 소스(URL, 파일, 텍스트)를 읽어 위키 페이지 생성/업데이트 |
| `/wiki-query` | 위키에서 검색하고 근거 있는 답변 생성 |
| `/wiki-lint` | 건강 점검 — 스키마 위반, 고아 페이지, 깨진 링크, 모순 탐지 |
| `/wiki-rebuild` | index.json을 페이지 frontmatter에서 재생성 |

### 연산 상세

**Ingest** — 새 소스를 추가하면 LLM이 처리합니다. 소스를 읽고, 요약 페이지를 작성하고, 인덱스를 업데이트하고, 위키 전반의 관련 페이지를 갱신하고, 로그에 기록합니다. 하나의 소스가 여러 위키 페이지에 영향을 줄 수 있습니다. 새 정보는 기존 콘텐츠와 병합됩니다 — 페이지는 ingest할수록 풍부해집니다.

**Query** — 위키에 질문합니다. LLM이 3계층 전략(인덱스 스캔 → 콘텐츠 검색 → 후보 읽기)으로 관련 페이지를 찾고, 위키 콘텐츠에 근거한 답변을 인용과 함께 합성합니다.

**Lint** — 위키 건강 점검. 스키마 위반, 페이지 간 모순, 인바운드 링크 없는 고아 페이지, 깨진 링크, 오래된 버전, 인덱스 불일치를 탐지합니다. `--fix` 플래그로 구조적 문제를 자동 수정할 수 있습니다.

**Rebuild** — 페이지 frontmatter에서 `index.json`을 재생성합니다. 인덱스가 동기화되지 않거나 손상되었을 때 사용합니다.

## 저장 구조

```
<wiki_root>/
├── index.md                  # LLM이 작성한 카탈로그 (사람이 읽는 용도)
├── log.md                    # LLM이 작성한 연대기 (사람이 읽는 용도)
├── .wiki-meta/
│   ├── index.json            # 머신 리더블 페이지 카탈로그 (파생)
│   ├── sources/              # 소스별 출처 추적 YAML 파일
│   └── .versions/            # 덮어쓰기 전 페이지 백업 (최근 3개)
├── log.jsonl                 # append-only 구조화 이벤트 로그
└── pages/                    # 위키 페이지 (flat 구조, 태그 기반 분류)
```

주요 설계 결정:
- **Flat pages 디렉토리** — 하위 디렉토리 없음. 태그가 카테고리를 대체 (더 유연하고, 이동 시 링크 깨짐 없음)
- **이중 아티팩트** — `index.md`/`log.md`는 LLM이 사람을 위해 작성; `index.json`/`log.jsonl`은 머신 리더블 대응물
- **`.wiki-meta/`는 숨김** — Obsidian 그래프 뷰와 파일 탐색기에서 보이지 않음

## 설정

`~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: ~/Obsidian/MyVault/wiki
```

## Obsidian 호환성

- Obsidian 볼트 안에 위키를 생성하면 그래프 뷰, 백링크, 검색을 활용할 수 있습니다
- Obsidian 없이도 순수 마크다운 디렉토리로 동작합니다
- `.wiki-meta/` 디렉토리는 Obsidian에서 자동으로 숨겨집니다
- 표준 마크다운 링크 사용 (wikilink 아님)으로 이식성 보장

**추천 Obsidian 플러그인:**
- **Graph view** — 위키의 형태, 허브, 고아 페이지를 시각적으로 확인
- **Dataview** — 페이지 frontmatter(태그, 소스)를 쿼리하여 동적 테이블 생성
- **Marp** — 위키 콘텐츠에서 슬라이드 덱 생성

## deep-work 연동

deep-work 세션 리포트를 위키에 추가:

```bash
/deep-wiki:wiki-ingest /path/to/deep-work/session/report.md
```

## 철학

이 플러그인은 Karpathy의 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에서 설명한 패턴을 구현합니다:

> *"지식 베이스 유지의 지루한 부분은 읽기나 사고가 아닙니다 — 기록 관리입니다. 교차 참조 업데이트, 요약을 최신 상태로 유지, 새 데이터가 기존 주장과 모순될 때 기록, 수십 페이지에 걸친 일관성 유지. 사람은 유지 보수 부담이 가치보다 빠르게 증가하기 때문에 위키를 포기합니다. LLM은 지루해하지 않고, 교차 참조 업데이트를 잊지 않으며, 한 번에 15개 파일을 수정할 수 있습니다."*

사람의 역할은 소스를 큐레이션하고, 분석을 지시하고, 좋은 질문을 하고, 그 모든 것이 의미하는 바를 생각하는 것입니다. LLM의 역할은 나머지 전부입니다.

## 라이선스

MIT
