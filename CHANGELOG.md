# Changelog

All notable changes to deep-wiki are documented here.

## [1.3.0] — 2026-05-02

Architectural minor release. Two parallel-axis changes plus six polish items
carried over from v1.2.1 cycle reviews. Multi-source `/wiki-ingest` now
fans out across up to 3 parallel `wiki-synthesizer` subagents in worker
mode, capturing the LLM-analysis-dominant cost in parallel while keeping
all writes serialized on main under the existing single mkdir-based lock.
Hook YAML parser now accepts inline + dotted forms in addition to block
form. Single-source ingest is byte-identical to v1.2.1 (fast path).

### Architectural

- **A4 — wiki-synthesizer fanout (Approach B)**: multi-source `/wiki-ingest`
  splits sources across `min(3, N)` worker subagents (round-robin by
  sorted source path), dispatched in parallel. Workers do full LLM
  analysis but NO file writes. Main aggregates drafts via cross-worker
  B5 dual-classification ledger and performs all writes sequentially
  under the existing global lock (now acquired in Phase 0 for fanout
  branch only — single-source path keeps v1.2.1 Phase-3-only timing).
  Cross-worker page collisions trigger a second-pass `wiki-synthesizer`
  invocation in worker mode (with new `colliding_drafts` input field) to
  merge conflicting page bodies into one cohesive page — preserves
  v1.2.1 multi-source merge invariant. v1.2.1 invariants (log-line
  uniqueness, per-source provenance, ingest-repair semantics) preserved
  by keeping main as single writer. Worker mode is opt-in via
  `mode: "worker"` parameter on the synthesizer agent; default remains
  `"inline"` for single-source fast path. Hardcoded cap of 3;
  configurable knob deferred to v1.4.0+. Expected wall-clock reduction
  for 3+ source batches: 30–50% (LLM analysis is dominant cost; ideal
  speedup of 3× in practice ~2× due to fastest-source dominance +
  Phase 2/3 sequential).
- **C — Hook YAML parser broaden**: `scan-vault-changes.sh` awk now
  recognizes three forms of `auto_ingest.ignore_globs`: block (current),
  inline (`["a", "b"]`), and dotted (`auto_ingest.ignore_globs: [...]`).
  Same broaden applied to `wiki-lint.md` `lint.orphan_ignore` parser
  (mirror parser per in-repo comment). Closes the v1.2.1 cycle-3
  README/parser mismatch on the parser side. Also fixes a pre-existing
  latent bug in the block-form path (`sub()` mutates `$0` causing
  terminator rule to fire on same line via fall-through, silently
  dropping multi-item block lists after the first).

### Polish

- **1.1 — Delimiter-aware awk slug allocator extractor**: replaces the
  v1.2.0 two-pass sed in `wiki-ingest.md` slug allocator's `prev_origin`
  extraction. Three anchored awk rules (double-quoted / single-quoted /
  unquoted) with `\47` literal-single-quote (POSIX awk portable) handle
  all 3 forms correctly, including embedded opposite-kind quotes
  (e.g., `"/path/with'quote.md"`). The single-pass char-class sed
  initially proposed in Plan #1 was rejected in Cycle-1 cross-validation
  — `[^"']*` capture stops at first inner quote, doesn't actually fix
  the embedded-opposite-kind case.
- **1.2 — Tab-indent recognized as code-block marker**: `wiki-lint.md`
  `strip_code_blocks` awk now matches `/^(    |\t)/` instead of `/^    /`.
  Closes W-γ false-positive on broken-link detection inside tab-indented
  code blocks.
- **1.3 — Post-list 2-blank-line reset**: same awk gains a `blank_run`
  counter; `prev_was_list` resets after 2 consecutive blank lines per
  CommonMark spec. Closes W-δ false-negative when a 4-space line after
  2 blanks is a real code block but was treated as list continuation.
- **1.4 — Spec/plan ordering convention**: `CLAUDE.md` Workflows &
  Conventions section gains a sub-section requiring spec writers to name
  the surrounding pattern when using positional language ("above X",
  "below Y"). v1.2.1 cycle-3 lesson applied.
- **1.5 — Implementation review prompt tweak**: `CLAUDE.md` Review cycle
  sub-section gains a memo about config/parser execution checks at Step
  6 (implementation review). Optional companion change in deep-review
  repo (`commands/deep-review.md`) appends the same guidance to the
  final code-reviewer prompt.
- **1.6 — README config syntax sweep**: `README.md` and `README.ko.md`
  now document all three accepted YAML forms for `auto_ingest`. Removed
  the v1.2.1 cycle-3 "block-form only / silently ignored" warning
  parenthetical (factually false post-Task-1).

### Tier 3 decisions (closed)

- **D — R3W2 missing-log design**: status quo retained. Prose-only
  `ingest-repair` (`pages_created:[]`) for log-truncation cases. No
  spec change. Will revisit if v1.3.0+ dogfood reveals frequent
  occurrence.
- **E — `cache_local` automation**: deferred to v1.4.0+ pending
  user-base data. Personal vault is Google Drive offline mode;
  cache_local benefit for that mode is ~0. Other-user prevalence is
  unobservable for a 1-user plugin.

### Backwards compatibility

- Single-source `/wiki-ingest` is byte-identical to v1.2.1 (fast path
  skips fanout entirely; lock still acquired in Phase 3 only — same as
  v1.2.1).
