---
title: "LLM Wiki Philosophy"
sources:
  - karpathy-llm-wiki-gist
tags:
  - knowledge-management
  - llm
  - architecture
aliases:
  - karpathy wiki
  - llm wiki pattern
---

# LLM Wiki Philosophy

Andrej Karpathy가 제안한 개인 지식 기반 구축 패턴.

## 핵심 문제의식

기존 RAG 방식은 LLM이 매번 질문할 때마다 처음부터 지식을 재발견한다. 축적이 없다. 반복적으로 같은 문서를 처리하지만 학습된 지식이 쌓이지 않는 구조적 한계가 있다.

## 제안하는 해결책

LLM이 원본 문서들 사이에서 지속적으로 유지·업데이트하는 마크다운 기반 위키를 구축한다. 위키는 단순한 저장소가 아닌 **누적되는 산출물**이다.

## 3계층 구조

1. **Raw Sources** — 불변의 원본 문서 (PDF, 노트, URL 등)
2. **The Wiki** — LLM이 작성·관리하는 마크다운 파일들
3. **The Schema** — LLM 지시사항 문서 (CLAUDE.md 또는 AGENTS.md 역할)

## 3가지 핵심 작업

- **Ingest** — 새 소스가 추가되면 위키를 자동 업데이트
- **Query** — 위키 페이지에서 검색하고 답변 생성
- **Lint** — 모순, 고아 페이지, 누락된 참조를 점검

## 특징적 요소

- **Index.md** — 내용 기반 카탈로그
- **Log.md** — 시간순 변경 기록
- Obsidian과의 통합을 통한 시각적 탐색 지원

## References

- Source: Karpathy's LLM Wiki Gist (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
