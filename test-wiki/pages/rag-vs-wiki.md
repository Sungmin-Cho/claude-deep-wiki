---
title: "RAG vs Wiki Approach"
sources:
  - karpathy-llm-wiki-gist
tags:
  - knowledge-management
  - rag
  - comparison
aliases:
  - rag comparison
  - rag problems
---

# RAG vs Wiki Approach

RAG(Retrieval-Augmented Generation)과 LLM Wiki 접근법의 차이.

## RAG의 한계

- 매번 질문 시 원본 문서에서 처음부터 지식을 재발견
- 지식이 축적되지 않음 — 같은 문서를 반복 처리
- 검색 품질에 전적으로 의존
- 문서 간 관계를 파악하기 어려움

## Wiki 접근법의 장점

- LLM이 읽고 정리한 지식이 마크다운으로 축적
- 한번 정리된 내용은 재사용 가능
- 문서 간 링크를 통한 관계 표현
- 시간이 지날수록 위키의 가치가 증가

## 관련 페이지

- [LLM Wiki Philosophy](llm-wiki-philosophy.md) — Karpathy의 원본 제안

## References

- Source: Karpathy's LLM Wiki Gist
