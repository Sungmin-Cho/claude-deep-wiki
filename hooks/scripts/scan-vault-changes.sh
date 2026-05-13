#!/bin/bash
set -euo pipefail

# deep-wiki SessionStart hook: scan Obsidian vault for new/modified files.
#
# This script is invoked by hooks.json's SessionStart hook with a 15-second
# command timeout (see hooks.json:"timeout": 15 — the unit is seconds, per
# Claude Code plugin spec). If this script does not finish within that
# budget it will be SIGTERM'd — all I/O operations should be either bounded
# (e.g. `timeout N obsidian recents`) or idempotent on retry.
#
# Outputs a systemMessage listing files to auto-ingest.

CONFIG="$HOME/.claude/deep-wiki-config.yaml"

# 1. Read wiki config
if [ ! -f "$CONFIG" ]; then
  exit 0  # No wiki configured, skip silently
fi

# Parse wiki_root from top-level YAML key only (ignore comments and nested keys).
# Accept "wiki_root: value" at column 0, strip inline comments and quotes.
WIKI_ROOT=$(grep -E '^wiki_root:[[:space:]]*' "$CONFIG" \
  | head -1 \
  | sed -E 's/^wiki_root:[[:space:]]*//' \
  | sed -E 's/[[:space:]]+#.*$//' \
  | sed -E 's/^["'\'']//; s/["'\'']$//' \
  | sed "s|^~|$HOME|")