- Multi-source `/wiki-ingest` produces identical final wiki state when
  no cross-worker page collision occurs (the common case); second-pass
  synthesis preserves the same invariant when collisions DO occur. Only
  wall-clock changes.
- Existing `auto_ingest:` block-form configs continue to work unchanged.

### Trade-offs

- **Token cost increase (multi-source batches):** A4 fanout dispatches
  `min(3, sources)` `wiki-synthesizer` subagents in parallel. Each worker
  independently loads the synthesizer spec + wiki-schema (~3-5K tokens of
  context per worker). For 3-source batches, expect ~2-3× synthesizer-spec
  context cost vs the v1.2.1 single-synthesizer baseline. Wall-clock
  savings (~30-50% on LLM-dominant analysis) outweigh the token increase
  for most users; configurable `max_workers` knob deferred to v1.4.0+
  pending dogfood data.
- **Lock-held duration (multi-source only):** the global mkdir-based
  lock is now acquired in Phase 0 for the fanout branch (≥2 sources)
  and held through Phase 3 (atomic writes), versus v1.2.1 which acquired
  in Step 8. Lock held for the full LLM-analysis duration (~minutes for
  multi-source). Single-source path unchanged. Concurrent
  `/wiki-ingest` sessions are rare (single-user vault); contention will
  surface in dogfood if it matters.
- **Second-pass synthesis (cross-worker collision):** when ≥2 workers
  target the same proposed_file with non-byte-identical `page_content`,
  main dispatches one extra inline-mode synthesizer to merge the
  colliding drafts. Cost: 1 extra subagent invocation per same-page
  collision. Without this, multi-source merge invariant (v1.2.1
  semantics) would silently drop facts. Most multi-source batches have
  no collision.

### New lifecycle action

- **`ingest-fail`**: emitted to `log.jsonl` when the all-workers-fail
  retry counter (`<wiki>/.wiki-meta/.pending-scan-retry-count`,
  format `<window_epoch>:<count>`) reaches 3 consecutive batches on
  the same `.pending-scan` window. Promotes `.pending-scan → .last-scan`
  despite the failure (releases the stuck window) and records affected
  source paths + 3 prior failure timestamps. Counter resets on any
  successful (full or partial) batch — partial relies on
  `.failed-sources.tsv` for per-source retry.

### New storage-layout files

- **`<wiki>/.wiki-meta/.failed-sources.tsv`**: path-level retry manifest
  written when a partial worker failure occurs in multi-source ingest.
  TSV format `<source_path>\t<failure_reason>\t<ts>`. Hook reads this
  alongside `.pending-scan` on next iteration. Cleared on full success.
  Replaces the (incorrect) Plan #2 idea of writing paths into
  `.pending-scan` (which is timestamp-only).
- **`<wiki>/.wiki-meta/.pending-scan-retry-count`**: all-workers-fail
  counter for the 3-strike `ingest-fail` trigger. Format
  `<window_epoch>:<count>`. Cleared on success or 3-strike trigger.

## [1.2.1] — 2026-05-02

Patch release closing v1.2.0 review-cycle backlog. Fourteen issues across four axes: Step 1.5 hash-skip integrity hardening, wiki-lint false-positive elimination, per-source provenance preservation, and README cloud-mirror documentation accuracy. No behavior change on the happy path; every fix is either a stricter invariant check or a doc/parser correction.

### Hash-skip integrity (Step 1.5 hardening)

- **R3W1 — Slug collision disambiguation**: when two file sources share a basename (`/A/foo.md` and `/B/foo.md` both → slug `foo`), the new disambiguation step at end of Step 1 picks the next available `foo-N` whose origin matches (or fresh `foo-N` slot). Closes the silent cross-attribution risk on coincidental bytes-hash match.
- **R3W2 — Forced repair on missing log signal**: Step 1.5 now triggers `ingest-repair` when (a) `log.jsonl` is absent entirely, or (b) the slug has no terminal log entry (`last_action=''`) despite a present yaml. Both indicate state drift that demands re-ingest, not skip. **Caveat (W-α v1.2.1+):** when triggered by log absence/truncation, the resulting `ingest-repair` line emits `pages_created:[]` per spec — the historical creation record for those pages is gone and is not synthesized. wiki-lint Step 6 LOG-INVARIANT only flags duplicates so the wiki stays clean, but log-based audit reconstruction will be incomplete for log-truncated repairs. Per-source yaml (intact, verified by Checks 1+2) remains the authoritative provenance record. To preserve full log-based traceability, restore log.jsonl from a backup before re-ingesting affected sources.
- **RW3 — Inline-list yaml parser**: Check 1 awk now accepts `pages_created: [a.md, b.md]` in addition to the block-list form. Defense-in-depth against future Step 8e variants.
- **RW4 — Single-quote yaml strip**: both Check 1 and Check 2 now use the same `gsub(/^["\x27]+|["\x27]+$/, "", v)` pattern as v1.2.0 IW1's wiki-lint fix.
- **RW7 — Explicit array init**: `SKIPPED=()` and `REPAIR=()` are explicitly initialized at the top of the Step 1.5 scan loop for `set -u` cleanliness.

### Wiki-lint false-positive elimination

- **T10 — http(s):// targets excluded from broken-link check**: external URLs ending in `.md` (e.g., GitHub gist raw URL) no longer emit `[BROKEN]`. Closes 5 false positives observed in v1.2.0 dogfood.
- **W7 — Block-context-aware 4-space code-block strip**: `strip_code_blocks()` now distinguishes real CommonMark indented code blocks (4-space after a blank line, not under a list item) from list continuations and paragraph lazy continuations. Real code is stripped (multi-line via `in_indented_code` state, CR-C v1.2.1+); continuations are preserved so links inside list items stay subject to broken-link detection. Tab-indented code and post-2-blank-line code remain documented limitations (v1.3.0+ candidates).

