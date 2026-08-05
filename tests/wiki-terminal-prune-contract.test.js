'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function ignoredMetadataParagraph(source) {
  const marker = source.indexOf('ignored_os_metadata');
  assert.notEqual(marker, -1, 'ignored_os_metadata paragraph is missing');
  const start = source.lastIndexOf('\n\n', marker) + 2;
  const nextBlank = source.indexOf('\n\n', marker);
  const nextHeading = source.indexOf('\n#', marker);
  const endCandidates = [nextBlank, nextHeading].filter((value) => value !== -1);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : source.length;
  return source.slice(start, end).trim();
}

function assertIgnoredMetadataParagraph(paragraph) {
  assert.match(
    paragraph,
    /Regular OS-metadata files in content catalogs .* are skipped by readers and reported in `ignored_os_metadata`/s,
  );
  assert.match(paragraph, /`pages\/`, `\.wiki-meta\/sources\/`, and `\.wiki-meta\/.versions\/`/);
  assert.match(paragraph, /content-catalog files are never deleted or reclaimed/);
  assert.match(paragraph, /Junk-named symlinks, directories, and entries whose type cannot be resolved remain fail-closed/);
  assert.match(paragraph, /`removed_junk` remains transaction-store-only/);
  assert.doesNotMatch(
    paragraph,
    /(?:content catalogs|pages\/|\.wiki-meta\/sources\/|\.wiki-meta\/.versions\/)[^.;\n]*(?:are|is) (?:deleted|reclaimed)\b/i,
  );
}

test('public contracts name every terminal-prune caller and preserve recovery authority', () => {
  const lint = read('skills/wiki-lint/SKILL.md');
  const schema = read('skills/wiki-schema/SKILL.md');
  const storage = read('skills/wiki-schema/references/storage-layout.md');
  const machine = read('skills/wiki-schema/wiki-schema.yaml');
  for (const source of [schema, storage, machine]) {
    assert.match(source, /wiki-lint --fix/);
    assert.match(source, /scan-window ensure/);
    assert.match(source, /transaction prune/);
    assert.match(source, /authenticated.*residue|residue.*authenticated/i);
    assert.match(source, /created.*last-scan.*proposed|last-scan.*proposed.*created/is);
    assert.match(source, /preserved.*stale|stale.*preserved/is);
    assert.match(source, /initial-invalid|initially invalid/i);
    assert.match(
      source,
      /initial-invalid.*(?:suppresses|protects).*every.*(?:created.*preserved.*stale|created.*stale.*preserved)/is,
    );
    assert.match(source, /already-started.*residue.*(?:remains|is).*protected/is);
    assert.doesNotMatch(source, /may finish despite an initial-invalid/i);
    assert.match(source, /physical.*seal|seal.*physical/i);
    assert.match(source, /reservation-\.prune|reservation.*prune/i);
    assert.match(source, /stopped-host/i);
    assert.match(source, /ordinary.*age|age.*ordinary/i);
  }
  assert.match(lint, /terminal_prune\.complete/);
  assert.match(lint, /nested terminal.*regular metadata.*owner.*directory\s+identity/is);
  assert.match(lint, /held.*terminal_prune\.complete.*false/is);
  assert.match(lint, /nested.*never.*removed_junk/is);
  assert.match(lint, /non-regular.*recovery/i);
  assert.match(lint, /removed_junk_complete/);
  assert.match(lint, /Rerun while\s*\n?`removed_junk_complete` is `false`/);
  assert.strictEqual(lint.includes('recovery pass incomplete'), true);
  assert.strictEqual(lint.includes('recovery pass completed'), true);
  assert.match(lint, /TRANSACTION_RECOVERY_REQUIRED/);
  assert.match(lint, /WIKI_STATE_INVALID/);
  assert.match(lint, /created.*last-scan.*proposed|last-scan.*proposed.*created/is);
  assert.match(lint, /initial-invalid|initially invalid/i);
  assert.match(lint, /physical.*seal|seal.*physical/i);
  assert.match(
    lint,
    /Physically ambiguous scan-marker representations are not repaired by this pass/,
  );
  assert.match(lint, /stop all hosts and correct the marker before rerunning/i);
  assert.match(lint, /reservation-\.prune|reservation.*prune/i);
  assert.equal((lint.match(/^```deep-wiki-exec$/gm) || []).length, 4);
  assert.equal((lint.match(/^<!-- deep-wiki:exec -->$/gm) || []).length, 4);
  assert.match(storage, /transaction recover/);
  assert.match(storage, /stopped-host/);
  assert.match(storage, /direct-child.*metadata.*owner.*directory\s+identity/is);
  assert.match(storage, /non-regular.*recovery/i);
});

test('content catalog metadata documentation is bounded and fail-closed', () => {
  const lint = read('skills/wiki-lint/SKILL.md');
  const storage = read('skills/wiki-schema/references/storage-layout.md');
  const lintParagraph = ignoredMetadataParagraph(lint);
  const storageParagraph = ignoredMetadataParagraph(storage);
  assert.match(lint, /Remaining metadata never blocks\nreaders, so this is reclamation progress, not a repair failure\./);
  assertIgnoredMetadataParagraph(lintParagraph);
  assertIgnoredMetadataParagraph(storageParagraph);
});