# Reject Windows-native paths ("C:\..." or "C:/...") because the rest of
# the script relies on POSIX semantics. Users on Windows should configure
# wiki_root using MSYS/Git-Bash form (e.g. /c/Users/name/wiki).
case "$WIKI_ROOT" in
  [A-Za-z]:\\*|[A-Za-z]:/*)
    echo "[deep-wiki] wiki_root is a Windows-native path ($WIKI_ROOT)." >&2
    echo "[deep-wiki] Convert to POSIX form (e.g. /c/Users/...) and re-run /wiki-setup." >&2
    exit 1
    ;;
esac

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
# TS_RE mirrors the regex in commands/wiki-ingest.md's promote snippet — keep in sync.
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
if command -v gdate >/dev/null 2>&1; then
  LAST_EPOCH=$(gdate -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
elif [[ "$(uname)" == "Darwin" ]]; then
  LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_SCAN" +%s 2>/dev/null || echo 0)
else
  LAST_EPOCH=$(date -d "$LAST_SCAN" +%s 2>/dev/null || echo 0)
fi

# 3b. Detect obsidian_cli.available and obsidian_cli.wiki_prefix using a
# block-aware awk state machine.
# - Enter the obsidian_cli block on "^obsidian_cli:".
# - Leave the block when any non-indented line appears (next top-level
#   YAML key) — this prevents "available: true" in an unrelated block
#   from being mis-attributed.
# Full YAML parsing would require a dependency; this is the minimal
# correct parser that respects block boundaries.

HAS_OBS_CLI=$(awk '
  /^obsidian_cli:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/                    { in_block=0 }
  in_block && /^[[:space:]]+available:[[:space:]]*true[[:space:]]*(#.*)?$/ {
    print "1"; exit
  }
' "$CONFIG" 2>/dev/null)

WIKI_PREFIX=$(awk '
  /^obsidian_cli:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/                    { in_block=0 }
  in_block && /^[[:space:]]+wiki_prefix:[[:space:]]*/ {
    sub(/^[[:space:]]+wiki_prefix:[[:space:]]*/, "")
    sub(/[[:space:]]+#.*$/, "")
    sub(/[[:space:]]+$/, "")
    gsub(/^["'"'"']|["'"'"']$/, "")
    print; exit
  }
' "$CONFIG" 2>/dev/null)

# 3d. Parse auto_ingest block (optional)
# - ignore_globs: list of glob patterns to exclude
# - require_tag: if non-empty, only include files with this tag in frontmatter
IGNORE_GLOBS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  IGNORE_GLOBS+=("$line")
done < <(awk '
  # Inline list parser used by both block-inline and dotted-form branches.
  function parse_inline_list(line,    s, items, n, i, item) {
    s = line
    sub(/^[^\[]*\[/, "", s)         # strip everything up to and including [
    sub(/\][[:space:]]*(#.*)?$/, "", s)   # strip trailing ] and any comment
    n = split(s, items, /,/)
    for (i = 1; i <= n; i++) {
      item = items[i]
      gsub(/^[[:space:]]*["'"'"']?/, "", item)
      gsub(/["'"'"']?[[:space:]]*$/, "", item)
      if (item != "") print item
    }
  }
  # Form 3: dotted top-level (matched anywhere, no in_block dependency)
  /^auto_ingest\.ignore_globs:[[:space:]]*\[/ {
    parse_inline_list($0)
    next
  }
  /^auto_ingest:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/                    { in_block=0 }
  # Form 2: inline form inside auto_ingest block
  in_block && /^[[:space:]]+ignore_globs:[[:space:]]*\[/ {
    parse_inline_list($0)
    in_list=0
    next
  }
  # Form 1: block form (existing). `next` is required: the sub() above
  # mutates $0 (strips the leading "  - "), so without `next` the terminator
  # rule below would fire on the very same line and prematurely set in_list=0,
  # silently dropping every list item after the first. (Pre-existing bug
  # surfaced by v1.3.0 sandbox; fixed here as part of the broaden.)
  in_block && /^[[:space:]]+ignore_globs:[[:space:]]*(#.*)?$/ { in_list=1; next }
  in_block && in_list && /^[[:space:]]+-[[:space:]]*/ {
    sub(/^[[:space:]]+-[[:space:]]*/, "")
    sub(/[[:space:]]+#.*$/, "")
    sub(/[[:space:]]+$/, "")
    gsub(/^["'"'"']|["'"'"']$/, "")
    print
    next
  }
  in_block && in_list && !/^[[:space:]]+-/ { in_list=0 }
' "$CONFIG" 2>/dev/null)

REQUIRE_TAG=$(awk '
  /^auto_ingest:[[:space:]]*(#.*)?$/ { in_block=1; next }
  /^[^[:space:]#]/                    { in_block=0 }
  in_block && /^[[:space:]]+require_tag:[[:space:]]*/ {
    sub(/^[[:space:]]+require_tag:[[:space:]]*/, "")
    sub(/[[:space:]]+#.*$/, "")
    sub(/[[:space:]]+$/, "")
    gsub(/^["'"'"']|["'"'"']$/, "")
    print; exit
  }
' "$CONFIG" 2>/dev/null)

# 3c. Collect candidates from obsidian recents (supplement, not replacement)
# recents returns "recently opened" files — may include unmodified files.
# All candidates MUST pass mtime verification below.
RECENTS_FILES=()
if [ -n "$HAS_OBS_CLI" ] && [ -n "$WIKI_PREFIX" ]; then
  # Pick a POSIX "run-command-with-timeout" wrapper. Windows ships
  # C:\Windows\System32\timeout.exe which has a completely different
  # CLI ("timeout /T N") and cannot run a child command, so detect and
  # skip it when running under Git Bash / MSYS2.
  #
  # IMPORTANT: anchor the match to the Windows system path structure
  # (/windows/system32/timeout[.exe]$) so that a legitimate GNU timeout
  # installed under an unrelated directory containing the word "windows"
  # (e.g. /Users/alice/Windows-related/bin/timeout) is NOT skipped.
  TIMEOUT_CMD=""
  TIMEOUT_BIN=$(command -v timeout 2>/dev/null || true)
  if [ -n "$TIMEOUT_BIN" ] && ! echo "$TIMEOUT_BIN" | grep -qiE '/windows/system32/timeout(\.exe)?$'; then
    TIMEOUT_CMD="timeout 3"
  elif command -v gtimeout >/dev/null 2>&1; then
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

# Helper: returns 0 (true) if rel_path passes both filters, non-zero otherwise.
auto_ingest_passes() {
  local rel="$1"
  local full="$2"

  # ignore_globs check
  if [ ${#IGNORE_GLOBS[@]} -gt 0 ]; then
    for pat in "${IGNORE_GLOBS[@]}"; do
      # bash extended-glob matching using case (POSIX-portable)
      case "$rel" in
        $pat) return 1 ;;
      esac
    done
  fi

  # require_tag check (read first ~50 lines of frontmatter)
  # IW2 review fix (v1.2.0+): hard line-count guard. Files without frontmatter
  # (or with missing closing `---`) would otherwise scan to EOF, which can
  # exceed the 15s SessionStart hook timeout on cloud-backed vaults with large
  # untagged notes. 50 lines is well beyond any realistic frontmatter window.
  # RW5+CR-E review fix (v1.2.1+): the `---` rule must precede the line-counter
  # rule so a closing `---` past line 50 (Templater-plugin frontmatter) is not
  # missed. The line-counter early-exit only fires when frontmatter has not
  # started (fm == 0); in-progress frontmatter (fm == 1) keeps reading up to
  # the 200-line absolute cap. Opening `---` is restricted to line 1 so a
  # body horizontal rule past line 50 cannot leak into frontmatter mode.
  if [ -n "$REQUIRE_TAG" ] && [ -f "$full" ]; then
    if ! awk -v want="$REQUIRE_TAG" '
      BEGIN{infm=0; intags=0; found=0; line=0}
      { line++ }
      /^---[[:space:]]*$/ {
        # CR-E v1.2.1+: only line-1 `---` opens frontmatter. A body horizontal rule
        # past line 50 in a no-frontmatter file would otherwise flip fm to 1 and
        # cause subsequent body lines that look like `tags: [x]` to match the
        # require_tag check, leaking files past the auto_ingest filter.
        if (fm == 0 && line != 1) {
          if (line > 50) exit                     # body `---` past 50 → no FM, exit
          next                                    # body `---` within first 50 → ignore, keep reading
        }
        fm++; if(fm==1) infm=1; else if(fm==2){exit}
      }
      { if (fm == 0 && line > 50) exit; if (line > 200) exit }
      infm && /^tags:[[:space:]]*\[/ {
        body=$0; sub(/^tags:[[:space:]]*\[/,"",body); sub(/\][[:space:]]*$/,"",body)
        n=split(body,arr,",")
        for(i=1;i<=n;i++){ gsub(/^[[:space:]"\x27]+|[[:space:]"\x27]+$/,"",arr[i]); if(arr[i]==want){found=1; exit} }
        next
      }
      infm && /^tags:[[:space:]]*$/ { intags=1; next }
      infm && intags && /^[[:space:]]+-[[:space:]]*/ {
        v=$0; sub(/^[[:space:]]+-[[:space:]]*/,"",v); sub(/[[:space:]]+$/,"",v); gsub(/^["\x27]+|["\x27]+$/,"",v)
        if(v==want){found=1; exit}
      }
      infm && intags && !/^[[:space:]]+-/ { intags=0 }
      END{ exit (found ? 0 : 1) }
    ' "$full" 2>/dev/null; then
      return 1
    fi
  fi

  return 0
}

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
    if ! auto_ingest_passes "$REL_PATH" "$file"; then
      continue
    fi
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
    FULL_PATH="$VAULT_ROOT/$rf"
    if ! auto_ingest_passes "$rf" "$FULL_PATH"; then
      continue
    fi
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

# 5. Write pending scan timestamp — BUT only if no valid pending window is
# already in place. .pending-scan represents "the oldest detection window
# awaiting ingest promotion". Advancing it on every hook fire would erase
# the lower bound and let files detected in an earlier session drop below
# the next LAST_EPOCH whenever /wiki-ingest was skipped (H1 regression on
# fresh installs without .last-scan — reported by ultrareview bug_006).
#
# Atomic write protocol: write into a temp file, fsync via mv.
# - mktemp failure is treated as a soft skip (consistent with the other
#   "skip silently if infra unavailable" exits above) rather than letting
#   set -e abort the hook and surface as a SessionStart failure banner.
# - A trap on TMP_SCAN ensures the temp file is cleaned up if SIGTERM
#   interrupts the date-redirect before mv completes (the 15s hook budget
#   on Google Drive-backed volumes is the motivating case).
META_DIR="$(dirname "$LAST_SCAN_FILE")"
mkdir -p "$META_DIR"

_pending_ok=""
if [ -s "$PENDING_SCAN_FILE" ]; then
  _existing=$(cat "$PENDING_SCAN_FILE" 2>/dev/null || true)
  if [[ "$_existing" =~ $TS_RE ]]; then
    _pending_ok=1
  fi
fi

if [ -z "$_pending_ok" ]; then
  TMP_SCAN=$(mktemp "$META_DIR/.pending-scan.XXXXXX" 2>/dev/null) || exit 0
  trap 'rm -f -- "$TMP_SCAN" 2>/dev/null' EXIT
  if date -u +"%Y-%m-%dT%H:%M:%SZ" > "$TMP_SCAN"; then
    mv "$TMP_SCAN" "$PENDING_SCAN_FILE"
  else
    rm -f -- "$TMP_SCAN"
  fi
  trap - EXIT
fi
unset _existing _pending_ok

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
cat << EOMSG
[deep-wiki] ${TOTAL}개의 새로운/수정된 파일이 Obsidian vault에서 감지되었습니다.

자동 ingest 대상:
$(echo -e "$FILE_LIST")

이 파일들을 /wiki-ingest로 위키에 자동 반영하세요. 각 파일을 읽고 기존 위키 페이지에 병합하거나 새 페이지를 생성하세요. vault 경로: $VAULT_ROOT
EOMSG