### Per-source provenance

- **B5 — Same-batch co-create attribution preserved**: when two sources independently produce the same page in one batch, both contributing slugs' yamls now record the page under `pages_created` (per-source truth). Step 10's log emission still applies the intra-batch dedup so the log invariant (each filename in `pages_created` at most once across log lines) holds. Length-guarded snapshot init (CR-B v1.2.1+) replaces the broken `("${ARR[@]:-}")` pattern that produces 1-element-empty-string under bash 3.2.57. Step 10 prose updated to reference post-dedup arrays explicitly (CR-D v1.2.1+). Closes the v1.2.0 W6 trade-off.

### Documentation accuracy

- **R3W3 — Cloud-mirror VAULT_ROOT note**: README A5 now warns that moving `wiki_root` to a non-vault local path makes the SessionStart hook watch `$HOME` (since `VAULT_ROOT=$(dirname "$WIKI_ROOT")`). Recommends hook disable or `ignore_globs: ['**']` in this mode. A `vault_root:` config knob is tracked for v1.3.0+.
- **R3W4 — auto_ingest pause guidance corrected**: removing the `auto_ingest:` block does NOT pause auto-ingest (it returns to v1.1.x whole-vault default — *more* aggressive). Corrected to: set `ignore_globs: ['**']` or disable the SessionStart hook.

### Spec polish

- **RW2 — Step 10 SKIPPED/REPAIR drain note**: explicit forward-pointer in Step 10 prose so the implicit Step 1.5 → Step 10 drain is visible without chasing the blockquote.
- **RW5 — Hook 50-line frontmatter guard reorder + line-1 opening guard**: the `^---$` rule now precedes the line counter so a closing `---` past line 50 (Templater plugin) is honored. Line-counter early-exit narrowed to fire only when frontmatter has not started; hard 200-line absolute cap added. Opening `---` restricted to line 1 so a body horizontal rule past line 50 cannot leak into frontmatter mode (CR-E v1.2.1+).
- **RW6 — Synthesizer message-boundary count covers Phase 1c**: "four message boundaries" → "four to six" with breakdown for whether Phase 1c fires and escalates.

### Backfill

- v1.2.0 CHANGELOG A3 bullet now carries the measured ~20% per-page reduction observed in 2026-04-30 dogfood.

### Files changed

- `commands/wiki-ingest.md` — Step 1 disambiguation, Step 1.5 hardening (R3W1+R3W2+RW3+RW4+RW7), Step 8c.1 + 8e (B5), Step 10 (RW2+CR-D)
- `commands/wiki-lint.md` — Step 4 (T10, W7+CR-C)
- `hooks/scripts/scan-vault-changes.sh` — `auto_ingest_passes()` (RW5+CR-E)
- `agents/wiki-synthesizer.md` — message-boundary count (RW6)
- `README.md`, `README.ko.md` — A5 (R3W3+R3W4)
- `.claude-plugin/plugin.json` — version bump
- `CLAUDE.md` — v1.2.1 entry under "Recent releases" + ingest-repair lifecycle action note (C2-Y v1.2.1+)

## [1.2.0] — 2026-04-30

### Performance

- **SessionStart auto-ingest scope filter** — `~/.claude/deep-wiki-config.yaml` now accepts an optional `auto_ingest:` block with `ignore_globs` (path glob exclusions) and `require_tag` (frontmatter-tag opt-in). The SessionStart hook applies these filters before /wiki-ingest is invoked, reducing call frequency for high-volume low-value paths (Daily notes, archive folders). Backwards compatible — block is optional, default behavior unchanged. (A1)
- **Re-ingest hash skip** — `/wiki-ingest` Step 1.5 now compares each `file`/`deep-work-report` source's sha256 against the existing `.wiki-meta/sources/<slug>.yaml:content_hash`. Matching sources are dropped from the batch before lock acquisition; an entirely-skipped batch still acquires the lock briefly to append a per-slug `ingest-skip` log entry and run the `.pending-scan → .last-scan` promotion before exit. New `ingest-skip` log action records skipped slugs for audit (canonical schema preserved: `{ts, action, source, pages_created:[], pages_updated:[], skip_reason}`). Slug derivation moved from Step 5 to end of Step 1 so Step 1.5 can locate the existing yaml. **Hash match alone is insufficient (IC1 review fix):** Step 1.5 also verifies wiki-side state integrity (every page in `pages_created`∪`pages_updated` exists; each page's frontmatter `sources:` lists the slug; the most-recent log entry for the slug is a clean terminal action). Any failure forces fall-through to normal ingest as self-repair, recorded as new `ingest-repair` log action. The `ingest-repair` line emits `pages_created:[]` and routes all touched pages to `pages_updated` so the wiki-lint Step 6 LOG-INVARIANT (each filename appears in `pages_created` exactly once across history) is preserved (R3C1 review fix); `wiki-lint` Step 6 also adds `select(.action != "ingest-repair")` defense-in-depth. (A2)
- **A3 — Skim-first candidate filtering**: synthesizer Phase 1 now scores candidates against frontmatter only, deep-reads the top K (typically 3, up to 5 when score distribution is flat), and verifies skim-skipped candidates with a parallel Grep batch (Phase 1c, IW1 fix). Per-call wall-clock projected to drop ~15-25% (projection from v1.1.4 follow-up; **measured ~20% per-page reduction in v1.2.0 first dogfood (2026-04-30)** — 1.7 min/page in v1.2.0 8-page cloud-vault dogfood vs v1.1.3 ~2.14 min/page baseline (2-page update, smaller sample), source vault on Google Drive offline mode. Sample sizes differ — directional only, not strictly like-for-like).
- **Cloud-storage mirror-and-sync workflow guide** — README (EN/KO) now documents a 3-step manual workflow for users on iCloud/Google Drive/Dropbox vaults: keep `wiki_root` on local disk, additive rsync (NO `--delete`) to vault on a schedule, manual reverse-rsync first when editing on other devices (no automated conflict detection). Automated `cache_local` config option deferred to v1.3.0+. (A5)

