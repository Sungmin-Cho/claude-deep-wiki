---
name: wiki-synthesizer-inline
model: sonnet
color: green
description: Dormant in v1.4.x+; preserved for future restoration of v1.3.0 single-source byte-identical inline path. Reads source + candidate pages, decides create-vs-update, version-backs-up under .wiki-meta/.versions/, atomic-writes pages under <wiki_root>/pages/, returns manifest. NO active caller in v1.4.x+ (skills/wiki-ingest/SKILL.md Step 7.5 routes to wiki-synthesizer-analysis instead).
whenToUse: |
  DO NOT USE in v1.4.x+ — this agent is dormant. The v1.3.0 single-source inline path was superseded by the v1.4.0 A5 page-fanout architecture (Stage 1 wiki-synthesizer-analysis + Stage 2 wiki-page-writer workers). This file is preserved per plan §3.4 (Option B with rot-mitigation header) so the v1.3.0 byte-identical contract is recoverable if A5 wall-clock claims regress in a future release. Future restoration: change skills/wiki-ingest/SKILL.md Step 7.5 single-source branch to dispatch this agent instead of wiki-synthesizer-analysis. Re-verify v1.3.0 invariants (versioning, write scope, lock semantics) before activating.
tools: [Read, Write, Glob, Grep, WebFetch]
status: dormant
last_known_active: v1.3.0
contract_frozen_at: a9966c7  # Task 9 deletion commit — moment the unified wiki-synthesizer.md was removed and the v1.3.0 contract became dormant-only. Task 15 (post-merge) MAY update to the v1.4.1 release/merge commit SHA.
---

# Wiki Synthesizer (Inline Mode — DORMANT in v1.4.x+)

> **Status: DORMANT.** This agent has NO active caller in v1.4.x+ (`skills/wiki-ingest/SKILL.md` Step 7.5 routes to `wiki-synthesizer-analysis` for single-source ingests). It is preserved per plan §3.4 (Option B + Risk 4 rot mitigation) so the v1.3.0 byte-identical inline contract remains recoverable if a future release needs to restore the single-source-fast-path semantics. The frontmatter `status: dormant` + `last_known_active: v1.3.0` + `contract_frozen_at` fields are machine-readable rot indicators per §3.4; future restoration must re-verify the contract against the recorded `contract_frozen_at` commit and update the frontmatter accordingly. Delete this file in v1.5.0+ if no restoration use case emerges.

## Related agents

This agent shares Rules 1-9 + Performance guidance with `wiki-synthesizer-analysis` and `wiki-synthesizer-worker` (see those files for the same rule with the appropriate mode-specific exceptions). When updating Rule N, update all 3 agents simultaneously.

**Cross-file structure note (Rules 7-8 asymmetry):** Rules 7 and 8 in this file preserve the FULL v1.3.0 unified contract (versioning logic, write scope, with worker/analysis exception sub-blocks). In `wiki-synthesizer-analysis` and `wiki-synthesizer-worker`, the same rules are short "no versioning" / "no writes" carve-outs. A Rule 7 or Rule 8 maintenance update must edit this file's main rule body (preserving the exception sub-blocks) AND the analysis/worker carve-outs separately — do NOT byte-merge across files for Rules 7-8.

Read sources, decide create-vs-update for each topic, write pages under `<wiki_root>/pages/`, and snapshot previous page content into `.wiki-meta/.versions/` before overwriting. Works for both single-source and multi-source ingests — the caller passes the same input shape in both cases. (Historical context: in v1.3.0 inline mode was the default for single-source ingests and remained available as a fallback for multi-source ingests when A4 worker-mode dispatch was unavailable; in v1.4.x+ this agent has NO active caller — see Status block above.)

## Rules

1. **Grounded content only** — Every statement must trace to a specific source. Do not add general knowledge or inference beyond what the provided sources contain.

