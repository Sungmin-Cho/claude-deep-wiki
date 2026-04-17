#!/bin/bash
set -euo pipefail

# deep-wiki SessionStart hook: scan Obsidian vault for new/modified files
# Outputs a systemMessage listing files to auto-ingest

CONFIG="$HOME/.claude/deep-wiki-config.yaml"

# 1. Read wiki config
if [ ! -f "$CONFIG" ]; then
  exit 0  # No wiki configured, skip silently
fi

WIKI_ROOT=$(grep 'wiki_root:' "$CONFIG" | sed 's/wiki_root: *//' | sed "s|~|$HOME|")

if [ ! -d "$WIKI_ROOT" ]; then
  exit 0  # Wiki root doesn't exist, skip
fi

# 2. Determine vault root (parent of wiki)
VAULT_ROOT=$(dirname "$WIKI_ROOT")

# Verify this looks like an Obsidian vault or at least has content
if [ ! -d "$VAULT_ROOT" ]; then
  exit 0
fi

# 3. Get last scan timestamp
# Priority: committed (.last-scan) > pending (.pending-scan) > first-run fallback.
# A pending-but-not-yet-committed scan means the previous session detected
# candidates but did not finish /wiki-ingest; fall back to its timestamp so
# we don't double-scan the same window, but also don't lose coverage.
LAST_SCAN_FILE="$WIKI_ROOT/.wiki-meta/.last-scan"
PENDING_SCAN_FILE="$WIKI_ROOT/.wiki-meta/.pending-scan"
# Regex matches ISO-8601 UTC "YYYY-MM-DDTHH:MM:SSZ" — any other content
# (empty file from an interrupted write, garbage, or tampered value) is
# rejected and we fall through to the next priority.
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

LAST_SCAN=""
if [ -s "$LAST_SCAN_FILE" ]; then
  _candidate=$(cat "$LAST_SCAN_FILE")
  if [[ "$_candidate" =~ $TS_RE ]]; then
    LAST_SCAN="$_candidate"
  fi
fi
if [ -z "$LAST_SCAN" ] && [ -s "$PENDING_SCAN_FILE" ]; then
  _candidate=$(cat "$PENDING_SCAN_FILE")
  if [[ "$_candidate" =~ $TS_RE ]]; then
    LAST_SCAN="$_candidate"
  fi
fi
if [ -z "$LAST_SCAN" ]; then
  # First run (or both files missing/invalid): use 1 hour ago to avoid
  # ingesting the entire vault on first enrollment.
  LAST_SCAN=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || echo "2026-04-07T00:00:00Z")
fi
unset _candidate