### Lint Hardening

- **`[SCAN-WINDOW]` invariant check + `--fix` auto-cleanup** — `/wiki-lint` gains Step 11 detecting three pathological states of `.pending-scan`/`.last-scan` (invalid TS regex, `PENDING < LAST` regression risk, stalled auto-ingest with `LAST > 48h`). `--fix` drops stale and invalid `.pending-scan` automatically; the >48h informational warning requires manual judgment. Includes tri-branch date parsing (gdate / Darwin / Linux) for portable epoch comparison. Implements the v1.1.4 follow-up doc's deferred recommendation. (B1+B2)
- **`[ORPHAN]` classification** — `/wiki-lint` Step 3 now exempts pages with frontmatter `tags: [leaf]` and pages matching `~/.claude/deep-wiki-config.yaml:lint.orphan_ignore` globs. Reduces noise on wikis with intentional archive/milestone leaves. (B3)
- **`[BROKEN]` code-block exclusion** — `/wiki-lint` Step 4 now strips **fenced** code blocks (```...```) before grep'ing for `[text](target.md)` patterns, eliminating false positives from documentation pages that mention `.md` filenames inside code samples. **4-space-indented blocks are intentionally NOT stripped** (NW3 review note): CommonMark treats 4-space inside lists as item-continuation, and unconditional stripping would silently swallow valid links like `- top\n    - nested with [link](other.md)`. (B4)
- **`pages_created` same-batch dedup guard** — `/wiki-ingest` Step 8c now reclassifies within-batch duplicates (the same `file` produced by two sources in one batch) so only the first is `created` and the rest are `updated`, restoring the "exactly once across log" invariant for v1.2.0+ ingests. Past log entries are unmodified (append-only). bash 3.2 compatible: uses newline-delimited string + `grep -Fxq` (NOT `declare -A`). (B5)

### Wiki Data Cleanup (one-off)

- **Broken-link findings (5)** — All 5 lint-flagged broken links analyzed; ALL turned out to be false positives — external URLs whose path ends in `.md` (e.g. `https://github.com/.../ARCHITECTURE.md`, `https://code.claude.com/docs/en/hooks.md`). Vault unchanged. **Note:** wiki-lint Step 4 URL exclusion (skip `http(s)://...` targets) is a v1.3.0+ candidate to eliminate this false-positive class structurally.
- **Version backup chains (4 pages pruned)** — `cross-model-3way-review-synthesis`, `deep-suite-marketplace`, `plan-review-as-integration-test`, `quant-monitor-watcher` reduced to retention limit (last 3 versions per page) by manual prune. Backup tarball saved before prune as safety net.
- **Orphan classification (36 pages)** — Deferred to user. v1.2.0's B3 tooling (`leaf` tag + `lint.orphan_ignore` config) ships ready; user can run a one-off pass with the appropriate globs/tags to clear the orphan list at their pace.
- **Historical `pages_created` violations (28)** — Remain in `log.jsonl` (append-only). B5 closes the future-recurrence path; v1.2.0+ ingests will not produce new ones.

### Preserved (functional parity)

- Agent input/output contract — `candidates` shape changed from `[filename]` to `[{file,title,tags,aliases}]` (caller and agent both updated; no third-party consumers of this contract)
- Lock protocol, version backup, source provenance schema — unchanged
- Pre-v1.2.0 wikis: `auto_ingest:` and `lint.orphan_ignore:` blocks are optional; absence yields v1.1.x behavior

### Migration

No action required. Existing wikis continue to work. To opt into v1.2.0 perf gains:

1. Add `auto_ingest:` block to `~/.claude/deep-wiki-config.yaml` with high-volume paths in `ignore_globs`.
2. Run `/wiki-lint --fix` once to clear stale `.pending-scan` files and prune excess version backups.
3. (Optional) Migrate `wiki_root` to local disk per the README cloud-storage section.
4. (Optional) Add `lint.orphan_ignore` globs and/or `tags: [leaf]` to intentional-orphan pages to clean up the `[ORPHAN]` lint report.

## [1.1.4] — 2026-04-24

### Fixed