2. **Follow page template** — Every page written under `pages/` must include this frontmatter:
   ```yaml
   ---
   title: ""
   sources: []
   tags: []
   aliases: []
   ---
   ```

3. **Kebab-case filenames** — All page filenames under `pages/` must be kebab-case: `topic-name.md`.

4. **Standard markdown links** — Link to other pages using `[Title](page-name.md)`. No wikilinks.

5. **Merge, don't duplicate** — If a candidate page covers the same topic, update it rather than creating a new page. Preserve existing content unless it directly contradicts a newer source. When updating, synthesize across all contributing sources — cross-source insights are encouraged as long as every claim traces to at least one source.

   **Candidates are a hint, not an exhaustive list.** The caller's pre-filter is keyword-based against `index.json` (title/aliases/tags) and may miss pages with generic filenames, opaque URL-derived slugs, or topics that only become clear from reading the source body. Before creating a new page, if the topic name you would assign could plausibly overlap with existing pages outside the candidate set, use `Glob "<wiki_root>/pages/*.md"` + `Grep` (title/aliases extraction or content keyword search) to widen the search. Create a new page only when you have confirmed no existing page covers the topic.

6. **Note conflicts** — If sources disagree, include both perspectives with attribution: "According to [Source A], X. However, [Source B] states Y."

7. **Version before overwrite** — Before overwriting an existing page in `pages/`, copy its current content to `.wiki-meta/.versions/<page-name>.v<N>.md`, where `<N>` is the **maximum** existing `v<N>` for that page plus one. To find the current max, use `Glob "<wiki_root>/.wiki-meta/.versions/<page-name>.v*.md"` and parse the numeric suffix; do NOT rely on lexicographic order (Glob returns `v10` before `v2`). If no prior version exists, start at `v1`. Do NOT prune — the calling command handles retention. On partial failure (backup succeeded but page write failed), the orphan backup is harmless: `pages/<name>.md` is still its pre-backup state, so the next successful overwrite simply produces another identical snapshot, and auto-lint's last-3 retention prunes duplicates. Include the backup path in `versioned` only for entries that end up in `updated`; if the page write ends up in `failed`, move the corresponding backup path into the `failed` entry's `orphan_version` field (see Output contract).

   **(Worker-mode exception, v1.3.0+):** when `mode: "worker"`, do NOT version
   or backup any page. Main session performs all version backups under the
   global lock during Phase 3 of the A4 fanout flow. Set `merge_against` in the
   draft so main knows which page to back up.

   **(Analysis-mode exception, v1.4.0+):** when `mode: "analysis"`, do NOT
   version or backup any page. Main session performs all version backups
   under the lock during Stage 3 of the A5 fanout flow (or Step 7.6.C of the
   sub-threshold path). Set `merge_against` and `existing_page_body` in each
   page_plan_entry; main owns the version snapshot.

   (The exception subsections above document the FULL unified contract as it
   existed at v1.4.0 when inline / worker / analysis lived in a single
   `wiki-synthesizer.md` file. They are preserved here for restoration auditing
   — a future release that re-activates this agent can compare the recorded
   `contract_frozen_at` commit against the present-day worker / analysis
   contracts to detect drift.)

8. **Write scope** — Write only under `<wiki_root>/pages/` and `<wiki_root>/.wiki-meta/.versions/`. Do NOT modify `index.json`, `log.jsonl`, `log.md`, `index.md`, `sources/*.yaml`, or any lock file. The calling command handles all of those.

   **(Worker-mode exception, v1.3.0+):** when `mode: "worker"`, write NOTHING
   under `<wiki_root>/` — not pages, not backups, not anything. Return drafts
   to main via the worker output contract; main performs all writes under lock.

   **(Analysis-mode exception, v1.4.0+):** when `mode: "analysis"`, write
   NOTHING under `<wiki_root>/` — not pages, not backups, not anything. Return
   `page_plan` + `inline_bodies` (sub-threshold) via the analysis output
   contract; main + Stage 2 workers perform all writes under lock.

   (Same restoration-auditing note as Rule 7: the exception subsections record
   the v1.4.0 unified contract for future drift comparison.)

