#!/bin/bash
# scripts/lint-agent-tools.sh — frontmatter lint check for deep-wiki plugin agents
# (per plan §3.8 + §4 file 5b — v1.4.1 Track C, post-Q6 author resolution)
#
# Verifies that each plugin agent file's `tools:` frontmatter declaration matches
# the expected static manifest. Failure mode: any drift in `tools:` declaration
# (reordering, additions, removals) WITHOUT corresponding manifest update fails
# the lint. This is the static defense complementary to runtime V-0/V-1/V-2/V-3
# probes per plan §3.3.
#
# Also verifies (per cycle-2 N4 + cycle-3 N4.1): the WebFetch URL allowlist Rule
# appears in wiki-synthesizer-analysis.md + wiki-synthesizer-worker.md (string
# match acceptable; runtime enforcement comes from V-2/V-3 stub-server probe).
# wiki-synthesizer-inline.md is also checked for cross-file sync discipline
# (rule already present after Task 4 normalization sweep).
#
# Invocation:
#   - Manual: ./scripts/lint-agent-tools.sh [--verbose]
#   - Pre-commit hook: add to .git/hooks/pre-commit (deep-wiki repo only)
#   - GitHub Actions CI: invoke from a workflow step
# NOT integrated into /wiki-lint (user-facing wiki-health command); NOT under
# hooks/ (user-vault-runtime hooks). This is plugin-author developer tooling.
#
# Bash 3.2 portable per CLAUDE.md "Bash 3.2 portability (필수)":
#   - No `declare -A` (uses TSV here-doc)
#   - No `mapfile` / `readarray`
#   - No `${var,,}` / `${var^^}` case modification
#   - No `&>/dev/null` (uses `>/dev/null 2>&1`)
#   - `${arr[@]}` length-guarded under `set -u`

set -euo pipefail

VERBOSE=0
if [ "${1:-}" = "--verbose" ]; then
  VERBOSE=1
fi

# Resolve repo root from script path (script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

# ---------------------------------------------------------------------------
# Manifest: TSV here-doc piped to a temp file (Bash 3.2 — no associative array).
# Format: <agent_file_path>\t<expected_normalized_tools_array>
# Normalized form: bracketed, comma+single-space separated, no extra whitespace.
# ---------------------------------------------------------------------------
MANIFEST_FILE="$(mktemp -t lint-agent-tools.XXXXXX)" || {
  echo "FATAL: mktemp failed — cannot create manifest temp file (TMPDIR=${TMPDIR:-/tmp})" >&2
  exit 2
}
trap 'rm -f "$MANIFEST_FILE"' EXIT

# Explicit verify the manifest write succeeded — set -e + pipefail catches most
# cases, but here-doc redirection failures can still slip through if disk is
# full mid-write.
if ! cat > "$MANIFEST_FILE" <<'EOF'
agents/wiki-synthesizer-inline.md	[Read, Write, Glob, Grep, WebFetch]
agents/wiki-synthesizer-analysis.md	[Read, Glob, Grep, WebFetch]
agents/wiki-synthesizer-worker.md	[Read, Glob, Grep, WebFetch]
agents/wiki-page-writer.md	[]
EOF
then
  echo "FATAL: manifest write failed — cannot populate $MANIFEST_FILE" >&2
  exit 2
fi

# Sanity: the manifest must be non-empty after write.
if [ ! -s "$MANIFEST_FILE" ]; then
  echo "FATAL: manifest file is empty after write — TMPDIR full or unwritable?" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helper: extract `tools:` value from a file's YAML frontmatter.