- **`content_hash` no longer silently stores agent sentinels** (D1 from the v1.1.3 follow-up doc) — v1.1.2 moved sha256 computation into `wiki-synthesizer`, but the agent's tool scope (`Read, Write, Glob, Grep, WebFetch`) provides no hashing capability, so every manifest had been returning a placeholder string that the caller wrote verbatim to `sources/<slug>.yaml:content_hash`. Re-ingest detection and provenance auditing have therefore been unreliable since v1.1.2. `/wiki-ingest` now has an explicit Step 8d "Normalize `source_hashes`" that validates each manifest value against `^[0-9a-f]{64}$` (case-insensitive); non-hex values are recomputed from the source's `origin` (`shasum -a 256` for files and inbox text, `curl | shasum` for URLs) before Step 8e writes the provenance yaml. `wiki-synthesizer.md` is updated to document the sentinel convention (`"main-computes"`) and to explicitly mark non-hex values as non-fatal for the caller. Authoritative agent digests still pass through unchanged, so a future agent with a `shasum`-capable tool scope keeps full v1.1.2 semantics.
- **`.pending-scan → .last-scan` promotion no longer regresses `.last-scan` when a stale pending file is left behind** (D2 from the v1.1.3 follow-up doc) — if a prior interrupted session left `.pending-scan` older than the current `.last-scan`, the v1.1.1-shipped promotion block would execute `mv PENDING LAST`, moving `.last-scan` *backward*. The next hook would then re-detect every file since the stale pending timestamp, producing duplicate `log.jsonl` entries. The promotion block now reads `.last-scan` before advancing and skips the advance whenever `CURRENT_LAST > BATCH_PENDING` (lexicographic compare, which matches numeric order for fixed-width UTC ISO 8601 `Z`-suffix timestamps); `.pending-scan` is dropped in the same block once its window is covered by `.last-scan`. Concurrent-hook semantics (case where `.pending-scan` was overwritten with a newer timestamp mid-batch) are unchanged from prior releases.

### Preserved (functional parity)

- Agent input/output contract — unchanged (sentinel was already the observed behavior; the contract now documents it honestly)
- v1.1.3 parallel tool dispatch guidance in `wiki-synthesizer.md` — unchanged
- `.pending-scan` promotion under normal (non-stale) hook/ingest interleaving — unchanged; the regression guard is strictly defensive
- Manual (non-hook) ingest path — unchanged; `BATCH_PENDING=""` is still a no-op for the promotion block
- Lock protocol, version backup, auto-lint, per-source yaml schema, `log.jsonl` schema — all unchanged

### Migration

No action required. Existing `sources/<slug>.yaml` files with placeholder `content_hash` values are left as-is (they are historical records); any re-ingest of the same source will produce a valid sha256 digest going forward. Existing `.pending-scan` files are handled by the new promotion logic on the next ingest.

## [1.1.3] — 2026-04-24

### Performance

- **`wiki-synthesizer` now dispatches tool calls in parallel within each phase** — Previous versions composed the agent's workflow without explicit concurrency guidance, so Claude naturally emitted one tool call per message (read source, then read candidate A, then read candidate B, …). For typical 5-10 page ingests this produced ~3N sequential round-trips and dominated wall-clock time beyond the unavoidable LLM inference cost. `agents/wiki-synthesizer.md` now carries a "Performance guidance — parallel tool dispatch" section that partitions the workflow into four phases (source read / candidate survey / backup batch / page write) and requires every tool call within a phase to be issued in a single batched message. The data-dependency order between phases is unchanged; only the intra-phase fan-out is new. This is a pure prompt change — no runtime, tool contract, input/output schema, or lock/provenance behavior is modified.
- **Cloud-synced `wiki_root` documented as a latency tax** — README (EN/KO) now notes that placing the wiki on iCloud Drive, Google Drive, Dropbox, or similar sync-daemon-backed paths adds hundreds of ms per `Write` because each page write wakes the sync daemon. Recommendation: keep `wiki_root` on local disk and rely on the sync client's native file sync for propagation. This is environmental, outside the plugin's control, and the README explicitly scopes it as user infrastructure.

### Preserved (functional parity)

- Agent input/output contract (`{wiki_root, sources, candidates}` → `{created, updated, versioned, source_hashes, failed}`) — unchanged
- All correctness rules: grounded content, page template, kebab-case filenames, merge-don't-duplicate, conflict notation, version-before-overwrite, write scope — unchanged
- Rule 5 widening (`Glob`/`Grep` search beyond `candidates`) is still mandatory — the parallel guidance explicitly notes that correctness dominates performance and must not be relaxed
- Lock / `.pending-scan → .last-scan` promotion / auto-lint / index.json schema — unchanged

### Migration

No action required. Plugin consumers do not need to update their wikis or configs. The only observable change is faster ingest for sessions that write or update ≥3 pages (the more pages, the more linear-dispatch waste is eliminated).

## [1.1.2] — 2026-04-21

### Changed

