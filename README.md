# deep-wiki

LLM이 관리하는 마크다운 위키 — Karpathy의 LLM Wiki 철학 기반.

RAG처럼 매번 지식을 재발견하는 대신, Claude Code가 마크다운 위키에 지식을 축적합니다.

## 설치

```bash
# Claude Code 플러그인으로 설치
claude --plugin-dir /path/to/deep-wiki
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

# 4. 위키 건강 점검
/deep-wiki:wiki-lint
```

## 명령어

| 명령어 | 설명 |
|--------|------|
| `/wiki-setup` | 위키 초기화 및 디렉토리 구조 생성 |
| `/wiki-ingest` | 소스(URL, 파일, 텍스트)를 읽어 위키 페이지 생성/업데이트 |
| `/wiki-query` | 위키에서 검색하고 답변 생성 |
| `/wiki-lint` | 건강 점검 — 스키마 위반, 고아 페이지, 깨진 링크 탐지 |
| `/wiki-rebuild` | index.json을 페이지 frontmatter에서 재생성 |

## 아키텍처

Karpathy의 3계층 모델:

```
Raw Sources  →  Wiki (마크다운 페이지)  →  Schema (관리 규칙)
    ↑                   ↑                       ↑
 wiki-ingest        pages/              wiki-schema skill
```

### 저장 구조

```
<wiki_root>/
├── .wiki-meta/
│   ├── index.json          # 페이지 카탈로그
│   ├── sources/            # 소스 출처 추적
│   └── .versions/          # 덮어쓰기 전 백업
├── log.jsonl               # 이벤트 로그
└── pages/                  # 위키 페이지 (flat, 태그 기반)
```

## 설정

`~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: ~/Obsidian/MyVault/wiki
```

## Obsidian 호환성

- Obsidian 볼트 안에 위키를 생성하면 그래프 뷰, 백링크 등을 활용할 수 있습니다
- Obsidian 없이도 순수 마크다운 디렉토리로 동작합니다
- `.wiki-meta/` 디렉토리는 Obsidian에서 자동으로 숨겨집니다

## deep-work 연동

deep-work 세션 리포트를 위키에 추가:

```bash
/deep-wiki:wiki-ingest /path/to/deep-work/session/report.md
```

## 라이선스

MIT