# Convert to epoch for comparison
if command -v gdate &>/dev/null; then
  LAST_EPOCH=$(gdate -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
elif [[ "$(uname)" == "Darwin" ]]; then
  LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_SCAN" +%s 2>/dev/null || echo 0)
else
  LAST_EPOCH=$(date -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
fi

# 3b. Check if Obsidian CLI is available (from config, not hardcoded)
# NOTE: || true prevents set -e from aborting when config has no obsidian_cli block
HAS_OBS_CLI=$(grep 'available: true' "$CONFIG" 2>/dev/null || true)
WIKI_PREFIX=$(grep 'wiki_prefix:' "$CONFIG" 2>/dev/null | sed 's/wiki_prefix: *//' | tr -d '"' | tr -d "'" || true)

# 3c. Collect candidates from obsidian recents (supplement, not replacement)
# recents returns "recently opened" files — may include unmodified files.
# All candidates MUST pass mtime verification below.
RECENTS_FILES=()
if [ -n "$HAS_OBS_CLI" ] && [ -n "$WIKI_PREFIX" ]; then
  # macOS lacks `timeout`; use gtimeout (from coreutils) or run without timeout
  TIMEOUT_CMD=""
  if command -v timeout &>/dev/null; then
    TIMEOUT_CMD="timeout 3"
  elif command -v gtimeout &>/dev/null; then
    TIMEOUT_CMD="gtimeout 3"
  fi
  RECENTS_OUTPUT=$($TIMEOUT_CMD obsidian recents 2>/dev/null || true)
  if [ -n "$RECENTS_OUTPUT" ]; then
    while IFS= read -r rel_path; do
      # Exclude system dirs first (always).
      case "$rel_path" in
        .obsidian/*|.trash/*) continue ;;
      esac

      # Exclude wiki-scoped paths. When wiki_prefix is "." (wiki at vault
      # root), explicitly exclude pages/, .wiki-meta/, and wiki artifacts.
      if [ "$WIKI_PREFIX" = "." ]; then
        case "$rel_path" in
          pages/*|.wiki-meta/*|index.md|log.md|log.jsonl) continue ;;
        esac
      else
        case "$rel_path" in
          "${WIKI_PREFIX}"/*) continue ;;
        esac
      fi

      # Only consider markdown files.
      case "$rel_path" in
        *.md) ;;
        *) continue ;;
      esac

      # mtime verification: only include actually modified files.
      FULL_PATH="$VAULT_ROOT/$rel_path"
      if [ -f "$FULL_PATH" ]; then
        if [[ "$(uname)" == "Darwin" ]]; then
          FILE_EPOCH=$(stat -f %m "$FULL_PATH" 2>/dev/null || echo 0)
        else
          FILE_EPOCH=$(stat -c %Y "$FULL_PATH" 2>/dev/null || echo 0)
        fi
        if [ "$FILE_EPOCH" -gt "$LAST_EPOCH" ]; then
          RECENTS_FILES+=("$rel_path")
        fi
      fi
    done <<< "$RECENTS_OUTPUT"
  fi
fi

# 4. Find modified .md files in vault (excluding wiki itself, .obsidian, .trash)
NEW_FILES=()

while IFS= read -r -d '' file; do
  # Get file modification time as epoch
  if [[ "$(uname)" == "Darwin" ]]; then
    FILE_EPOCH=$(stat -f %m "$file" 2>/dev/null || echo 0)
  else
    FILE_EPOCH=$(stat -c %Y "$file" 2>/dev/null || echo 0)
  fi

  if [ "$FILE_EPOCH" -gt "$LAST_EPOCH" ]; then
    # Get relative path from vault root
    REL_PATH="${file#$VAULT_ROOT/}"
    NEW_FILES+=("$REL_PATH")
  fi
done < <(find "$VAULT_ROOT" \
  -not -path "$WIKI_ROOT/*" \
  -not -path "*/.obsidian/*" \
  -not -path "*/.trash/*" \
  -not -path "*/.git/*" \
  -not -name "*.canvas" \
  -not -name "Personal To-dos.md" \
  -not -name "Work To-dos.md" \
  -not -name "VPN *" \
  -name "*.md" \
  -print0 2>/dev/null)

# 4b. Merge recents candidates with find results (union + deduplicate)
# NOTE: bash 3.2 (macOS default) aborts on "${ARR[@]}" when ARR is empty
# under `set -u`, so guard with ${#ARR[@]} checks before iterating.
if [ ${#RECENTS_FILES[@]} -gt 0 ]; then
  for rf in "${RECENTS_FILES[@]}"; do
    ALREADY_FOUND=false
    if [ ${#NEW_FILES[@]} -gt 0 ]; then
      for nf in "${NEW_FILES[@]}"; do
        if [ "$rf" = "$nf" ]; then
          ALREADY_FOUND=true
          break
        fi
      done
    fi
    if [ "$ALREADY_FOUND" = false ]; then
      NEW_FILES+=("$rf")
    fi
  done
fi

# 5. Write pending scan timestamp atomically. wiki-ingest promotes this
# to .last-scan only after a successful batch. If ingest is skipped or
# fails, the next session re-scans the same window and candidates are
# not lost.
#
# Atomic write protocol: write into a temp file, fsync via mv.
# This prevents partial-write residue if the hook is SIGTERM'd (e.g.
# the 15s hook timeout) mid-write on Google Drive-backed volumes.
META_DIR="$(dirname "$LAST_SCAN_FILE")"
mkdir -p "$META_DIR"
TMP_SCAN=$(mktemp "$META_DIR/.pending-scan.XXXXXX")
if date -u +"%Y-%m-%dT%H:%M:%SZ" > "$TMP_SCAN"; then
  mv "$TMP_SCAN" "$PENDING_SCAN_FILE"
else
  rm -f "$TMP_SCAN"
fi

# 6. Output result
if [ ${#NEW_FILES[@]} -eq 0 ]; then
  # No new files, exit silently
  exit 0
fi

# Build file list (max 20 to keep message manageable)
FILE_LIST=""
TOTAL=${#NEW_FILES[@]}
SHOWN=0
for f in "${NEW_FILES[@]}"; do
  if [ $SHOWN -lt 20 ]; then
    FILE_LIST="$FILE_LIST\n  - $f"
    SHOWN=$((SHOWN + 1))
  fi
done

if [ "$TOTAL" -gt 20 ]; then
  FILE_LIST="$FILE_LIST\n  - ... and $((TOTAL - 20)) more"
fi

# Output systemMessage for Claude
cat << EOJSON
[deep-wiki] ${TOTAL}개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.

자동 ingest 대상:
$(echo -e "$FILE_LIST")

이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. vault 경로: $VAULT_ROOT
EOJSON