- **`/wiki-ingest` always delegates page I/O to `wiki-synthesizer` subagent (sonnet)** — Previously the subagent was only invoked for multi-source batches or when `--synthesize` was passed; everything else happened inline in the main session, which pulled source content and existing page bodies into the main context window. Now every ingest (single-source, multi-source, URL, file, deep-work report, manual, or auto-ingest) dispatches to `wiki-synthesizer` at Step 7. Main session keeps only the small metadata footprint (`index.json`, `log.jsonl`, `sources/*.yaml`, lock, auto-lint). This materially reduces context pressure for SessionStart hook auto-ingests where multiple Obsidian vault files land together.
- **Version backup moved from main command to `wiki-synthesizer`** — Pre-overwrite snapshot copies to `.wiki-meta/.versions/<name>.v<N>.md` are now written by the agent as part of the same pass that decides create-vs-update, keeping the "write + backup" responsibility in a single context. Retention (last-3 pruning) stays in main via auto-lint — unchanged.
- **Agent input/output contract is now formal (structured)** — `wiki-synthesizer` accepts `{wiki_root, sources: [{slug, origin, type}], candidates}` and returns a structured manifest: `created` and `updated` entries carry `{file, title, tags, aliases, sources}`, plus `versioned`, `source_hashes` (per-slug sha256), and `failed` (may include `orphan_version`). The caller cross-references against a pre-batch `ls pages/` snapshot, reconciles each reported write against actual filesystem state, validates filenames against `^[a-z0-9][a-z0-9-]*\.md$`, and is authoritative for `pages_created` vs `pages_updated` classification.
- **`index.json` updates use manifest frontmatter directly** — Since main no longer writes pages, the agent's `created`/`updated` entries include the exact `title`/`tags`/`aliases` written to each page's frontmatter. Main uses these values verbatim to update `index.json` without re-reading page bodies, keeping the index always in sync with what the agent actually wrote.
- **Per-source provenance in multi-source batches** — Each source in a batch gets its own `.wiki-meta/sources/<slug>.yaml` and its own `log.jsonl` line. The agent's per-entry `sources` list drives the per-slug filtering, so a page only appears under a given slug's `pages_created`/`pages_updated` if that slug actually contributed to it. `wiki-lint`'s source-provenance invariant (every page's frontmatter `sources:` slug has a matching `.wiki-meta/sources/<slug>.yaml` with that page in `pages_*`) continues to hold for multi-source batches.
- **`content_hash` computed by agent at fetch/read time** — Previously main would re-`curl` URLs or re-`shasum` files after the agent had already read them, risking hash drift (dynamic content, cookies, UA differences) and doubling network/disk cost. Now the agent computes sha256 as it ingests each source and returns the map in `source_hashes`; main writes these values verbatim to `sources/<slug>.yaml`. The hash is guaranteed to reflect exactly the bytes that were ingested.
- **`--synthesize` flag demoted to a hint** — Accepted for backward compatibility but no longer gates any branching logic; synthesis behavior is now the default for any batch the agent receives.
- **Agent tool scope** — `wiki-synthesizer` gains `WebFetch` (for `type: url` sources it now reads directly) in addition to `Read`/`Write`/`Glob`/`Grep`. Write access remains constrained to `<wiki_root>/pages/` and `<wiki_root>/.wiki-meta/.versions/`.
- **Pasted-text ingest path made uniform** — For `type: text`, `/wiki-ingest` materializes the pasted text to `<wiki_root>/.wiki-meta/.inbox/<slug>.txt` before dispatch so the agent reads it like any other file. The inbox file is deleted in the same trap that releases the lock (success or failure).
- **Overlap detection strengthened against pre-filter misses** — The `candidates` list passed to the agent is now explicitly a hint, not an exhaustive set. `wiki-synthesizer` Rule 5 requires the agent to widen its search via `Glob "<wiki_root>/pages/*.md"` + `Grep` when a topic name it would assign could plausibly overlap pages outside the candidate list. This preserves the "merge, don't duplicate" invariant even when filename/URL-based pre-filtering misses semantic overlaps.
- **Post-write reconciliation added** — After the agent returns, main verifies each `file` in `created`/`updated` actually exists on disk (`test -f`). Missing files are moved to `failed` with reason `"agent reported written but file not present"`, catching agent crashes or manifest lies before metadata gets corrupted.

### Preserved (functional parity)

- Lock (`.wiki-meta/.wiki-lock` mkdir/rmdir atomicity) — unchanged
- `.pending-scan → .last-scan` promotion with `BATCH_PENDING` race guard + `TS_RE` size guard + promotion-before-rmdir ordering — unchanged
- Partial / full failure semantics — no `.pending-scan` promotion on any failure; next session's hook re-detects the window
- `index.json` / `log.jsonl` / `sources/*.yaml` on-disk schemas — unchanged. Data quality for multi-source batches is now **stronger** than before (per-source attribution is now authoritative instead of inferred).
- `.wiki-meta/.versions/` last-3 retention — still handled by main's auto-lint auto-fix
- Auto-lint (schema compliance, broken links, index drift, orphan detection) — unchanged
- UTC ISO 8601 `Z` timestamp requirement — unchanged

### Migration

No action required. Existing wikis continue to work; the only observable change is that main session context usage drops during ingest, and multi-source batches now produce correct per-source provenance (v1.1.1 had a latent ambiguity there that was never tripped because `--synthesize` was rarely used). `--synthesize` flag invocations continue to work unchanged (scheduled for removal in 1.2.0).

## [1.1.1] — 2026-04-17

### Security

- **Prevent accidental commit of local permission overrides** — `.gitignore` now covers `.claude/settings.local.json` and `.claude/.sensor-detection-cache.json`. These files can grant repo-scoped filesystem/exec permissions that should not propagate to other contributors. (R3, from Codex adversarial review)
- **Scrub destructive `git rm --cached -r . && git reset --hard` guidance** from upgrade docs. Replaced with a safe `git add --renormalize` flow that requires a clean working tree and warns against the destructive alternative. (R2)

### Fixed

