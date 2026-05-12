# scan-vault-changes Golden Fixtures (M5.5 #3)

Each scenario is a pair of files:

- `<name>.input.json`    — vault tree + config + initial meta state
- `<name>.expected.json` — exit code + detected count + expected/forbidden files

Driver: `tests/auto-ingest-golden.test.js` discovers pairs by basename,
materializes the vault tree inside a tmpdir, writes
`$HOME/.claude/deep-wiki-config.yaml` from `config_yaml`, spawns
`scan-vault-changes.sh` via the `runScanVault` helper, and asserts each
expected field.

## `.input.json` schema

```jsonc
{
  "description": "human-readable scenario",

  // Optional. Defaults: vault_path="myvault", wiki_path="wiki".
  // Resulting layout: $tmpRoot/<vault_path>/<wiki_path>/.wiki-meta/...
  "vault_path": "myvault",
  "wiki_path": "wiki",

  // Required for any non-trivial scenario. Object of {relative-path: content}.
  // Paths are relative to <vault_path>. Files are written with utf8 encoding.
  // Use empty string "" to touch an empty file.
  "vault_tree": {
    "notes/a.md": "# note a",
    "archive/old.md": "# old"
  },

  // Optional. Per-file mtime offset in seconds, relative to "now".
  // Negative = older than now (used to test "file older than .last-scan").
  // Files referenced here MUST exist in vault_tree (loader throws otherwise).
  "mtime_offsets": {
    "notes/old-file.md": -7200   // two hours ago — older than 1hr fallback
  },

  // Optional. YAML config written to $HOME/.claude/deep-wiki-config.yaml.
  // Supports ${VAULT_ROOT} + ${WIKI_ROOT} template substitution so a
  // fixture stays portable across tmpdir paths. Omit entirely to exercise
  // the "no config — silent skip" branch.
  "config_yaml": "wiki_root: ${WIKI_ROOT}\n",

  // Optional. Pre-seed <wiki_root>/.wiki-meta/.last-scan or .pending-scan
  // with an ISO-8601 UTC timestamp. Used to test the priority logic
  // (committed > pending > 1-hour-ago fallback).
  "last_scan": "2099-01-01T00:00:00Z",
  "pending_scan": "2025-01-01T00:00:00Z"
}
```

## `.expected.json` schema

```jsonc
{
  "exit_code": 0,                       // hook always exits 0 unless wiki_root is a Windows-native path

  // Optional. 0 = silent-exit branch (no header should be emitted).
  // N = expect header "[deep-wiki] N개의 새로운/수정된 파일이..." + N file-list lines.
  "detected_count": 2,

  // Optional. Order-insensitive — find(1) order is filesystem-dependent.
  // Each entry is the path RELATIVE TO VAULT_ROOT (matches the script's
  // REL_PATH=${file#$VAULT_ROOT/} substitution).
  "expected_files": ["notes/a.md", "notes/b.md"],

  // Optional. Asserts NONE of these appear in the parsed file list. Used
  // for ignore_globs / require_tag / .obsidian-skip negative assertions.
  "forbidden_files": ["archive/old.md"],

  // Optional. Substring assertion on raw stdout — useful for the Korean
  // header literal, etc.
  "stdout_contains": "[deep-wiki]",

  // Optional. Asserts the pre-existing .pending-scan timestamp was
  // preserved verbatim (not advanced by this hook fire).
  "pending_scan_preserved": "2025-01-01T00:00:00Z"
}
```

## When adding fixtures

- Use kebab-case basenames so test names sort sensibly:
  `01-empty-vault.input.json`.
- Keep `description` short — it's prefixed onto the `it()` name.
- Run `node --test tests/auto-ingest-golden.test.js` after adding.
- If a pair is missing one half, the driver throws at load time (fail loud).
- Time-sensitive scenarios should use the `mtime_offsets` field rather
  than relying on filesystem timing — `fs.utimesSync` gives deterministic
  control over the comparison the hook performs.