# Supports two forms:
#   (1) Inline-array:  tools: [Read, Glob, Grep, WebFetch]
#   (2) Block-list:    tools:
#                        - Read
#                        - Glob
# Output: a normalized bracketed string, e.g. "[Read, Glob, Grep, WebFetch]"
# Empty list normalizes to "[]".
# ---------------------------------------------------------------------------
extract_tools() {
  file="$1"

  # Frontmatter sits between the first two `---` lines. Extract that block.
  # awk-based: turn on `in_fm` after the first `---`, off (and exit) after the
  # second `---`. Print everything in between.
  fm="$(awk '
    /^---[[:space:]]*$/ {
      if (in_fm == 1) { exit }
      in_fm = 1
      next
    }
    in_fm == 1 { print }
  ' "$file")"

  # Find the `tools:` line, then check whether it is inline-array or block-list.
  # Inline-array: contains `[` after the colon.
  # Block-list:   nothing (or only whitespace) after the colon.
  tools_line="$(echo "$fm" | grep -E '^tools:' | head -1)"

  if [ -z "$tools_line" ]; then
    # No tools: line at all — treat as missing (caller will detect mismatch).
    echo "MISSING"
    return 0
  fi

  # Strip leading "tools:" and any leading/trailing whitespace from value.
  value="$(echo "$tools_line" | sed -e 's/^tools:[[:space:]]*//' -e 's/[[:space:]]*$//')"

  case "$value" in
    \[*\])
      # Inline-array form. Normalize: strip brackets, split on comma, trim each
      # token, rebuild as "[a, b, c]" (or "[]" if empty).
      inner="$(echo "$value" | sed -e 's/^\[//' -e 's/\]$//')"
      # Trim outer whitespace.
      trimmed="$(echo "$inner" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      if [ -z "$trimmed" ]; then
        echo "[]"
        return 0
      fi
      # Split on commas; trim each element; rejoin with ", ".
      normalized="$(echo "$trimmed" | awk -F',' '{
        out=""
        for (i=1; i<=NF; i++) {
          tok=$i
          gsub(/^[[:space:]]+/, "", tok)
          gsub(/[[:space:]]+$/, "", tok)
          if (i>1) out=out", "
          out=out tok
        }
        print out
      }')"
      echo "[${normalized}]"
      return 0
      ;;
    "")
      # Block-list form. Read subsequent lines that look like `  - Foo` until a
      # non-list-item (or end of frontmatter) is hit.
      items="$(echo "$fm" | awk '
        /^tools:[[:space:]]*$/ { in_block=1; next }
        in_block == 1 {
          if ($0 ~ /^[[:space:]]+-[[:space:]]+/) {
            line=$0
            sub(/^[[:space:]]+-[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
            print line
            next
          } else {
            in_block=0
          }
        }
      ')"
      if [ -z "$items" ]; then
        echo "[]"
        return 0
      fi
      # Join items with ", " into bracketed form.
      joined="$(echo "$items" | awk '
        BEGIN { out="" }
        { if (NR>1) out=out", "; out=out $0 }
        END { print out }
      ')"
      echo "[${joined}]"
      return 0
      ;;
    *)
      # Unknown form (e.g., scalar value) — emit literal so caller flags mismatch.
      echo "UNRECOGNIZED:${value}"
      return 0
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 1: tools: declaration check (per-file lex-equal).
# ---------------------------------------------------------------------------
while IFS=$'\t' read -r file expected; do
  # Skip blank lines.
  if [ -z "$file" ]; then
    continue
  fi

  if [ ! -f "$file" ]; then
    printf 'FAIL: %s — file does not exist\n' "$file"
    FAIL=1
    continue
  fi

  actual="$(extract_tools "$file")"

  if [ "$actual" = "$expected" ]; then
    if [ "$VERBOSE" = "1" ]; then
      printf 'PASS: %s — tools: %s\n' "$file" "$actual"
    fi
  else
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$file" "$expected" "$actual"
    FAIL=1
  fi
done < "$MANIFEST_FILE"

# ---------------------------------------------------------------------------
# Step 2: WebFetch URL allowlist Rule presence (cycle-2 N4 + cycle-3 N4.1).
# Required: analysis + worker. Also checked for inline (cross-file sync).
# Loop directly (no pipe) so FAIL flips in the parent shell under Bash 3.2.
# ---------------------------------------------------------------------------
for file in \
  agents/wiki-synthesizer-analysis.md \
  agents/wiki-synthesizer-worker.md \
  agents/wiki-synthesizer-inline.md
do
  if [ ! -f "$file" ]; then
    printf 'FAIL: %s — file does not exist (allowlist check)\n' "$file"
    FAIL=1
    continue
  fi
  if grep -F -q "WebFetch URL allowlist" "$file"; then
    if [ "$VERBOSE" = "1" ]; then
      printf 'PASS: %s — WebFetch URL allowlist rule present\n' "$file"
    fi
  else
    printf 'FAIL: %s — WebFetch URL allowlist rule MISSING\n' "$file"
    FAIL=1
  fi
done

# ---------------------------------------------------------------------------
# Final result.
# ---------------------------------------------------------------------------
if [ "$FAIL" = "0" ]; then
  echo "OK: All 4 agent files have correct tools declarations."
  echo "OK: WebFetch URL allowlist rule present in analysis + worker (and inline)."
  exit 0
else
  echo "LINT FAILED — see above. Update the manifest in scripts/lint-agent-tools.sh if intentional."
  exit 1
fi