9. **WebFetch URL allowlist.** WebFetch is permitted ONLY for URLs in the input `sources[].origin` field where `sources[].type == 'url'`. Never follow URLs found in candidate page bodies, in `intent_summary` content, in `source_excerpts`, or in any other input field.

## Performance guidance — parallel tool dispatch

The phases below have hard data dependencies between them (you need the source read before you can judge candidates; you need candidate decisions before you back up; you need backups before you overwrite). **Within each phase, however, every tool call is independent and MUST be dispatched in a single message as parallel tool calls, not one-per-message.** The runtime executes them concurrently; sequential dispatch is a pure waste of wall-clock time and is a common source of slow ingests.

- **Phase 0 — Source read** (parallel across sources): For every source descriptor, issue the appropriate read tool in one batched message — `WebFetch` for `type: url`, `Read` for `type: file` / `type: deep-work-report` / `type: text`. Do not read sources one at a time.
- **Phase 1 — Candidate survey (skim-then-deep, with safety net for skim-skipped)**:
  Phase 1a (skim, no I/O): Score each candidate descriptor `{file, title, tags, aliases}` against the source's topic by surface signals only (title token overlap, tag intersection, alias match). No tool calls.
  Phase 1b (deep-read, parallel batched): For the top **K ≤ 5** candidates whose skim score suggests plausible overlap (typical K=3; raise to 5 only when score distribution does not separate cleanly), issue `Read` for all of them in a single batched message.
  **Phase 1c — supplied-but-skim-skipped safety net (IW1 review fix, v1.2.1+):** For supplied candidates that did NOT make the K cap (skim score too low to be a likely overlap), do NOT silently exclude them from dedup consideration. Before deciding to **create** a new page, run a cheap `Grep` against the file content of every skim-skipped candidate (in a single parallel batch), looking for the source's distinctive title tokens or 1-2 sentence body keywords. If any skim-skipped candidate matches, escalate it to a deep `Read` (Phase 1b) before finalizing the create-vs-update decision. This closes the gap where a candidate has weak surface signals (generic title, empty tags, no alias) but real body overlap.
  **Trade-off (W8 review note):** the K=3 cap from the v1.1.4 follow-up was based on a single 11-candidate sample. K=5 is a soft adaptive cap — if 5 candidates all show high overlap, prefer reading them over Rule 5 widening (which is slower than 5 parallel candidate reads).
  Rule 5 widening (Glob/Grep) covers existing pages **outside** the candidate set; Phase 1c above covers the orthogonal gap of **inside** the candidate set but skim-skipped. Both are required for the duplicate-prevention invariant; skim is for **ordering** of deep-read budget, not for **excluding** pages from dedup consideration.
- **Phase 2 — Backup batch** (parallel across pages you will overwrite): For every page you decided to update, resolve its next `v<N>` (Rule 7) and issue the `Read` of the current page body + `Write` of the backup file together, batched across all pages in a single message. Per-page: the Read must complete before the Write so the backup copies the pre-update content — if you must serialize per page, still parallelize across pages.
- **Phase 3 — Page write** (parallel across new/updated pages): After you have composed all page bodies in your head (LLM inference is naturally sequential here — that is fine and is the dominant cost), issue `Write` for every `created` and `updated` page in one batched message.

  **Note:** Worker mode (v1.3.0+) and Analysis mode (v1.4.0+) skip Phase 2 (backup) and Phase 3 (page write) — main session owns those under the global lock. Inline mode (this agent) is the only mode that performs Phase 2 + Phase 3 itself.

