---
name: wiki-setup
description: Initialize a Deep Wiki on Claude Code or Codex with a native absolute path, portable Node runtime, and optional read-only Obsidian availability probe. Use for /wiki-setup, wiki bootstrap, wiki initialization, or first-time configuration.
user-invocable: true
runtime_hosts: [claude, codex]
---

# wiki-setup

Initialize a wiki without invoking a shell. Every deterministic operation below
is one structured argv call to `scripts/wiki-runtime.js`; paths remain one argv
element and are never rewritten into another host's syntax.

## Inputs

Accept an absolute native path. Windows examples include `C:\Users\name\Wiki`,
`C:/Users/name/Wiki`, and `\\server\share\Wiki`. macOS and Linux paths begin
with `/`. If no path is supplied, ask for one. Do not replace an existing
configuration unless the user explicitly authorizes replacement.

## Procedure

1. Resolve any existing Claude and Codex configuration. A valid existing target
   is authoritative; conflicting targets are a hard error.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","config","resolve","--json"]}
```

2. Select `--config-host` from the actual caller. Claude Code uses `claude`;
   Codex uses `codex`. Run exactly one of the following calls.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","setup","--wiki-root","ABSOLUTE_WIKI_ROOT","--config-host","claude","--json"]}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","setup","--wiki-root","ABSOLUTE_WIKI_ROOT","--config-host","codex","--json"]}
```

The runtime creates the shared layout, seed page, index envelope, lifecycle
record, and host configuration atomically. A conflict or invalid path must be
reported without partially claiming setup succeeded.

3. Optionally probe whether a running Obsidian application exposes its vault.
   This is the sole direct non-Node executable allowed by Deep Wiki and is
   read-only. Probe failure is informational and does not invalidate setup.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"obsidian","argv":["vault"],"timeout_ms":3000}
```

Report the normalized wiki root, configuration host, created artifacts, and
whether Obsidian was available. Never expose internal owner tokens.
