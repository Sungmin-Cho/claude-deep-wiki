#!/bin/bash
# v0-record.sh — Bash 3.2 portable TSV-append helper for V-0 probe results.
#
# Plan reference: docs/superpowers/plans/2026-05-05-wiki-synthesizer-agent-split.md
# §3.3 + §11 step 1 + §11.5 L1.
#
# Bash 3.2 portability per CLAUDE.md "Workflows & Conventions / Bash 3.2
# portability (필수)":
#   - no `mapfile` / `readarray`
#   - no `declare -A`
#   - no `${var,,}` / `${var^^}`
#   - no `&>/dev/null` (use `>/dev/null 2>&1`)
#   - `${arr[@]}` length-guarded under `set -u`
#
# Usage:
#   scripts/v0-probe/v0-record.sh \
#     --agent wiki-page-writer \
#     --mechanism B \
#     --verdict PASS \
#     --raw-output 'v0_probe=no-tools-available' \
#     --notes 'first attempt'
#
# Output: one TSV row appended to scripts/v0-probe/results.tsv.
# Columns (tab-separated):
#   1. ts                   ISO 8601 UTC, YYYY-MM-DDTHH:MM:SSZ (per CLAUDE.md)
#   2. agent                e.g. wiki-page-writer | wiki-synthesizer-analysis | wiki-synthesizer-worker
#   3. mechanism            A | B | C
#   4. verdict              PASS | FAIL | UNDETERMINED
#   5. raw_output           verbatim probe output (newlines/tabs collapsed to spaces)
#   6. notes                free-form annotation
#
# Newline-delimited TSV avoids associative arrays per the v1.3.0 polish 1.1
# precedent (CLAUDE.md "Bash 3.2 portability" — newline-delimited string +
# `grep -Fxq` or TSV temp file pattern).

set -eu

# ---- defaults ------------------------------------------------------------
AGENT=""
MECHANISM=""
VERDICT=""
RAW=""
NOTES=""

# ---- argv parsing (length-guarded; no associative arrays) ---------------
while [ $# -gt 0 ]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"; shift 2 ;;
    --mechanism)
      MECHANISM="${2:-}"; shift 2 ;;
    --verdict)
      VERDICT="${2:-}"; shift 2 ;;
    --raw-output)
      RAW="${2:-}"; shift 2 ;;
    --notes)
      NOTES="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,/^# ----/p' "$0" | sed 's/^# //; s/^#//' | head -40
      exit 0
      ;;
    *)
      echo "v0-record.sh: unknown flag: $1" >&2
      exit 64
      ;;
  esac
done

# ---- validate -----------------------------------------------------------
if [ -z "$AGENT" ] || [ -z "$MECHANISM" ] || [ -z "$VERDICT" ]; then
  echo "v0-record.sh: --agent, --mechanism, --verdict are required" >&2
  echo "  see scripts/v0-probe/v0-procedure.md §5 for usage" >&2
  exit 64
fi

case "$MECHANISM" in
  A|B|C) ;;
  *) echo "v0-record.sh: --mechanism must be A | B | C (got '$MECHANISM')" >&2; exit 65 ;;
esac

case "$VERDICT" in
  PASS|FAIL|UNDETERMINED) ;;
  *) echo "v0-record.sh: --verdict must be PASS | FAIL | UNDETERMINED (got '$VERDICT')" >&2; exit 65 ;;
esac

# ---- locate output file (sibling of this script) ------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TSV="$SCRIPT_DIR/results.tsv"

# ---- collapse tabs+newlines in raw fields to keep TSV well-formed -------
# tr is a POSIX-portable choice; avoids ${var//pattern/replacement} which is
# bash-specific (works in 3.2 but we keep this style consistent with the
# rest of deep-wiki's hook scripts).
RAW_CLEAN=$(printf '%s' "$RAW" | tr '\t\n\r' '   ')
NOTES_CLEAN=$(printf '%s' "$NOTES" | tr '\t\n\r' '   ')

# ---- timestamp (UTC ISO 8601, per CLAUDE.md mandate) --------------------
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ---- create header on first write ---------------------------------------
if [ ! -f "$TSV" ]; then
  printf 'ts\tagent\tmechanism\tverdict\traw_output\tnotes\n' > "$TSV"
fi

# ---- append row (atomic for line-sized writes on local POSIX FS) --------
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$TS" "$AGENT" "$MECHANISM" "$VERDICT" "$RAW_CLEAN" "$NOTES_CLEAN" \
  >> "$TSV"

echo "v0-record.sh: appended $VERDICT row for $AGENT (mechanism $MECHANISM) to $TSV"
