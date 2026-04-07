# Recommended Tools for Deep-Wiki

Tools referenced in [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that enhance the wiki workflow.

## CLI Tools

### qmd — Markdown Search Engine

Local on-device search engine for markdown knowledge bases. Combines BM25 full-text search, vector semantic search, and LLM re-ranking — all running locally.

- **Install:** `npm install -g @tobilu/qmd`
- **CLI usage:** `qmd collection add <path>` to index, `qmd search <query>` to search
- **MCP server:** `qmd mcp --http` to expose as MCP server for agent integration
- **Repository:** https://github.com/tobi/qmd

Useful for `/wiki-query` when the wiki grows large — provides fast BM25+vector search before the LLM reads the results.

### Marp — Markdown Slide Generator

Convert markdown files into slide presentations (HTML, PDF, PPTX).

- **Install:** `npm install -g @marp-team/marp-cli`
- **Usage:** `marp wiki-page.md -o slides.html`
- **Slide syntax:** Use `---` to separate slides in markdown
- **Repository:** https://github.com/marp-team/marp-cli

Useful for generating presentations from wiki content — turn accumulated knowledge into shareable slides.

## Obsidian Plugins

These plugins are only relevant if the wiki is stored inside an Obsidian vault.

### Dataview

Query page frontmatter using a SQL-like syntax to generate dynamic tables and lists.

- **Install:** Obsidian Settings > Community Plugins > Browse > "Dataview"
- **Example query in a wiki page:**
  ````markdown
  ```dataview
  TABLE tags AS "Tags", length(sources) AS "Sources"
  FROM "pages"
  SORT file.mtime DESC
  ```
  ````
- This lets you create live dashboards of your wiki — e.g., pages by tag, recently updated pages, pages with most sources.

### Marp Slides

Render Marp slide decks directly inside Obsidian without leaving the editor.

- **Install:** Obsidian Settings > Community Plugins > Browse > "Marp Slides"
- Complements the CLI `marp` tool for in-editor preview.

### Obsidian Web Clipper (Browser Extension)

Clip web articles as clean markdown directly into your Obsidian vault for quick ingest.

- **Install:** https://obsidian.md/clipper
- Works as a browser extension (Chrome, Firefox, Safari)
- Clips are saved as markdown files — then use `/wiki-ingest <clipped-file>` to integrate into the wiki

## qmd as MCP Server

For deeper integration, qmd can run as an MCP server:

```bash
# Start qmd MCP server
qmd mcp --http --port 8181

# Or as a background daemon
qmd mcp --http --daemon
```

This allows Claude Code or other MCP-compatible agents to search the wiki programmatically during `/wiki-query` operations.