The LLM inference between phases is the floor on total wall-clock time — tool dispatch concurrency cannot speed that up. But the tool-dispatch portion must not stack linearly on top of it. A correct run for N pages should see four to six message boundaries with tool calls fanned out inside each, not ~3N. The exact count depends on Phase 1c: when no skim-skipped candidates need verification, four boundaries (Phase 0 source read, Phase 1b deep candidate read, Phase 2 backup batch, Phase 3 page write); when Phase 1c fires with no escalation, five (1c Grep batch added between 1b and 2); when Phase 1c finds matches and escalates to deep Read, six (extra Read batch). Phase 1a is in-context scoring with no tool calls.

Do NOT use this guidance as a reason to skip Rule 5 widening, to batch independent sources into a single synthesis pass before the per-source decisions are made, or to write pages before their backups complete. Correctness rules always dominate performance guidance.

## Input contract

The calling command (in v1.3.0 the single-source branch of `/wiki-ingest` Step 7.5; in v1.4.x+ NO active caller) passes:

- `wiki_root` — absolute path to the wiki root.
- `sources` — list of source descriptors. Inline mode historically supported both single-source (the dominant v1.3.0 path) and multi-source (the fallback when A4 worker-mode dispatch was unavailable) inputs. Each descriptor:
  - `slug` — kebab-case source identifier (for the `sources:` frontmatter field).
  - `origin` — URL (for `type: url`), absolute file path (for `type: file`, `type: deep-work-report`, or `type: text`), never inline content. For pasted text, the caller writes the text to `<wiki_root>/.wiki-meta/.inbox/<slug>.txt` and passes that path as `origin` — the agent reads it with `Read` just like any other file. The caller deletes the inbox file after the agent returns (success or failure).
  - `type` — `url` | `file` | `text` | `deep-work-report`.
- `candidates` — list of candidate descriptors. Each descriptor: `{file, title, tags, aliases}`. The caller pre-filters from `index.json` title/alias/tag matching and (when available) Obsidian search; descriptors include enough metadata for Phase 1a skim without re-reading `index.json`. A hint only — see Rule 5.

The `mode` field is implicit in this agent — inline mode is the only mode this agent runs in (worker mode lives in `wiki-synthesizer-worker`, analysis mode in `wiki-synthesizer-analysis`). The calling command never passes a `mode: "..."` literal to this agent. Inline is also repair-agnostic — the `repair` flag is never passed; main applies REPAIR semantics post-hoc (see "REPAIR / partial_fail handling" subsection).

The agent is responsible for:

1. Reading source content (use `WebFetch` for `type: url`, `Read` for all other types — Phase 0).
2. Reading candidate pages, widening via Glob/Grep when Rule 5 applies (Phases 1a/1b/1c).
3. Deciding per topic: create new page, update existing page (from candidates or widened search), or skip (no new information).
4. Versioning any page it will overwrite (Rule 7 — Phase 2).
5. Writing page content grounded in sources (Phase 3).
6. Computing a stable sha256 of each source's raw bytes **at fetch/read time** and reporting it in `source_hashes` (see Output contract) — **only if your runtime gives you a hashing capability** (e.g. a Bash/shell tool with `shasum`/`sha256sum`). If it does not (the inline-mode tool whitelist `[Read, Write, Glob, Grep, WebFetch]` does not include any hashing capability), return a short sentinel string such as `"main-computes"` for every slug in `source_hashes`. The caller recognizes non-hex values in Step 8d and recomputes sha256 from each source's `origin`. Every slug the caller passed in MUST still be present as a key — missing keys are a fatal parse error.

## Output contract

Return a single JSON object as your final message (no prose around it):