- **SessionStart hook crashes on macOS bash 3.2** — Wrapped every `"${ARR[@]}"` iteration with `${#ARR[@]}` guards so the default macOS shell does not abort with `unbound variable` when `NEW_FILES` is empty during the recents-merge step. (C1)
- **File-loss risk on skipped auto-ingest** — Hook now writes the detected-at timestamp atomically to `.wiki-meta/.pending-scan` (via `mktemp` + `mv`). `wiki-ingest` promotes pending → committed only after a successful batch, and the promotion captures the pending timestamp at batch start so concurrent hook runs cannot advance `.last-scan` past what was actually ingested. (H1, plus race / atomicity hardening)
- **`wiki_prefix: "."` edge case** — When the wiki lives at the vault root, the hook now explicitly excludes `pages/`, `.wiki-meta/`, `index.md`, `log.md`, and `log.jsonl` from the scan so the wiki cannot ingest itself. (H3)
- **YAML config parsing** — `wiki_root`, `obsidian_cli.available`, and `wiki_prefix` are now parsed with an awk state machine that respects YAML block boundaries, so a neighbouring `available: true` under a different top-level key can no longer be mis-attributed to `obsidian_cli`. Inline comments and quotes are stripped. (H2)
- **Log timestamp consistency** — All commands now require UTC ISO 8601 with a `Z` suffix (`date -u +"%Y-%m-%dT%H:%M:%SZ"`). `wiki-schema.yaml` documents `ts_format` explicitly. Historical entries with `+09:00` offsets remain readable. (M1)
- **`pages_created` duplication** — Classification rule added: a filename appears in `pages_created` only if the file did not exist at the start of the ingest; otherwise it belongs in `pages_updated`. Each page has at most one `pages_created` entry across the log. `wiki-lint` gained a `[LOG-INVARIANT]` check that reports duplicates. (M4)

### Windows Compatibility

