'use strict';

// tests/auto-ingest-golden.test.js — M5.5 #3 hook golden test (deep-wiki).
//
// **Goal**: pin scan-vault-changes.js's stdout (file list + Korean system
// message header) + exit code on a fixture corpus so the auto-ingest
// detection contract (mtime > last-scan, .obsidian/.trash exclusion,
// auto_ingest.{ignore_globs, require_tag} filters, .pending-scan
// preservation) is regression-protected across representative vault
// shapes. Adding a new scenario = adding a `<name>.input.json` +
// `<name>.expected.json` pair under `tests/fixtures/golden/`. The loader
// fails loud if one side is missing (catches accidental half-commits).
//
// Spec: claude-deep-suite/docs/superpowers/plans/
//         2026-05-12-m5.5-remaining-tests-handoff.md §2 #3
//
// Reference: claude-deep-work tests/phase-guard-golden.test.js (PR #29).
// Helper rationale: see hooks/scripts/test-helpers/run-scan-vault.js.

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runScanVault,
  parseHookOutput,
  interpolateYamlDoubleQuotedPlaceholder,
} = require('../hooks/scripts/test-helpers/run-scan-vault');

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'golden');

function loadFixtureCorpus() {
  const entries = fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.input.json') || f.endsWith('.expected.json'));
  const map = new Map();
  for (const file of entries) {
    const m = file.match(/^(.+)\.(input|expected)\.json$/);
    if (!m) continue;
    const [, name, kind] = m;
    if (!map.has(name)) map.set(name, { name });
    map.get(name)[kind] = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    );
  }
  for (const [name, fixture] of map) {
    if (!fixture.input || !fixture.expected) {
      const missing = fixture.input ? '.expected' : '.input';
      throw new Error(
        `Golden fixture "${name}" is missing ${missing}.json — half-commit?`,
      );
    }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Materialize a vault tree from a `{relpath: content}` object under
 * `vaultRoot`. Creates intermediate directories. Empty-string content
 * is allowed (touch the file).
 */
function materializeVault(vaultRoot, tree) {
  for (const [rel, content] of Object.entries(tree || {})) {
    const full = path.join(vaultRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

/**
 * Apply mtime offsets (seconds, relative to "now") to specific files.
 * Negative offsets = older than now. Critical for testing the mtime
 * comparison branch: scan-vault-changes.sh accepts files with mtime
 * strictly greater than the resolved LAST_EPOCH; an older mtime
 * (offset = -7200 for "two hours ago") falls below the 1-hour-ago
 * fallback and is filtered out.
 */
function applyMtimeOffsets(vaultRoot, offsets) {
  if (!offsets) return;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [rel, deltaSec] of Object.entries(offsets)) {
    const full = path.join(vaultRoot, rel);
    if (!fs.existsSync(full)) {
      throw new Error(
        `Fixture mtime offset references missing file: ${rel}. ` +
        `Add it to vault_tree first.`,
      );
    }
    const ts = nowSec + Number(deltaSec);
    fs.utimesSync(full, ts, ts);
  }
}

function writeMetaTimestamp(wikiRoot, filename, isoTimestamp) {
  if (!isoTimestamp) return;
  const metaDir = path.join(wikiRoot, '.wiki-meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, filename), isoTimestamp, 'utf8');
}

function writeLocalConfig(wikiRoot, value) {
  if (value === undefined) return;
  const metaDir = path.join(wikiRoot, '.wiki-meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const source = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(metaDir, '.config.json'), source, 'utf8');
}

const CORPUS = loadFixtureCorpus();
if (CORPUS.length === 0) {
  throw new Error('No golden fixtures discovered under tests/fixtures/golden/');
}

test('Windows config placeholders are escaped as YAML double-quoted scalar fragments', () => {
  assert.equal(
    interpolateYamlDoubleQuotedPlaceholder(
      'wiki_root: "${WIKI_ROOT}"\r\n',
      '${WIKI_ROOT}',
      'D:\\a\\민수\\Deep Wiki',
    ),
    'wiki_root: "D:\\\\a\\\\민수\\\\Deep Wiki"\r\n',
  );
});

describe('scan-vault-changes.js golden fixtures (M5.5 #3)', () => {
  for (const [name, fixture] of CORPUS) {
    const desc = fixture.input.description || '(no description)';
    it(`${name} — ${desc}`, () => {
      const tmpRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'dw-golden-')),
      );
      try {
        // Layout: $tmpRoot/$vault_path/$wiki_path
        const vaultPath = fixture.input.vault_path || 'myvault';
        const wikiPath = fixture.input.wiki_path || 'wiki';
        const vaultRoot = path.join(tmpRoot, vaultPath);
        const wikiRoot = path.join(vaultRoot, wikiPath);
        if (fixture.input.create_wiki_meta === false) fs.mkdirSync(wikiRoot, { recursive: true });
        else fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });

        // Materialize the vault tree BEFORE the config is written so that
        // any mtime adjustments hit real files. Skip if no tree (e.g. the
        // "no config" branch test).
        if (fixture.input.vault_tree) {
          materializeVault(vaultRoot, fixture.input.vault_tree);
          applyMtimeOffsets(vaultRoot, fixture.input.mtime_offsets);
        }

        // Pre-seed .last-scan / .pending-scan if requested.
        writeMetaTimestamp(wikiRoot, '.last-scan', fixture.input.last_scan);
        writeMetaTimestamp(wikiRoot, '.pending-scan', fixture.input.pending_scan);
        writeLocalConfig(wikiRoot, fixture.input.local_config_json);

        // Config YAML may reference ${VAULT_ROOT} / ${WIKI_ROOT} so a
        // fixture stays portable across tmpdir paths.
        let configYaml = fixture.input.config_yaml;
        if (typeof configYaml === 'string') {
          configYaml = interpolateYamlDoubleQuotedPlaceholder(
            configYaml, '${VAULT_ROOT}', vaultRoot,
          );
          configYaml = interpolateYamlDoubleQuotedPlaceholder(
            configYaml, '${WIKI_ROOT}', wikiRoot,
          );
        }

        const result = runScanVault({
          homeDir: tmpRoot,
          configYaml,
        });

        const expected = fixture.expected;
        assert.equal(
          result.status,
          expected.exit_code,
          `exit code mismatch for ${name}: status=${result.status} ` +
          `stdout=<<<${result.stdout}>>> stderr=<<<${result.stderr}>>>`,
        );

        const parsed = parseHookOutput(result.stdout);

        if (typeof expected.detected_count === 'number') {
          // detected_count: null/undefined means "no header expected"
          // (silent-exit branch); a number means the header must report
          // exactly that many files.
          if (expected.detected_count === 0) {
            assert.equal(
              parsed.hasHeader,
              false,
              `expected silent exit (no header) for ${name}; got header ` +
              `with count=${parsed.count}, stdout=<<<${result.stdout}>>>`,
            );
          } else {
            const hookOutput = JSON.parse(result.stdout);
            assert.deepEqual(Object.keys(hookOutput), ['hookSpecificOutput']);
            assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'SessionStart');
            assert.equal(typeof hookOutput.hookSpecificOutput.additionalContext, 'string');
            assert.equal(
              parsed.hasHeader,
              true,
              `expected header for ${name}; stdout=<<<${result.stdout}>>>`,
            );
            assert.equal(
              parsed.count,
              expected.detected_count,
              `header count mismatch for ${name}: stdout=<<<${result.stdout}>>>`,
            );
            assert.equal(
              parsed.files.length,
              expected.detected_count,
              `file list length mismatch for ${name}: ` +
              `parsed=${JSON.stringify(parsed.files)}`,
            );
          }
        }

        if (Array.isArray(expected.expected_files)) {
          // expected_files: order-insensitive set comparison. The hook's
          // find(1) traversal order is filesystem-dependent.
          const got = [...parsed.files].sort();
          const want = [...expected.expected_files].sort();
          assert.deepEqual(
            got,
            want,
            `file list mismatch for ${name}: got=${JSON.stringify(got)} ` +
            `want=${JSON.stringify(want)}`,
          );
        }

        if (Array.isArray(expected.forbidden_files)) {
          // forbidden_files: NONE of these should appear in the list.
          // Used by ignore_globs / require_tag / .obsidian-skip fixtures.
          for (const forbidden of expected.forbidden_files) {
            assert.ok(
              !parsed.files.includes(forbidden),
              `forbidden file leaked into list for ${name}: ${forbidden} ` +
              `(parsed=${JSON.stringify(parsed.files)})`,
            );
          }
        }

        if (typeof expected.stdout_contains === 'string') {
          assert.ok(
            result.stdout.includes(expected.stdout_contains),
            `expected stdout to contain "${expected.stdout_contains}" for ${name}; ` +
            `got: <<<${result.stdout}>>>`,
          );
        }

        if (typeof expected.pending_scan_preserved === 'string') {
          // The hook MUST NOT overwrite a valid pre-existing .pending-scan.
          const pending = path.join(wikiRoot, '.wiki-meta', '.pending-scan');
          assert.ok(
            fs.existsSync(pending),
            `pending-scan should exist for ${name}`,
          );
          const got = fs.readFileSync(pending, 'utf8').trim();
          assert.equal(
            got,
            expected.pending_scan_preserved,
            `pending-scan was mutated for ${name}: got=${got}`,
          );
        }

        if (expected.local_config_json) {
          const localConfig = path.join(wikiRoot, '.wiki-meta', '.config.json');
          assert.equal(
            fs.existsSync(localConfig),
            true,
            `wiki-local config should exist for ${name}`,
          );
          assert.deepEqual(
            JSON.parse(fs.readFileSync(localConfig, 'utf8')),
            expected.local_config_json,
            `wiki-local config mismatch for ${name}`,
          );
        }

        if (expected.meta_created === true) {
          assert.equal(
            fs.existsSync(path.join(wikiRoot, '.wiki-meta')),
            true,
            `wiki metadata directory should exist for ${name}`,
          );
        }
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  }
});