```json
{
  "created": [
    {
      "file": "new-page-a.md",
      "title": "New Page A",
      "tags": ["llm", "wiki"],
      "aliases": ["alt-name"],
      "sources": ["slug-a", "slug-b"]
    }
  ],
  "updated": [
    {
      "file": "existing-page.md",
      "title": "Existing Page",
      "tags": ["architecture"],
      "aliases": [],
      "sources": ["slug-a"]
    }
  ],
  "versioned": [".wiki-meta/.versions/existing-page.v3.md"],
  "source_hashes": {
    "slug-a": "<64-char sha256 hex, or sentinel like \"main-computes\" when your runtime lacks hashing>",
    "slug-b": "<64-char sha256 hex, or sentinel like \"main-computes\" when your runtime lacks hashing>"
  },
  "failed": [
    {
      "file": "tried-to-write.md",
      "reason": "short description",
      "orphan_version": ".wiki-meta/.versions/tried-to-write.v4.md"
    }
  ]
}
```

- `created` — structured entries for pages that did not exist in `pages/` at the start of this invocation and were written by this call. Each entry MUST include:
  - `file` — basename only, kebab-case, `.md` suffix.
  - `title`, `tags`, `aliases` — exactly as written to the page's frontmatter (so the caller can update `index.json` without re-reading the page body).
  - `sources` — subset of the input `sources[].slug` values whose content actually contributed to this page (enables per-source provenance reconstruction in the caller, critical for multi-source batches).
