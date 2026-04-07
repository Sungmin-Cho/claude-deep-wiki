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
LAST_SCAN_FILE="$WIKI_ROOT/.wiki-meta/.last-scan"

if [ -f "$LAST_SCAN_FILE" ]; then
  LAST_SCAN=$(cat "$LAST_SCAN_FILE")
else
  # First run: set to 1 hour ago to avoid ingesting everything
  LAST_SCAN=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-04-07T00:00:00Z")
fi

# Convert to epoch for comparison
if command -v gdate &>/dev/null; then
  LAST_EPOCH=$(gdate -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
elif [[ "$(uname)" == "Darwin" ]]; then
  LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_SCAN" +%s 2>/dev/null || echo 0)
else
  LAST_EPOCH=$(date -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
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

# 5. Update last scan timestamp
mkdir -p "$(dirname "$LAST_SCAN_FILE")"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LAST_SCAN_FILE"

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
