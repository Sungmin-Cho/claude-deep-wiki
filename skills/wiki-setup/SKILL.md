---
name: wiki-setup
description: Initialize a Deep Wiki on Claude Code or Codex at a native absolute path, with an optional read-only Obsidian availability probe. Triggers on /wiki-setup, wiki bootstrap, wiki initialization, first-time configuration.
user-invocable: true
runtime_hosts: [claude, codex]
---

# wiki-setup

Initialize a wiki without invoking a shell. Every deterministic operation below
is one structured argv call to `<plugin_root>/scripts/wiki-runtime.js`; paths remain one argv
element and are never rewritten into another host's syntax.

## Inputs

Accept an absolute native path. Windows examples include `C:\Users\name\Wiki`,
`C:/Users/name/Wiki`, and `\\server\share\Wiki`. macOS and Linux paths begin
with `/`. If no path is supplied, ask for one. Do not replace an existing
configuration unless the user explicitly authorizes replacement.

## Procedure

1. Resolve any existing Claude and Codex configuration. This diagnostic is
   read-only: it reports the selected global path, wiki-local config path,
   policy source, migration requirement, and policy digest without writing or
   migrating config. A valid existing target is authoritative; conflicting
   targets are a hard error.

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
record, setup authority record, and host configuration atomically. A conflict
or invalid path must be reported without partially claiming setup succeeded.

For a stopped-host authority move, use the explicit rebind route only when the
operator supplies the old root and the old wiki is already absent. This is not
automatic rollback or restoration; if the route publishes `rebind_pending`, the
runtime may complete the new root or fail closed for stopped-host recovery.
A pending rebind resume must use the same `CODEX_HOME` and `DEEP_WIKI_CONFIG`
spelling used when that pending rebind was published, so the original candidate
vector is revalidated rather than silently rebound.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","setup","--rebind-authority-from","OLD_ABSOLUTE_WIKI_ROOT","--wiki-root","NEW_ABSOLUTE_WIKI_ROOT","--config-host","claude","--json"]}
```

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","setup","--rebind-authority-from","OLD_ABSOLUTE_WIKI_ROOT","--wiki-root","NEW_ABSOLUTE_WIKI_ROOT","--config-host","codex","--json"]}
```

3. Optionally probe for an Obsidian CLI. `found` reports CLI presence;
   `reachable` reports whether a running Obsidian application answered with its
   vault. An absolute `DEEP_WIKI_OBSIDIAN_BIN` overrides discovery. Probe
   failure is informational and never invalidates setup.

<!-- deep-wiki:exec -->
```deep-wiki-exec
{"executable":"node","argv":["<plugin_root>/scripts/wiki-runtime.js","probe","obsidian","--json"]}
```

Report the normalized wiki root, configuration host, created artifacts, and
whether the Obsidian CLI was found and reachable. Never expose internal owner
tokens.