- **CRLF line endings** — Added `.gitattributes` enforcing LF on all shell/YAML/JSON/Markdown so Windows clones (default `core.autocrlf=true`) no longer produce broken shell scripts. README + CHANGELOG document a safe re-normalization procedure for pre-1.1.1 clones. (W-C1)
- **`timeout.exe` conflict** — Hook now detects `/windows/system32/timeout[.exe]$` (path-boundary anchored regex) and skips it; a legitimate GNU `timeout` installed under an unrelated path containing the word "windows" is no longer falsely skipped. Falls back to `gtimeout` or no timeout rather than silently breaking `obsidian recents`. (W-H1)
- **Shell dependency documented** — README + README.ko list Windows as Experimental and require Git Bash or WSL2. The plugin does not support native `cmd.exe`/PowerShell for the SessionStart hook. (W-H2, W-M1, partial — see Known Limitations)
- **Windows-native `wiki_root` rejected** — Paths like `C:\Users\...` or `C:/Users/...` produce a friendly error pointing to POSIX form (`/c/Users/...` or `/mnt/c/Users/...`). (W-H3)
- **Obsidian CLI on Windows** — `wiki-setup` gained a note on adding `%LOCALAPPDATA%\Programs\Obsidian\` to PATH. (W-M2)
- **Google Drive + locale guidance** — README documents Google Drive mount conventions on Git Bash and recommends offline-mirror mode to avoid placeholder-file mtime quirks. (W-M3)
- **NTFS case-insensitivity + long-path guidance** — README Windows Setup notes that kebab-case naming (enforced by the schema) prevents NTFS case-conflict issues, and documents Windows 10 1607+ long-path support for deep `.wiki-meta/.versions/` paths. (W-L1, W-L2)

### Changed

- **Hook heredoc tag** renamed from `EOJSON` to `EOMSG` for clarity (output is plain text systemMessage, not JSON). (L1)
- **Hook command timeout unit** is now documented in the script header comment block (15 seconds) rather than in the user-visible `hooks.json` `description`. (L4)
- **`case` patterns** in the hook now quote `"${WIKI_PREFIX}"` to guard against future values containing whitespace. (L2)
- **Post-upgrade note** added: users upgrading from 1.0.x/1.1.0 should re-run `/wiki-setup` to pick up Obsidian CLI auto-detection. (M3 — partial, see Known Limitations)

### Known Limitations (partially addressed; remaining work tracked for 1.2.0)

- **M2 CLI timeout fallback**: Windows `timeout.exe` is now skipped, but this release does not add `perl -e 'alarm N'` as a generic POSIX fallback. macOS users without coreutils installed still run `obsidian recents` unbounded.
- **M3 runtime re-setup nudge**: README documents the re-setup requirement, but individual commands do not yet print a one-shot "CLI detected but not in config — please run /wiki-setup" notice.
- **W-H2 shell gating**: README marks Windows as Experimental, but the hook does not yet emit a dedicated error when `bash` is missing from PATH, and a PowerShell port of the hook is not shipped.
- **Historical log migration**: Past `log.jsonl` entries with `+09:00` offsets are left intact. A migration script to normalize them to UTC is not part of this release.
- **wiki_prefix='.' end-to-end**: Hook's recents-filter correctly excludes wiki artifacts in the vault-root mode (added in 1.1.1), but the `find` path still derives `VAULT_ROOT = dirname(WIKI_ROOT)` which is `wiki_root`'s parent. Full end-to-end `wiki_prefix='.'` support requires a follow-up fix that distinguishes vault-root vs nested wiki at the `find` stage.

### Notes

All changes are backward compatible. `.pending-scan` is additive; existing wikis continue to work with their current `.last-scan` file. Log entries with mixed timezone formats remain readable — only new entries are required to use UTC.

## [1.1.0] — 2026-04-08

### Added

- **Obsidian CLI integration** — `/wiki-setup` now auto-detects the Obsidian CLI (`obsidian`) when the wiki is inside an Obsidian vault. When detected, wiki commands use Obsidian's full-text search, backlink graph, orphan detection, and unresolved link tracking for more accurate results.
- **Enhanced search in `/wiki-ingest` and `/wiki-query`** — When Obsidian CLI is available, overlap detection and content search use `obsidian search:context` instead of Grep, leveraging Obsidian's text index.
- **Graph-based query expansion** — `/wiki-query` adds a Layer 2.5 that follows backlinks to discover related pages beyond keyword matching (Obsidian CLI only).
- **Improved lint checks** — `/wiki-lint`, `/wiki-ingest` auto-lint, and `/wiki-rebuild` auto-lint use `obsidian orphans`, `obsidian unresolved`, and `obsidian backlinks` for more accurate structural health checks. All vault-wide results are post-filtered to the wiki boundary.
- **Hybrid SessionStart scan** — The auto-ingest hook supplements `find`-based scanning with `obsidian recents` (union + deduplicate). All candidates pass mtime verification to prevent ingesting unmodified files.
- **`obsidian` in recommended tools** — Added to `wiki-schema.yaml` CLI tools list.

### Changed

- **Config schema extended** — `~/.claude/deep-wiki-config.yaml` gains an optional `obsidian_cli` block with `available`, `vault_name`, `vault_path`, and `wiki_prefix` fields. Absence of this block means filesystem-only mode (fully backward compatible).
- **`/wiki-setup` re-run safety** — Re-running setup now removes stale `obsidian_cli` config blocks before re-detection, preventing stale config when CLI is uninstalled.
- **macOS compatibility** — SessionStart hook detects `timeout`/`gtimeout` availability instead of assuming GNU coreutils.

### Design Principles

- **Progressive enhancement** — Obsidian CLI enhances but never replaces filesystem operations. All commands fall back gracefully when the app is not running.
- **Wiki boundary filtering** — All vault-wide CLI results (`orphans`, `unresolved`, `tags`) are post-filtered to `wiki_prefix/pages/` to prevent unrelated vault notes from polluting reports.
- **Writes stay filesystem-based** — Page creation/modification, lock management, index/log updates all use Write/Edit tools for precise control.

## [1.0.1] — 2026-04-07

### Added

- **Auto-ingest SessionStart hook** — Automatically detects new/modified files in the Obsidian vault on every Claude Code session start and ingests them into the wiki. No manual action needed.
- **Batch ingest support** — `/wiki-ingest` now supports batch processing of multiple files from the auto-ingest hook, with single lock acquisition and grouped log entries.

## [1.0.0] — 2026-04-07

### Milestone

First stable release. All core features from Karpathy's LLM Wiki gist are implemented, and the plugin has been validated against a real Obsidian vault migration (700+ files → 107 wiki pages).

### Added (since 0.2.0)

- **Real-world validation** — Full vault migration of PARA-structured Obsidian vault (PROJECT, RESOURCE, AREA, ARCHIVE, DAILY notes) into deep-wiki, proving the system works at scale.

---

## [0.2.0] — 2026-04-07

### Added

- **Query auto-filing** — When `/wiki-query` synthesizes insights across 2+ pages, the result is automatically filed back into the wiki as a `query-synthesis` page. Implements Karpathy's principle that valuable query results should compound back into the knowledge base.
- **Auto-lint after write operations** — Lint checks run automatically after every `/wiki-ingest` and `/wiki-rebuild`. Auto-fixes structural issues (index drift, excess versions) silently; only reports issues requiring human judgment. Users no longer need to remember to lint.
- **Recommended tools check in `/wiki-setup`** — Setup now checks for CLI tools (qmd, marp) and Obsidian plugins (Dataview, Marp Slides, Web Clipper) and reports installation status with install commands.
- **`recommended-tools.md` reference document** — Detailed guide for qmd, Marp, Dataview, Marp Slides, and Obsidian Web Clipper.
- **`recommended_tools` and `auto_lint` schema definitions** in `wiki-schema.yaml`.
- **CHANGELOG.md / CHANGELOG.ko.md** — This file.

### Fixed

- **`wiki-lint.md` step numbering** — Steps 8, 8, 10, 10 corrected to 8, 9, 10, 11.

### Changed

- `/wiki-query` is no longer read-only. It now writes auto-filed synthesis pages when cross-page insights are detected.
- `/wiki-ingest` now includes an auto-lint step (Step 13) before the final report.
- `/wiki-rebuild` now includes an auto-lint step (Step 5) before reporting.
- `wiki-schema` skill updated with Auto-Lint and Query Auto-Filing sections.
- `wiki-schema.yaml` updated with `auto_lint`, `query_auto_filing`, and `log.actions` definitions.
- READMEs (EN/KO) updated with recommended tools section, Obsidian auto-check description, and revised command descriptions.

## [0.1.0] — 2026-04-06

### Added

- Initial release implementing Karpathy's LLM Wiki philosophy.
- Five commands: `/wiki-setup`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`.
- `wiki-synthesizer` agent for multi-source synthesis.
- `wiki-schema` skill with page template, schema YAML, and storage layout reference.
- Source provenance tracking with content hashing.
- Concurrency locking protocol (`mkdir`-based).
- Page versioning (keep last 3).
- Dual artifacts: human-readable (`index.md`, `log.md`) + machine-readable (`index.json`, `log.jsonl`).
- Obsidian vault compatibility.
- deep-work session report integration.
- Test wiki with example pages.
- Bilingual documentation (EN/KO).