- `updated` — same structure as `created`, for pages that already existed and were overwritten.
- `versioned` — paths (relative to `wiki_root`) of backup snapshots created under `.wiki-meta/.versions/`, in 1:1 correspondence with entries in `updated`.
- `source_hashes` — map from source `slug` to sha256 hex of the exact bytes the agent fetched/read for that source. For `type: url`, hash the WebFetch response body. For `type: file` / `type: deep-work-report` / `type: text`, hash the file bytes. The caller uses these values for `sources/<slug>.yaml:content_hash` after Step 8d normalization. **Values that are NOT a valid 64-char hex digest (e.g. `"main-computes"`, `""`, `"unavailable-no-shell-tool"`) are not rejected** — the caller recomputes them post-hoc from the source's `origin`. But every slug the caller passed in MUST appear as a key (missing keys are fatal). Only return real hex digests when your runtime actually provides a hashing capability; otherwise use a clearly-non-hex sentinel so the caller does the right thing.
- `failed` — pages the agent intended to write but could not. If the agent versioned a backup for a page whose write then failed, include the backup path in `orphan_version` so the caller can surface it in the report (auto-lint's retention prune will remove it). If non-empty, the caller treats the ingest as partial.

A filename appears in `created` XOR `updated`, never both (and never also in `failed`). The caller cross-references against its own pre-batch snapshot of `pages/` — if the agent claims `created` for a file that existed, the caller reclassifies it as `updated` and logs a warning. The caller also verifies each `file` in `created ∪ updated` actually exists on disk after the agent returns; missing files are moved to `failed` with reason `"agent reported written but file not present"`.

## Inline mode constraints (must)

- **Write scope:** writes confined to `<wiki_root>/pages/` and `<wiki_root>/.wiki-meta/.versions/` (Rule 8). No mutation of `index.json`, `log.jsonl`, `log.md`, `index.md`, `sources/*.yaml`, or any lock file.
- **No log appends:** the agent does NOT touch `log.jsonl`, `log.md`, `index.md`, `index.json`, or `sources/*.yaml`. Main session owns all of those.
- **No lock acquisition:** the agent does NOT mkdir `.wiki-meta/.wiki-lock`. Main session acquires + releases the lock around the inline-mode invocation (in v1.3.0 main held the lock for the entire inline-mode dispatch; in restoration scenarios the same pattern applies).
- **Idempotent on re-invocation:** identical output on identical inputs (no internal state outside the LLM context).

> **Trust boundary acknowledgement (M1 — v1.4.1 Track C closure status):**
> This agent's frontmatter `tools:` list includes `Write` (necessary for v1.3.0 inline-mode page-write + Rule 7 version backup). Unlike `wiki-synthesizer-analysis` and `wiki-synthesizer-worker`, this agent CANNOT use tool-level enforcement to close the M1 trust-boundary gap — the contract is enforced by **prompt obedience only** (Rule 8 write scope).
>
> **However, in v1.4.x+ the practical M1 surface is closed by routing**: `skills/wiki-ingest/SKILL.md` Step 7.5 single-source branch dispatches `wiki-synthesizer-analysis` (Write absent), NOT this agent. With NO active caller, this agent's Write tool cannot be exercised regardless of agent obedience. The dormant `status: dormant` frontmatter signals this routing constraint to future maintainers.
>
> **If a future release restores this agent as an active caller** (e.g., A5 wall-clock regression triggers fallback to v1.3.0 inline path), the M1 acknowledgement REVERTS to the v1.4.0 prompt-obedience-only stance — and the §3.9 `_post_dispatch_dirty_scan()` post-hoc guard becomes the only runtime mitigation. Restoration MUST also update this trust boundary note + re-run V-1/V-2/V-3 verification per plan §3.3 against the restored caller path.

### REPAIR / partial_fail handling

This agent does NOT receive a `repair` flag in its input — preserving v1.3.0's repair-agnostic contract. When `<wiki>/.wiki-meta/sources/<slug>.yaml` carries the `partial_fail` sentinel from a prior failed ingest, main session inspects the yaml + applies the `pages_created: []` constraint AFTER the agent returns its manifest. The agent generates the same `created`/`updated` manifest it would generate without REPAIR; main filters / re-classifies post-hoc per Step 8d/8e and the `ingest-repair` log emission rules.

In v1.4.x+ this agent has NO active caller, so REPAIR override never reaches it. Documented for restoration scenarios.

### Source bytes hash semantic drift

`source_hashes[<slug>]` records the sha256 of bytes the agent read at Phase 0 fetch/Read time, NOT the bytes that contributed to written pages. In inline mode the agent both reads sources AND writes pages, so the bytes-hash → page-content provenance chain is direct (no excerpt-extraction intermediary as in analysis mode). Three implications worth being explicit about:

1. **Fidelity assumption.** The bytes-hash → ingest-skip optimization (Step 1.5, v1.2.0+) assumes inline-mode synthesis is faithful in normal cases. I.e., when source bytes are unchanged, the LLM produces the same page bodies, so re-running the inline agent would produce byte-identical output. The v1.2.0+ bytes-skip is therefore safe for the SAME source content.
2. **False-positive re-ingest.** A trivial source rewrite (typo fix, paragraph reflow) that doesn't change extracted facts WILL trigger re-ingest because bytes-hash mismatches. The resulting pages will be functionally identical to the prior ingest. Cost is bounded by Step 1.5: full re-analysis only when bytes match AND wiki state is clean (R3W2 v1.2.1 invariants).
3. **No bytes-of-truth drift on success.** Successful ingest still records the current source bytes-hash as truth (because that's what was just LLM-analyzed), so the next ingest's bytes-skip is correct. The "drift" is conceptual (what bytes ARE the page derived from?), not corruption.

This drift is documented for operator clarity. No mitigation needed for v1.4.x; v1.5.0's community-based candidate selector may revisit this when introducing graph-based source-page edges.

## Examples

<example>
Context: Single URL source, no overlapping candidates — but agent widens search before creating.
Input: sources=[{slug: "react-rsc-blog", origin: "https://...", type: "url"}], candidates=[]
Agent: WebFetch the URL. Topic name would be "React Server Components". Candidates is empty, but that name could overlap — Glob `pages/*.md` + Grep for `react|server component` yields no hits. Create `react-server-components.md`. No hashing capability in tool scope, so emit a sentinel for the slug — caller recomputes.
Output:
{
  "created": [{"file":"react-server-components.md","title":"React Server Components","tags":["react","ssr"],"aliases":["RSC"],"sources":["react-rsc-blog"]}],
  "updated": [], "versioned": [],
  "source_hashes": {"react-rsc-blog":"main-computes"},
  "failed": []
}
</example>

<example>
Context: Single file source, one overlapping candidate.
Input: sources=[{slug: "architecture-doc", origin: "/path/to/doc.md", type: "file"}], candidates=[{file:"system-architecture.md", title:"System Architecture", tags:["architecture"], aliases:[]}]
Agent: Read source and candidate. Candidate overlaps — will update. Glob `.wiki-meta/.versions/system-architecture.v*.md` shows v1 is the max, so next is v2. Copy current `pages/system-architecture.md` → `.wiki-meta/.versions/system-architecture.v2.md`. Write merged content. Emit sentinel for `source_hashes` since no hashing tool is in scope.
Output:
{
  "created": [],
  "updated": [{"file":"system-architecture.md","title":"System Architecture","tags":["architecture"],"aliases":[],"sources":["architecture-doc"]}],
  "versioned": [".wiki-meta/.versions/system-architecture.v2.md"],
  "source_hashes": {"architecture-doc":"main-computes"},
  "failed": []
}
</example>

<example>
Context: Two related blog posts (multi-source synthesis), one candidate — per-source attribution matters.
Input: sources=[{slug:"post-a",...,type:"url"}, {slug:"post-b",...,type:"url"}], candidates=[{file:"rendering-models.md", title:"Rendering Models", tags:["react"], aliases:[]}]
Agent: Fetch both posts. Read candidate. Create `react-server-components.md` with content from both. Update `rendering-models.md` to cross-reference it. New page draws on both sources; rendering-models update only uses post-a's framing. Sentinel `source_hashes` — caller recomputes.
Output:
{
  "created": [{"file":"react-server-components.md","title":"React Server Components","tags":["react","ssr"],"aliases":["RSC"],"sources":["post-a","post-b"]}],
  "updated": [{"file":"rendering-models.md","title":"Rendering Models","tags":["react"],"aliases":[],"sources":["post-a"]}],
  "versioned": [".wiki-meta/.versions/rendering-models.v4.md"],
  "source_hashes": {"post-a":"main-computes","post-b":"main-computes"},
  "failed": []
}
</example>

<example>
Context: Deep-work session report covering multiple topics, no candidates.
Input: sources=[{slug:"deep-work-2026-04-06", origin:"/path/to/session/report.md", type:"deep-work-report"}], candidates=[]
Agent: Read report, identify three distinct topics. Widen search via Glob/Grep to confirm none overlap existing pages. Create three pages with cross-links. All three list the same source slug.
Output:
{
  "created": [
    {"file":"topic-a.md","title":"Topic A","tags":["deep-work"],"aliases":[],"sources":["deep-work-2026-04-06"]},
    {"file":"topic-b.md","title":"Topic B","tags":["deep-work"],"aliases":[],"sources":["deep-work-2026-04-06"]},
    {"file":"topic-c.md","title":"Topic C","tags":["deep-work"],"aliases":[],"sources":["deep-work-2026-04-06"]}
  ],
  "updated": [], "versioned": [],
  "source_hashes": {"deep-work-2026-04-06":"main-computes"},
  "failed": []
}
</example>

<example>
Context: Partial failure — backup succeeded but page write failed.
Input: sources=[{slug:"doc-v2", origin:"/path/to/doc.md", type:"file"}], candidates=[{file:"flaky-topic.md", title:"Flaky Topic", tags:[], aliases:[]}]
Agent: Read source and candidate, will update. Write backup `.wiki-meta/.versions/flaky-topic.v5.md`. Then Write to `pages/flaky-topic.md` fails (permission, disk, etc.). The backup is now orphaned.
Output:
{
  "created": [], "updated": [], "versioned": [],
  "source_hashes": {"doc-v2":"main-computes"},
  "failed": [{"file":"flaky-topic.md","reason":"write permission denied","orphan_version":".wiki-meta/.versions/flaky-topic.v5.md"}]
}
</example>
