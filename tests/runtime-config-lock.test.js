'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const runtimeModule = (name) => require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', name));
const cli = path.join(repoRoot, 'scripts', 'wiki-runtime.js');
const temporaryRoots = new Set();

function temporaryRoot(prefix = 'deep wiki runtime path with spaces ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function write(pathname, contents) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents);
  return pathname;
}

function makeClock(initial = 0) {
  let value = initial;
  return {
    nowMs: () => value,
    advance: (amount) => { value += amount; },
  };
}

function windowsKey(value) {
  return path.win32.normalize(value).toLowerCase();
}

function virtualWindowsFs({ files = {}, realpaths = {}, directories = [] } = {}) {
  const byteMap = new Map(Object.entries(files).map(([name, value]) => [
    windowsKey(name), Buffer.from(value),
  ]));
  const realMap = new Map(Object.entries(realpaths).map(([name, value]) => [windowsKey(name), value]));
  const dirs = new Set(directories.map(windowsKey));
  const realpathSync = (name) => {
    const key = windowsKey(name);
    if (!realMap.has(key)) {
      const error = new Error(`ENOENT: ${name}`);
      error.code = 'ENOENT';
      throw error;
    }
    return realMap.get(key);
  };
  realpathSync.native = realpathSync;
  return {
    existsSync(name) {
      const key = windowsKey(name);
      return byteMap.has(key) || realMap.has(key) || dirs.has(key);
    },
    readFileSync(name, encoding) {
      const value = byteMap.get(windowsKey(name));
      if (!value) {
        const error = new Error(`ENOENT: ${name}`);
        error.code = 'ENOENT';
        throw error;
      }
      return encoding ? value.toString(encoding) : Buffer.from(value);
    },
    realpathSync,
    lstatSync(name) {
      if (!this.existsSync(name)) {
        const error = new Error(`ENOENT: ${name}`);
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => false, isDirectory: () => dirs.has(windowsKey(name)), isFile: () => !dirs.has(windowsKey(name)) };
    },
  };
}

function canonicalConfig(wikiRoot, overrides = {}) {
  const auto = overrides.autoIngest || {};
  const obsidian = overrides.obsidianCli || {};
  const lines = [
    `wiki_root: "${String(wikiRoot).replaceAll('\\', '\\\\')}"`,
    'auto_ingest:',
    `  ignore_globs: [${(auto.ignoreGlobs || []).map((value) => `"${value}"`).join(', ')}]`,
    `  require_tag: ${auto.requireTag || ''}`,
    'obsidian_cli:',
    `  available: ${obsidian.enabled === true ? 'true' : 'false'}`,
  ];
  if (obsidian.vaultPath) lines.push(`  vault_path: "${String(obsidian.vaultPath).replaceAll('\\', '\\\\')}"`);
  if (obsidian.vaultName) lines.push(`  vault_name: "${obsidian.vaultName}"`);
  if (obsidian.wikiPrefix) lines.push(`  wiki_prefix: "${obsidian.wikiPrefix}"`);
  if (overrides.secretMarker) lines.push(`unknown_secret: ${overrides.secretMarker}`);
  return `${lines.join('\n')}\n`;
}

test('parseConfig accepts BOM, CRLF, quoted Windows paths, Unicode, and filters', () => {
  const { parseConfig } = runtimeModule('config.js');
  const parsed = parseConfig(
    '\uFEFFwiki_root: "C:\\\\Users\\\\민수\\\\Deep Wiki"\r\n'
      + 'auto_ingest:\r\n  ignore_globs: ["archive/**", "초안/*"]\r\n'
      + '  require_tag: project\r\n',
  );
  assert.equal(parsed.wikiRoot, 'C:\\Users\\민수\\Deep Wiki');
  assert.deepEqual(parsed.autoIngest.ignoreGlobs, ['archive/**', '초안/*']);
  assert.equal(parsed.autoIngest.requireTag, 'project');
});

test('config parser unions block, inline, and dotted filters without treating quoted hashes as comments', () => {
  const { parseConfig } = runtimeModule('config.js');
  const parsed = parseConfig([
    "wiki_root: '/vault/# retained' # discarded",
    'auto_ingest.ignore_globs: ["archive/**", "draft/**"]',
    'auto_ingest:',
    '  ignore_globs:',
    "    - '초안/*'",
    '  ignore_globs: ["draft/**", "notes/*"]',
    "  require_tag: 'project#one' # comment",
    'obsidian_cli:',
    '  available: true',
    "  wiki_prefix: 'Deep Wiki'",
  ].join('\n'));
  assert.equal(parsed.wikiRoot, '/vault/# retained');
  assert.deepEqual(parsed.autoIngest.ignoreGlobs, ['archive/**', 'draft/**', '초안/*', 'draft/**', 'notes/*']);
  assert.equal(parsed.autoIngest.requireTag, 'project#one');
  assert.equal(parsed.obsidianCli.available, true);
  assert.equal(parsed.obsidianCli.wikiPrefix, 'Deep Wiki');
});

test('config parser rejects conflicting duplicate supported scalars', () => {
  const { parseConfig } = runtimeModule('config.js');
  assert.throws(
    () => parseConfig('wiki_root: /one\nwiki_root: /two\n'),
    (error) => error.code === 'CONFIG_INVALID' && /wikiRoot/.test(error.message),
  );
  assert.throws(
    () => parseConfig('wiki_root: /one\nauto_ingest:\n  require_tag: a\n  require_tag: b\n'),
    (error) => error.code === 'CONFIG_INVALID' && /autoIngest\.requireTag/.test(error.message),
  );
});

test('config parser rejects every malformed supported-key occurrence while ignoring unknown keys', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'wiki_root /vault',
    'auto_ingest []',
    'auto_ingest.ignore_globs [secret/**]',
    'obsidian_cli true',
    'auto_ingest:\n  ignore_globs [secret/**]',
    'auto_ingest:\n  require_tag project',
    'obsidian_cli:\n  available true',
    'obsidian_cli:\n  vault_path /vault',
    'obsidian_cli:\n  vault_name Main',
    'obsidian_cli:\n  wiki_prefix notes',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
  assert.doesNotThrow(() => parseConfig([
    'unknown_key without-colon',
    'unknown_section:',
    '  unknown_child value',
  ].join('\n')));
});

test('config parser rejects dotted and wrong-context supported leaves', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'auto_ingest.require_tag: project',
    'obsidian_cli.available: true',
    'require_tag: project',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

for (const [sectionName, text] of [
  ['auto_ingest', 'auto_ingest:\n  auto_ingest.require_tag: project'],
  ['obsidian_cli', 'obsidian_cli:\n  obsidian_cli.available: true'],
]) {
  test(`config parser rejects a dotted supported leaf at ${sectionName} child indentation`, () => {
    const { parseConfig } = runtimeModule('config.js');
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  });
}

test('config parser rejects a supported leaf dedented below selected known-section child indentation', () => {
  const { parseConfig } = runtimeModule('config.js');
  assert.throws(
    () => parseConfig('auto_ingest:\n    unknown: value\n  require_tag: project\n'),
    (error) => error.code === 'CONFIG_INVALID',
  );
});

test('config parser ignores supported leaf names inside unknown subtrees', () => {
  const { parseConfig } = runtimeModule('config.js');
  const parsed = parseConfig([
    'wiki_root: /vault',
    'auto_ingest:',
    '  unknown_auto:',
    '    require_tag: nested-secret',
    '    ignore_globs: [nested/**]',
    '  require_tag: project',
    'obsidian_cli:',
    '  unknown_obsidian:',
    '    available: true',
    '    vault_path: /nested-secret',
    '  available: false',
    'unknown_top_level:',
    '  require_tag: ignored',
    '  available: true',
  ].join('\n'));
  assert.equal(parsed.autoIngest.requireTag, 'project');
  assert.deepEqual(parsed.autoIngest.ignoreGlobs, []);
  assert.equal(parsed.obsidianCli.available, false);
  assert.equal(parsed.obsidianCli.vaultPath, null);
});

test('config parser rejects tab or mixed indentation, including top-level supported tokens', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    '\trequire_tag: project',
    '\tauto_ingest:',
    'auto_ingest:\n\trequire_tag: project',
    'auto_ingest:\n\t\tignore_globs: [nested/**]',
    'obsidian_cli:\n \tavailable: true',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser rejects deeper supported leaves outside a genuine unknown mapping subtree', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'auto_ingest:\n  unknown: scalar\n    require_tag: nested-secret',
    'auto_ingest:\n  require_tag: project\n    ignore_globs: [nested/**]',
    'auto_ingest:\n  ignore_globs:\n    - archive/**\n    require_tag: nested-secret',
    'obsidian_cli:\n  available: false\n    vault_path: /nested-secret',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }

  assert.doesNotThrow(() => parseConfig([
    'auto_ingest:',
    '  unknown:',
    '    require_tag: nested-secret',
    '    ignore_globs: [nested/**]',
    '  require_tag: project',
  ].join('\n')));
});

test('config parser rejects space-indented supported tokens without an active known section', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    '  wiki_root: /hidden',
    '  auto_ingest:',
    '  obsidian_cli:',
    'wiki_root: /vault\n  require_tag: hidden',
    'unknown_scalar: opaque\n  wiki_root: /hidden',
    'unknown_inline: [opaque]\n  auto_ingest.require_tag: hidden',
    'auto_ingest:\n  wiki_root: /hidden',
    'auto_ingest:\n  obsidian_cli:',
    'obsidian_cli:\n  auto_ingest:',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser rejects supported-looking entries inside unknown block lists', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'unknown:\n  - require_tag: hidden',
    'unknown:\n  - wiki_root: /hidden',
    'unknown:\n  - auto_ingest.ignore_globs: [hidden/**]',
    'unknown:\n  - ordinary\n    obsidian_cli.available: true',
    'unknown:\n  -\n    obsidian_cli:\n      available: true',
    'auto_ingest:\n  unknown:\n    - require_tag: hidden',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser rejects top-level list items that contain supported config tokens', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    '- wiki_root: /shadow',
    '- auto_ingest:',
    '- obsidian_cli.available: true',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`wiki_root: /vault\n${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser rejects structural supported keys in top-level flow collections but preserves quoted scalar text', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    '- { wiki_root: /shadow }',
    '- [ auto_ingest: { require_tag: shadow } ]',
    '- { "wiki_root": /quoted-key-shadow }',
    "- [ 'auto_ingest': { 'require_tag': quoted-key-shadow } ]",
    '- { ? wiki_root : /explicit-key-shadow }',
    '{ obsidian_cli: { available: true } }',
    '[ { auto_ingest: { ignore_globs: [shadow/**] } } ]',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`wiki_root: /vault\n${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }

  assert.doesNotThrow(() => parseConfig([
    'wiki_root: /vault',
    '- "wiki_root: /quoted-literal"',
    "- 'auto_ingest: { require_tag: quoted-literal }'",
    'unknown_scalar: "{ obsidian_cli: { available: true } }"',
    'unknown_mapping:',
    '  wiki_root: /genuine-unknown-descendant',
  ].join('\n')));
});

test('config parser rejects quoted and explicit supported keys in block mappings', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    '"wiki_root": /shadow',
    "'auto_ingest': {}",
    '? wiki_root\n: /shadow',
    '? "obsidian_cli"\n: {}',
    'auto_ingest:\n  "require_tag": shadow',
    'obsidian_cli:\n  ? available\n  : true',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`wiki_root: /vault\n${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }

  assert.doesNotThrow(() => parseConfig([
    'wiki_root: /vault',
    'quoted_literal: "wiki_root: /not-a-key"',
    'unknown_mapping:',
    '  "wiki_root": /genuine-unknown-descendant',
  ].join('\n')));
});

test('config parser rejects duplicate explicit unknown keys at root and both known sections', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    [
      'wiki_root: /vault',
      '? custom_key',
      ': one',
      '? custom_key',
      ': two',
    ].join('\n'),
    [
      'wiki_root: /vault',
      'auto_ingest:',
      '  ? custom_key',
      '  : one',
      '  ? custom_key',
      '  : two',
    ].join('\n'),
    [
      'wiki_root: /vault',
      'obsidian_cli:',
      '  ? custom_key',
      '  : one',
      '  ? custom_key',
      '  : two',
    ].join('\n'),
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }

  assert.doesNotThrow(() => parseConfig([
    'wiki_root: /vault',
    '? root_one',
    ': one',
    '? root_two',
    ': two',
    'auto_ingest:',
    '  ? auto_one',
    '  : one',
    '  ? auto_two',
    '  : two',
    'obsidian_cli:',
    '  ? obsidian_one',
    '  : one',
    '  ? obsidian_two',
    '  : two',
  ].join('\n')));
});

test('config parser rejects supported keys hidden by YAML node properties in supported-subset contexts', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'wiki_root: /vault\n!!str wiki_root: /shadow',
    'wiki_root: /vault\n!!str "wiki_root": /shadow',
    "wiki_root: /vault\n&shadow 'wiki_root': /shadow",
    'wiki_root: /vault\n!<tag:yaml.org,2002:str> &shadow wiki_root: /shadow',
    'wiki_root: /vault\n!!map auto_ingest:\n  require_tag: hidden',
    'wiki_root: /vault\nauto_ingest:\n  require_tag: project\n  !!str require_tag: shadow',
    'wiki_root: /vault\nauto_ingest:\n  &shadow "ignore_globs": [shadow/**]',
    'wiki_root: /vault\nobsidian_cli:\n  available: true\n  !!str available: false',
    'wiki_root: /vault\nobsidian_cli:\n  !<tag:yaml.org,2002:str> &shadow "vault_name": hidden',
    'wiki_root: /vault\n? !!str "wiki_root"\n: /shadow',
    'wiki_root: /vault\n- !!str wiki_root: /shadow',
    'wiki_root: /vault\nauto_ingest:\n  - &shadow require_tag: shadow',
    'wiki_root: /vault\nunknown_list:\n  - !!str wiki_root: /shadow',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser keeps node-property-looking quoted literals and genuine unknown mapping subtrees opaque', () => {
  const { parseConfig } = runtimeModule('config.js');
  const parsed = parseConfig([
    'wiki_root: /vault',
    'literal: "!!str wiki_root: /not-a-key"',
    'unknown_mapping:',
    '  !!str wiki_root: /genuine-unknown-descendant',
    '  &shadow "require_tag": opaque',
    'auto_ingest:',
    '  require_tag: project',
    '  unknown_mapping:',
    '    !<tag:yaml.org,2002:str> require_tag: opaque',
  ].join('\n'));
  assert.equal(parsed.wikiRoot, '/vault');
  assert.equal(parsed.autoIngest.requireTag, 'project');
});

test('config parser rejects YAML alias and merge mapping keys in supported-subset contexts', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    [
      'wiki_root: /vault',
      'anchor_source: &key wiki_root',
      '*key: /shadow',
    ].join('\n'),
    [
      'wiki_root: /vault',
      'shadow_defaults: &defaults',
      '  wiki_root: /shadow',
      '<<: *defaults',
    ].join('\n'),
    [
      'wiki_root: /vault',
      'auto_ingest:',
      '  anchor_source: &key require_tag',
      '  *key: shadow',
    ].join('\n'),
    [
      'wiki_root: /vault',
      'obsidian_cli:',
      '  shadow_defaults: &defaults',
      '    available: true',
      '  <<: *defaults',
    ].join('\n'),
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }

  assert.doesNotThrow(() => parseConfig([
    'wiki_root: /vault',
    'quoted_literal: "*key: /not-a-key"',
    'unknown_mapping:',
    '  wiki_root: /genuine-unknown-descendant',
    '  alias_literal: "*key: /not-a-key"',
  ].join('\n')));
});

test('config parser rejects quoted merge keys for both standard tags regardless of node-property order', () => {
  const { parseConfig } = runtimeModule('config.js');
  const tags = ['!!merge', '!<tag:yaml.org,2002:merge>'];
  const propertyOrders = [
    (tag) => `&marker ${tag}`,
    (tag) => `${tag} &marker`,
  ];
  for (const tag of tags) {
    for (const properties of propertyOrders) {
      const text = [
        'wiki_root: /vault',
        'defaults: &defaults { require_tag: shadow }',
        'auto_ingest:',
        `  ${properties(tag)} "<<": *defaults`,
      ].join('\n');
      assert.throws(
        () => parseConfig(`${text}\n`),
        (error) => error.code === 'CONFIG_INVALID',
        text,
      );
    }
  }

  assert.doesNotThrow(() => parseConfig([
    'wiki_root: /vault',
    'quoted_literal: \'&marker !!merge "<<": *defaults\'',
    'unknown_mapping:',
    '  require_tag: genuine-unknown-descendant',
  ].join('\n')));
});

function explicitTwoLineMergeForms() {
  return [
    ['plain', '<<'],
    ['short-anchor-first', '&marker !!merge "<<"'],
    ['short-tag-first', '!!merge &marker "<<"'],
    ['verbatim-anchor-first', '&marker !<tag:yaml.org,2002:merge> "<<"'],
    ['verbatim-tag-first', '!<tag:yaml.org,2002:merge> &marker "<<"'],
  ];
}

test('config parser rejects explicit two-line merge keys at root and both known sections', () => {
  const { parseConfig } = runtimeModule('config.js');
  const contexts = [
    ['root', (key) => [
      'wiki_root: /vault',
      'defaults: &defaults { auto_ingest: { require_tag: shadow } }',
      `? ${key}`,
      ': *defaults',
    ]],
    ['auto_ingest', (key) => [
      'wiki_root: /vault',
      'defaults: &defaults { require_tag: shadow }',
      'auto_ingest:',
      '  ignore_globs: []',
      `  ? ${key}`,
      '  : *defaults',
    ]],
    ['obsidian_cli', (key) => [
      'wiki_root: /vault',
      'defaults: &defaults { available: true }',
      'obsidian_cli:',
      `  ? ${key}`,
      '  : *defaults',
    ]],
  ];
  for (const [context, document] of contexts) {
    for (const [form, key] of explicitTwoLineMergeForms()) {
      const text = document(key).join('\n');
      assert.throws(
        () => parseConfig(`${text}\n`),
        (error) => error.code === 'CONFIG_INVALID',
        `${context}/${form}\n${text}`,
      );
    }
  }
});

test('config parser rejects an unknown container that switches from mapping entries to list items', () => {
  const { parseConfig } = runtimeModule('config.js');
  const malformed = [
    'unknown:\n  harmless: ok\n  - wiki_root: /shadow',
    'auto_ingest:\n  unknown:\n    harmless: ok\n    - require_tag: hidden',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseConfig(`wiki_root: /vault\n${text}\n`),
      (error) => error.code === 'CONFIG_INVALID',
      text,
    );
  }
});

test('config parser preserves genuine unknown mappings, ordinary unknown lists, and known lists', () => {
  const { parseConfig } = runtimeModule('config.js');
  const parsed = parseConfig([
    'wiki_root: "C:\\\\Users\\\\민수\\\\Deep Wiki"',
    'unknown_mapping:',
    '  require_tag: ignored',
    '  child:',
    '    wiki_root: /also-ignored',
    'unknown_list:',
    '  - ordinary',
    '  - values',
    'auto_ingest:',
    '  unknown_mapping:',
    '    require_tag: nested-secret',
    '  ignore_globs:',
    '    - archive/**',
    '    - 초안/*',
    '  require_tag: project',
  ].join('\r\n'));
  assert.equal(parsed.wikiRoot, 'C:\\Users\\민수\\Deep Wiki');
  assert.deepEqual(parsed.autoIngest.ignoreGlobs, ['archive/**', '초안/*']);
  assert.equal(parsed.autoIngest.requireTag, 'project');
});

test('normalizeWikiRoot preserves native drive and UNC roots on win32', () => {
  const { normalizeWikiRoot } = runtimeModule('config.js');
  assert.equal(
    normalizeWikiRoot('C:\\Users\\민수\\Deep Wiki', 'win32', 'C:\\Users\\민수'),
    'C:\\Users\\민수\\Deep Wiki',
  );
  assert.equal(
    normalizeWikiRoot('\\\\server\\share\\위키', 'win32', 'C:\\Users\\민수'),
    '\\\\server\\share\\위키',
  );
  assert.equal(
    normalizeWikiRoot('~\\Deep Wiki', 'win32', 'C:\\Users\\민수'),
    'C:\\Users\\민수\\Deep Wiki',
  );
});

test('Windows resolves HOME before USERPROFILE and writes each host only to its canonical target', () => {
  const { resolveHome, resolveConfigWriteTarget } = runtimeModule('config.js');
  const env = { HOME: 'D:\\Home Override', USERPROFILE: 'C:\\Users\\Min', CODEX_HOME: 'E:\\Codex Data' };
  assert.equal(resolveHome(env, 'win32'), 'D:\\Home Override');
  assert.equal(resolveHome({ USERPROFILE: 'C:\\Users\\Min' }, 'win32'), 'C:\\Users\\Min');
  assert.equal(resolveConfigWriteTarget(env, 'codex', { platform: 'win32' }), 'E:\\Codex Data\\deep-wiki-config.yaml');
  assert.equal(resolveConfigWriteTarget(env, 'claude', { platform: 'win32' }), 'D:\\Home Override\\.claude\\deep-wiki-config.yaml');
  assert.throws(() => resolveHome({ HOME: 'relative' }, 'win32'), /absolute/i);
});

test('Codex config-write target accepts absolute CODEX_HOME without home and rejects cwd-relative targets', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  assert.equal(
    resolveConfigWriteTarget({ CODEX_HOME: 'E:\\Codex Data' }, 'codex', { platform: 'win32' }),
    'E:\\Codex Data\\deep-wiki-config.yaml',
  );
  assert.equal(
    resolveConfigWriteTarget({ CODEX_HOME: '~\\Codex Data', USERPROFILE: 'C:\\Users\\Min' }, 'codex', { platform: 'win32' }),
    'C:\\Users\\Min\\Codex Data\\deep-wiki-config.yaml',
  );
  assert.throws(
    () => resolveConfigWriteTarget({ CODEX_HOME: 'relative-codex-home' }, 'codex', { platform: 'win32' }),
    (error) => error.code === 'CONFIG_INVALID' && /absolute/i.test(error.message),
  );
});

test('config candidate priority materializes explicit, CODEX_HOME, home Codex, and legacy Claude independently', () => {
  const { resolveConfig } = runtimeModule('config.js');
  const wikiRoot = temporaryRoot('deep wiki config physical root ');

  const explicitBase = temporaryRoot('deep wiki explicit config ');
  const explicit = write(path.join(explicitBase, 'explicit.yaml'), canonicalConfig(wikiRoot));
  assert.equal(resolveConfig({ DEEP_WIKI_CONFIG: explicit, HOME: explicitBase }).path, fs.realpathSync(explicit));

  const codexBase = temporaryRoot('deep wiki CODEX_HOME config ');
  const codexHome = path.join(codexBase, 'codex home');
  const codexConfig = write(path.join(codexHome, 'deep-wiki-config.yaml'), canonicalConfig(wikiRoot));
  assert.equal(resolveConfig({ CODEX_HOME: codexHome, HOME: codexBase }).path, fs.realpathSync(codexConfig));

  const homeCodexBase = temporaryRoot('deep wiki home codex config ');
  const homeCodexConfig = write(path.join(homeCodexBase, '.codex', 'deep-wiki-config.yaml'), canonicalConfig(wikiRoot));
  assert.equal(resolveConfig({ HOME: homeCodexBase }).path, fs.realpathSync(homeCodexConfig));

  const legacyBase = temporaryRoot('deep wiki legacy claude config ');
  const legacyConfig = write(path.join(legacyBase, '.claude', 'deep-wiki-config.yaml'), canonicalConfig(wikiRoot));
  assert.equal(resolveConfig({ HOME: legacyBase, CODEX_HOME: path.join(legacyBase, 'missing') }).path, fs.realpathSync(legacyConfig));
});

test('config aliases across three and four candidates require complete semantic equality', () => {
  const { resolveConfig } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki four aliases ');
  const wikiRoot = path.join(root, 'Wiki Root');
  const vault = path.join(root, 'Vault Root');
  fs.mkdirSync(wikiRoot);
  fs.mkdirSync(vault);
  const codexHome = path.join(root, 'Codex Home');
  const explicit = path.join(root, 'explicit.yaml');
  const candidates = [
    explicit,
    path.join(codexHome, 'deep-wiki-config.yaml'),
    path.join(root, '.codex', 'deep-wiki-config.yaml'),
    path.join(root, '.claude', 'deep-wiki-config.yaml'),
  ];
  const semantics = {
    autoIngest: { requireTag: 'project', ignoreGlobs: ['초안/*', 'archive/**'] },
    obsidianCli: { enabled: true, vaultPath: vault, vaultName: 'Main', wikiPrefix: 'notes/.' },
  };
  write(candidates[0], `\uFEFF${canonicalConfig(path.join(wikiRoot, '.'), semantics).replaceAll('\n', '\r\n')}`);
  write(candidates[1], canonicalConfig(wikiRoot, {
    autoIngest: { requireTag: ' project ', ignoreGlobs: ['archive/**', '초안/*', 'archive/**'] },
    obsidianCli: { ...semantics.obsidianCli, wikiPrefix: 'notes' },
  }));
  write(candidates[2], canonicalConfig(wikiRoot, semantics));
  write(candidates[3], canonicalConfig(wikiRoot, semantics));
  const env = { DEEP_WIKI_CONFIG: explicit, CODEX_HOME: codexHome, HOME: root };
  assert.equal(resolveConfig(env).path, fs.realpathSync(explicit));
  fs.rmSync(candidates[0]);
  assert.equal(resolveConfig(env).path, fs.realpathSync(candidates[1]));

  write(candidates[3], canonicalConfig(wikiRoot, {
    ...semantics,
    autoIngest: { ...semantics.autoIngest, requireTag: 'different' },
  }));
  assert.throws(() => resolveConfig(env), (error) => error.code === 'CONFIG_CONFLICT');
});

test('config pairwise conflicts disclose stable labels and key paths but no values or secrets', () => {
  const { resolveConfig } = runtimeModule('config.js');
  const fields = [
    ['autoIngest.requireTag', { autoIngest: { requireTag: 'one' } }, { autoIngest: { requireTag: 'two' } }],
    ['autoIngest.ignoreGlobs', { autoIngest: { ignoreGlobs: ['one/*'] } }, { autoIngest: { ignoreGlobs: ['two/*'] } }],
    ['obsidianCli.enabled', { obsidianCli: { enabled: false } }, { obsidianCli: { enabled: true } }],
    ['obsidianCli.vaultPath', { obsidianCli: { vaultPath: 'vault-a' } }, { obsidianCli: { vaultPath: 'vault-b' } }],
    ['obsidianCli.vaultName', { obsidianCli: { vaultName: 'one' } }, { obsidianCli: { vaultName: 'two' } }],
    ['obsidianCli.wikiPrefix', { obsidianCli: { wikiPrefix: 'one' } }, { obsidianCli: { wikiPrefix: 'two' } }],
  ];
  for (const [keyPath, left, right] of fields) {
    const base = temporaryRoot('deep wiki config conflict ');
    const wikiRoot = path.join(base, 'wiki');
    const vaultA = path.join(base, 'vault-a');
    const vaultB = path.join(base, 'vault-b');
    fs.mkdirSync(wikiRoot);
    fs.mkdirSync(vaultA);
    fs.mkdirSync(vaultB);
    const explicit = write(path.join(base, 'explicit.yaml'), canonicalConfig(wikiRoot, {
      ...left,
      obsidianCli: { ...(left.obsidianCli || {}), vaultPath: left.obsidianCli?.vaultPath ? path.join(base, left.obsidianCli.vaultPath) : undefined },
      secretMarker: 'secret-marker',
    }));
    const codexHome = path.join(base, 'codex');
    write(path.join(codexHome, 'deep-wiki-config.yaml'), canonicalConfig(wikiRoot, {
      ...right,
      obsidianCli: { ...(right.obsidianCli || {}), vaultPath: right.obsidianCli?.vaultPath ? path.join(base, right.obsidianCli.vaultPath) : undefined },
      secretMarker: 'secret-marker',
    }));
    assert.throws(
      () => resolveConfig({ DEEP_WIKI_CONFIG: explicit, CODEX_HOME: codexHome, HOME: base }),
      (error) => error.code === 'CONFIG_CONFLICT'
        && error.message.includes('explicit')
        && error.message.includes('codex_home')
        && error.message.includes(keyPath)
        && !error.message.includes(base)
        && !error.message.includes('secret-marker')
        && !error.message.includes('one/*')
        && !error.message.includes('two/*'),
    );
  }
});

test('Windows config aliases de-duplicate canonical paths and compare two extant physical roots case-insensitively', () => {
  const { resolveConfig } = runtimeModule('config.js');
  const explicit = 'C:\\Config\\explicit.yaml';
  const codexHome = 'D:\\Codex Home';
  const codexConfig = 'D:\\Codex Home\\deep-wiki-config.yaml';
  const wikiA = 'C:\\Users\\Min\\Wiki\\.';
  const wikiB = 'c:\\users\\MIN\\wiki';
  const wikiPhysical = 'C:\\Users\\MIN\\Wiki';
  const configA = canonicalConfig(wikiA, { autoIngest: { ignoreGlobs: ['b/**', 'a/*', 'a/*'] } });
  const configB = canonicalConfig(wikiB, { autoIngest: { ignoreGlobs: ['a/*', 'b/**'] } });
  const injectedFs = virtualWindowsFs({
    files: { [explicit]: configA, [codexConfig]: configB },
    realpaths: {
      [explicit]: explicit,
      [codexConfig]: codexConfig,
      [wikiA]: wikiPhysical,
      [wikiB]: wikiPhysical,
    },
    directories: [wikiA, wikiB],
  });
  const result = resolveConfig({ DEEP_WIKI_CONFIG: explicit, CODEX_HOME: codexHome, HOME: 'C:\\Users\\Min' }, {
    platform: 'win32', fs: injectedFs,
  });
  assert.equal(result.path, explicit);
  assert.equal(result.config.wikiRoot, wikiPhysical);
  assert.deepEqual(result.config.autoIngest.ignoreGlobs, ['a/*', 'b/**']);
});

test('config normalization deep-freezes the complete supported semantic object', () => {
  const { parseConfig, normalizeConfigSemantics } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki normalized config ');
  const value = normalizeConfigSemantics(parseConfig(canonicalConfig(root, {
    autoIngest: { requireTag: ' project ', ignoreGlobs: ['z/*', 'a/**', 'z/*'] },
    obsidianCli: { enabled: false },
  })), { platform: process.platform, fs, home: os.homedir() });
  assert.deepEqual(value, {
    wikiRoot: fs.realpathSync.native(root),
    autoIngest: { requireTag: 'project', ignoreGlobs: ['a/**', 'z/*'] },
    obsidianCli: { enabled: false, vaultPath: null, vaultName: null, wikiPrefix: null },
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.autoIngest), true);
  assert.equal(Object.isFrozen(value.autoIngest.ignoreGlobs), true);
  assert.equal(Object.isFrozen(value.obsidianCli), true);
});

test('config normalization rejects absolute, drive-qualified, UNC, NUL, and pre-normalization traversal wiki prefixes', () => {
  const { normalizeConfigSemantics } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki prefix root ');
  const rejected = [
    '/outside',
    'C:\\outside',
    'C:/outside',
    'C:drive-relative',
    '\\\\server\\share\\outside',
    '//server/share/outside',
    'notes/../outside',
    'notes\\..\\outside',
    'notes\0outside',
  ];
  for (const wikiPrefix of rejected) {
    assert.throws(() => normalizeConfigSemantics({
      wikiRoot: root,
      autoIngest: { ignoreGlobs: [], requireTag: null },
      obsidianCli: { available: false, vaultPath: null, vaultName: null, wikiPrefix },
    }, { platform: process.platform, fs, home: os.homedir() }),
    (error) => error.code === 'CONFIG_INVALID', wikiPrefix);
  }
});

test('config normalization rejects dot-prefixed drive-qualified wiki prefixes on every platform', () => {
  const { normalizeConfigSemantics } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki normalized drive prefix ');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const wikiRoot = platform === 'win32' ? 'D:\\Wiki' : root;
    const home = platform === 'win32' ? 'C:\\Users\\Min' : os.homedir();
    for (const wikiPrefix of ['./C:outside', '.\\C:outside']) {
      assert.throws(() => normalizeConfigSemantics({
        wikiRoot,
        autoIngest: { ignoreGlobs: [], requireTag: null },
        obsidianCli: { available: false, vaultPath: null, vaultName: null, wikiPrefix },
      }, { platform, fs, home }), (error) => error.code === 'CONFIG_INVALID', `${platform}: ${wikiPrefix}`);
    }
  }
});

test('config portable glob and frontmatter tags preserve legacy broad wildcard semantics', () => {
  const { compilePortableGlob, readFrontmatterTags } = runtimeModule('config.js');
  const { createDeadline } = runtimeModule('deadline.js');
  for (const pattern of ['Home/Daily/*', 'Home/Daily/**']) {
    assert.equal(compilePortableGlob(pattern).test('Home/Daily/2026/entry.md'), true);
  }
  assert.equal(compilePortableGlob('archive/*').test('live/archive.md'), false);
  const root = temporaryRoot('deep wiki frontmatter ');
  const inline = write(path.join(root, 'inline.md'), '---\r\ntags: [project, "한글"]\r\n---\r\nbody\r\n');
  const block = write(path.join(root, 'block.md'), '---\ntags:\n  - project\n  - 초안\n---\nbody\n');
  assert.deepEqual(readFrontmatterTags(inline, { deadline: createDeadline({ budgetMs: 12_000 }) }), ['project', '한글']);
  assert.deepEqual(readFrontmatterTags(block, { deadline: createDeadline({ budgetMs: 12_000 }) }), ['project', '초안']);
});

test('UNC walkFiles observes an injected deadline at directory and file boundaries', () => {
  const { walkFiles } = runtimeModule('fs-safe.js');
  const { createDeadline } = runtimeModule('deadline.js');
  const clock = makeClock(0);
  const root = '\\\\server\\share\\Vault Space';
  const child = `${root}\\자료`;
  const fakeFs = {
    readdirSync(directory) {
      if (directory === root) {
        clock.advance(6_000);
        return [{ name: '자료', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }];
      }
      if (directory === child) {
        clock.advance(6_001);
        return [{ name: '노트.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }];
      }
      throw new Error(`unexpected directory ${directory}`);
    },
  };
  assert.throws(() => walkFiles(root, {
    platform: 'win32', clock, deadline: createDeadline({ clock, budgetMs: 12_000 }), fs: fakeFs,
  }), (error) => error.code === 'DEADLINE_EXCEEDED' && /directory|file/.test(error.boundary));
});

test('deadline budgets are monotonic, mandatory, and bounded to twelve seconds', () => {
  const { createDeadline, assertBeforeDeadline, DeadlineExceeded } = runtimeModule('deadline.js');
  const clock = makeClock(100);
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  assertBeforeDeadline(deadline, 'directory:root');
  clock.advance(12_001);
  assert.throws(() => assertBeforeDeadline(deadline, 'file:note.md'), (error) =>
    error instanceof DeadlineExceeded
      && error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === 'file:note.md');
  assert.throws(() => createDeadline({ clock, budgetMs: 12_001 }), /12_000|12000/);
  assert.throws(() => createDeadline({ clock, budgetMs: 0 }), /budget/i);
});

test('frontmatter deadline is checked before opening and at every logical line boundary', () => {
  const { readFrontmatterTags } = runtimeModule('config.js');
  const { createDeadline } = runtimeModule('deadline.js');
  let current = 0;
  let afterRead = false;
  const clock = {
    nowMs() {
      if (afterRead) current += 1;
      return current;
    },
  };
  const file = 'virtual.md';
  const contents = Buffer.from('---\nkey: value\ntags:\n  - project\n---\n');
  let position = 0;
  const fakeFs = {
    readFileSync() {
      throw new Error('whole-file fallback is prohibited');
    },
    openSync(name) {
      assert.equal(name, file);
      return 7;
    },
    readSync(descriptor, buffer, offset, length) {
      assert.equal(descriptor, 7);
      if (position >= contents.length) return 0;
      const count = Math.min(length, contents.length - position);
      contents.copy(buffer, offset, position, position + count);
      position += count;
      if (contents[position - 1] === 0x0a) {
        current = 11_998;
        afterRead = true;
      }
      return count;
    },
    closeSync(descriptor) { assert.equal(descriptor, 7); },
  };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  assert.throws(() => readFrontmatterTags(file, { fs: fakeFs, clock, deadline }),
    (error) => error.code === 'DEADLINE_EXCEEDED' && /line/.test(error.boundary));
});

test('config frontmatter reader stops after at most 200 logical lines without an unbounded whole-file read', () => {
  const { readFrontmatterTags } = runtimeModule('config.js');
  const { createDeadline } = runtimeModule('deadline.js');
  const contents = Buffer.from(`---\ntags: [project]\n${'ignored: value\n'.repeat(10_000)}`);
  let position = 0;
  let closed = false;
  const fakeFs = {
    readFileSync() { throw new Error('unbounded whole-file read prohibited'); },
    openSync() { return 7; },
    readSync(descriptor, buffer, offset, length) {
      assert.equal(descriptor, 7);
      if (position >= contents.length) return 0;
      const count = Math.min(length, contents.length - position);
      contents.copy(buffer, offset, position, position + count);
      position += count;
      return count;
    },
    closeSync(descriptor) { assert.equal(descriptor, 7); closed = true; },
  };
  assert.deepEqual(readFrontmatterTags('virtual-large.md', {
    fs: fakeFs, deadline: createDeadline({ budgetMs: 12_000 }),
  }), ['project']);
  assert.equal(closed, true);
  assert.equal(position < contents.length, true);
});

test('frontmatter reader fails closed when only an unbounded whole-file adapter is available', () => {
  const { readFrontmatterTags } = runtimeModule('config.js');
  const { createDeadline } = runtimeModule('deadline.js');
  let wholeFileReads = 0;
  const fakeFs = {
    readFileSync() {
      wholeFileReads += 1;
      return Buffer.from(`---\ntags: [project]\n${'ignored: value\n'.repeat(10_000)}`);
    },
  };
  assert.throws(() => readFrontmatterTags('virtual-unbounded.md', {
    fs: fakeFs,
    deadline: createDeadline({ budgetMs: 12_000 }),
  }), (error) => error.code === 'CONFIG_INVALID' && /bounded|stream/i.test(error.message));
  assert.equal(wholeFileReads, 0);
});

test('atomicWriteFile replaces a file under a spaces and Unicode path', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic ');
  const file = path.join(root, 'Deep Wiki 테스트', '.wiki-meta', '.last-scan');
  atomicWriteFile(file, '2026-07-11T00:00:00Z\n');
  atomicWriteFile(file, '2026-07-11T01:00:00Z\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-07-11T01:00:00Z\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp.')), []);
});

test('atomicWriteFile runs the final publication guard after temp identity validation', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic final publication guard ');
  const destination = path.join(root, 'destination');
  const events = [];
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (pathname, options) => {
          if (String(pathname).includes('.tmp.')) events.push('identity');
          return target.lstatSync(pathname, options);
        };
      }
      if (property === 'renameSync') {
        return (source, targetPath) => {
          events.push('rename');
          return target.renameSync(source, targetPath);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  atomicWriteFile(destination, 'published\n', {
    fs: guardedFs,
    beforeRename() { events.push('before-rename'); },
    beforePublish() { events.push('before-publish'); },
  });
  assert.deepEqual(events, ['before-rename', 'identity', 'before-publish', 'rename']);
});

test('atomicWriteFile removes only its own temp file when destination rename fails', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic failure ');
  const destination = path.join(root, 'destination-is-directory');
  fs.mkdirSync(destination);
  assert.throws(() => atomicWriteFile(destination, 'must not land'));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp.')), []);
});

test('atomicWriteFile preserves a foreign same-path temp replacement when the pre-publication seam throws', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic foreign cleanup ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  let temporary;
  assert.throws(() => atomicWriteFile(destination, 'owned\n', {
    beforeRename(paths) {
      temporary = paths.temporary;
      fs.rmSync(temporary);
      fs.writeFileSync(temporary, 'foreign\n');
      const error = new Error('injected pre-publication failure');
      error.code = 'EIO';
      throw error;
    },
  }), /pre-publication failure/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign\n');
});

test('atomicWriteFile refuses to publish a foreign same-path temp replacement', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic foreign publication ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  let temporary;
  assert.throws(() => atomicWriteFile(destination, 'owned\n', {
    beforeRename(paths) {
      temporary = paths.temporary;
      fs.rmSync(temporary);
      fs.writeFileSync(temporary, 'foreign\n');
    },
  }), /identity|ownership/i);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign\n');
});

test('atomicWriteFile rejects a reused inode with a changed birth-time generation', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic reused inode generation ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  let replaced = false;
  let temporary;
  const generationFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          ino: 11n,
          birthtimeNs: 100n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          ino: 11n,
          birthtimeNs: replaced ? 200n : 100n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(() => atomicWriteFile(destination, 'owned\n', {
    fs: generationFs,
    beforeRename(paths) {
      temporary = paths.temporary;
      fs.rmSync(temporary);
      fs.writeFileSync(temporary, 'foreign\n');
      replaced = true;
    },
  }), /identity|ownership/i);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign\n');
});

test('atomicWriteFile rejects genuinely different devices with matching inode identity', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic distinct devices ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  const distinctDeviceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          dev: 6n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          dev: 5n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(
    () => atomicWriteFile(destination, 'owned\n', { fs: distinctDeviceFs }),
    /identity|ownership/i,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
});

test('atomicWriteFile accepts an lstat dev zero with a nonzero fstat dev', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic asymmetric dev zero ');
  const destination = path.join(root, 'destination');
  const asymmetricFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          dev: 0x12345678n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          dev: 0n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  atomicWriteFile(destination, 'owned\n', { fs: asymmetricFs });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'owned\n');
});

test('atomicWriteFile accepts 64-bit lstat dev with a truncated fstat dev', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic truncated dev ');
  const destination = path.join(root, 'destination');
  const asymmetricFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          dev: 0xabcdef01n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          dev: 0x12345678abcdef01n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  atomicWriteFile(destination, 'owned\n', { fs: asymmetricFs });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'owned\n');
});

test('atomicWriteFile rejects a non-truncated fstat dev whose low 32 bits merely coincide with lstat dev', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic non-truncated fstat dev ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  const coincidentalLowBitsFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          dev: 0x100000005n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          dev: 5n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(
    () => atomicWriteFile(destination, 'owned\n', { fs: coincidentalLowBitsFs }),
    /identity|ownership/i,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
});

test('acquireLock accepts an lstat dev zero with a nonzero fstat dev', () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki lock asymmetric dev zero ');
  const asymmetricFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => ({
          ...target.fstatSync(descriptor, options),
          dev: 0x12345678n,
        });
      }
      if (property === 'lstatSync') {
        return (pathname, options) => ({
          ...target.lstatSync(pathname, options),
          dev: 0n,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const owner = acquireLock({
    wikiRoot,
    operation: 'asymmetric-device-identity',
    fs: asymmetricFs,
  });
  assert.equal(owner.operation, 'asymmetric-device-identity');
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json'),
    'utf8',
  )).token, owner.token);
});

test('atomicWriteFile accepts Windows-style dev zero only with a nonzero inode identity', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic dev zero ');
  const destination = path.join(root, 'destination');
  let fstatCalls = 0;
  let lstatCalls = 0;
  const zeroDeviceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => {
          fstatCalls += 1;
          const stat = target.fstatSync(descriptor, options);
          return { ...stat, dev: 0n, ino: BigInt(stat.ino) };
        };
      }
      if (property === 'lstatSync') {
        return (pathname, options) => {
          lstatCalls += 1;
          const stat = target.lstatSync(pathname, options);
          return { ...stat, dev: 0n, ino: BigInt(stat.ino) };
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  atomicWriteFile(destination, 'owned\n', { fs: zeroDeviceFs });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'owned\n');
  assert.equal(fstatCalls, 1);
  assert.ok(lstatCalls >= 1);
});

test('atomicWriteFile fails closed when the created temp has no stable inode identity', () => {
  const { atomicWriteFile } = runtimeModule('fs-safe.js');
  const root = temporaryRoot('deep wiki atomic missing identity ');
  const destination = write(path.join(root, 'destination'), 'original\n');
  const missingIdentityFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (descriptor, options) => {
          const stat = target.fstatSync(descriptor, options);
          return { ...stat, dev: 0n, ino: 0n };
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(
    () => atomicWriteFile(destination, 'owned\n', { fs: missingIdentityFs }),
    /identity/i,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original\n');
});

test('atomic helpers normalize safe relative paths, hash exact bytes, and parse page frontmatter', () => {
  const { normalizeRelativePath, sha256, parsePageFrontmatter } = runtimeModule('fs-safe.js');
  assert.equal(normalizeRelativePath('pages\\한글.md', 'win32'), 'pages/한글.md');
  assert.throws(() => normalizeRelativePath('../outside.md', 'linux'), /relative|traversal/i);
  assert.throws(() => normalizeRelativePath('C:\\outside.md', 'win32'), /relative|absolute/i);
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.throws(
      () => normalizeRelativePath('C:outside.md', platform),
      /drive|relative/i,
      platform,
    );
    for (const candidate of ['./C:outside.md', '.\\C:outside.md']) {
      assert.throws(
        () => normalizeRelativePath(candidate, platform),
        /drive|relative/i,
        `${platform}: ${candidate}`,
      );
    }
  }
  const escaped = path.win32.resolve('D:\\Wiki', path.posix.normalize('./C:outside.md'));
  assert.equal(path.win32.isAbsolute(path.win32.relative('D:\\Wiki', escaped)), true);
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepEqual(parsePageFrontmatter('---\r\ntitle: "한글"\r\nsources: [a, b]\r\ntags:\r\n  - one\r\n---\r\n# Body\r\n'), {
    title: '한글', sources: ['a', 'b'], tags: ['one'], body: '# Body\r\n',
  });
});

test('walkFiles is deterministic, slash-relative, and never follows symlinks', () => {
  const { walkFiles } = runtimeModule('fs-safe.js');
  const { createDeadline } = runtimeModule('deadline.js');
  const root = temporaryRoot('deep wiki walk ');
  fs.mkdirSync(path.join(root, 'z-dir'));
  fs.mkdirSync(path.join(root, 'a-dir'));
  write(path.join(root, 'z-dir', '나.md'), 'z');
  write(path.join(root, 'a-dir', 'a.md'), 'a');
  fs.symlinkSync(path.join(root, 'z-dir'), path.join(root, 'linked-dir'));
  assert.deepEqual(walkFiles(root, { deadline: createDeadline({ budgetMs: 12_000 }) }), ['a-dir/a.md', 'z-dir/나.md']);
});

test('config-write targets ignore DEEP_WIKI_CONFIG and atomically create host-owned files', () => {
  const { resolveConfigWriteTarget, resolveConfig } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki config write ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const explicit = write(path.join(root, 'explicit.yaml'), canonicalConfig(wikiRoot, { secretMarker: 'secret-marker' }));
  const explicitBefore = fs.readFileSync(explicit);
  const env = { HOME: root, CODEX_HOME: path.join(root, 'codex home'), DEEP_WIKI_CONFIG: explicit };
  const codexTarget = resolveConfigWriteTarget(env, 'codex');
  const claudeTarget = resolveConfigWriteTarget(env, 'claude');
  assert.notEqual(codexTarget, explicit);
  assert.notEqual(claudeTarget, explicit);
  assert.deepEqual(resolveConfigWriteTarget(env, 'codex', {
    desiredConfigText: canonicalConfig(wikiRoot),
  }), { path: codexTarget, status: 'created' });
  assert.deepEqual(resolveConfigWriteTarget(env, 'claude', {
    desiredConfigText: canonicalConfig(wikiRoot),
  }), { path: claudeTarget, status: 'created' });
  assert.deepEqual(fs.readFileSync(explicit), explicitBefore);
  assert.equal(resolveConfig({ ...env, DEEP_WIKI_CONFIG: '' }).path, fs.realpathSync(codexTarget));
});

test('config-write semantic aliases stay byte-identical and conflicting supported fields are rejected before replacement', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki config write conflict ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = write(path.join(root, '.codex', 'deep-wiki-config.yaml'), `\uFEFF${canonicalConfig(path.join(wikiRoot, '.'), {
    autoIngest: { ignoreGlobs: ['a/*', 'a/*'] },
  }).replaceAll('\n', '\r\n')}`);
  const before = fs.readFileSync(target);
  const desired = canonicalConfig(wikiRoot, { autoIngest: { ignoreGlobs: ['a/*'] } });
  assert.deepEqual(resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: desired,
  }), { path: target, status: 'alias' });
  assert.deepEqual(fs.readFileSync(target), before);
  const conflict = canonicalConfig(wikiRoot, { autoIngest: { ignoreGlobs: ['other/*'] } });
  assert.throws(() => resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: conflict,
  }), (error) => error.code === 'CONFIG_TARGET_CONFLICT');
  assert.deepEqual(fs.readFileSync(target), before);
  assert.deepEqual(resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: conflict,
    replaceConfig: true,
  }), { path: target, status: 'replaced' });
  assert.equal(fs.readFileSync(target, 'utf8'), conflict);
});

test('config-write rejects an existing target with node-property-hidden supported keys before aliasing', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki tagged config target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const malformedTargets = [
    `${desired}!!str wiki_root: /shadow\n`,
    `${desired}&shadow "wiki_root": /shadow\n`,
    `${desired}auto_ingest:\n  !!str require_tag: shadow\n`,
    `${desired}obsidian_cli:\n  !<tag:yaml.org,2002:str> available: true\n`,
  ];
  for (const malformed of malformedTargets) {
    write(target, malformed);
    const before = fs.readFileSync(target);
    assert.throws(
      () => resolveConfigWriteTarget({ HOME: root }, 'codex', { desiredConfigText: desired }),
      (error) => error.code === 'CONFIG_TARGET_CONFLICT',
      malformed,
    );
    assert.deepEqual(fs.readFileSync(target), before);
  }
});

test('config-write rejects existing targets with alias or merge keys resolving to supported keys', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki aliased config target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const malformedTargets = [
    `${desired}anchor_source: &key wiki_root\n*key: /shadow\n`,
    `${desired}shadow_defaults: &defaults\n  wiki_root: /shadow\n<<: *defaults\n`,
  ];
  for (const malformed of malformedTargets) {
    write(target, malformed);
    const before = fs.readFileSync(target);
    assert.throws(
      () => resolveConfigWriteTarget({ HOME: root }, 'codex', { desiredConfigText: desired }),
      (error) => error.code === 'CONFIG_TARGET_CONFLICT',
      malformed,
    );
    assert.deepEqual(fs.readFileSync(target), before);
  }
});

test('config-write rejects tagged quoted merge keys regardless of node-property order and preserves controls', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki tagged merge config target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const tags = ['!!merge', '!<tag:yaml.org,2002:merge>'];
  const propertyOrders = [
    (tag) => `&marker ${tag}`,
    (tag) => `${tag} &marker`,
  ];
  for (const tag of tags) {
    for (const properties of propertyOrders) {
      const existing = desired
        .replace('auto_ingest:\n', 'defaults: &defaults { require_tag: shadow }\nauto_ingest:\n')
        .replace(
          '  require_tag: \n',
          `  require_tag: \n  ${properties(tag)} "<<": *defaults\n`,
        );
      write(target, existing);
      const before = fs.readFileSync(target);
      assert.throws(
        () => resolveConfigWriteTarget({ HOME: root }, 'codex', { desiredConfigText: desired }),
        (error) => error.code === 'CONFIG_TARGET_CONFLICT',
        existing,
      );
      assert.deepEqual(fs.readFileSync(target), before);
    }
  }

  const allowed = `${desired}quoted_literal: '&marker !!merge "<<": *defaults'\n`
    + 'unknown_mapping:\n  require_tag: genuine-unknown-descendant\n';
  write(target, allowed);
  const before = fs.readFileSync(target);
  assert.deepEqual(resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: desired,
  }), { path: target, status: 'alias' });
  assert.deepEqual(fs.readFileSync(target), before);
});

test('config-write rejects explicit two-line merge keys at root and both known sections', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki explicit merge config target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const wikiLine = desired.split('\n')[0];
  const contexts = [
    ['root', (key) => [
      wikiLine,
      'defaults: &defaults { auto_ingest: { require_tag: shadow } }',
      `? ${key}`,
      ': *defaults',
      'obsidian_cli:',
      '  available: false',
      '',
    ]],
    ['auto_ingest', (key) => [
      wikiLine,
      'defaults: &defaults { require_tag: shadow }',
      'auto_ingest:',
      '  ignore_globs: []',
      `  ? ${key}`,
      '  : *defaults',
      'obsidian_cli:',
      '  available: false',
      '',
    ]],
    ['obsidian_cli', (key) => [
      wikiLine,
      'auto_ingest:',
      '  ignore_globs: []',
      '  require_tag:',
      'defaults: &defaults { available: true }',
      'obsidian_cli:',
      `  ? ${key}`,
      '  : *defaults',
      '',
    ]],
  ];
  for (const [context, document] of contexts) {
    for (const [form, key] of explicitTwoLineMergeForms()) {
      const existing = document(key).join('\n');
      write(target, existing);
      const before = fs.readFileSync(target);
      assert.throws(
        () => resolveConfigWriteTarget({ HOME: root }, 'codex', { desiredConfigText: desired }),
        (error) => error.code === 'CONFIG_TARGET_CONFLICT',
        `${context}/${form}\n${existing}`,
      );
      assert.deepEqual(fs.readFileSync(target), before);
    }
  }
});

test('config-write rejects duplicate unsupported keys in supported-subset mapping contexts and preserves distinct unknown mappings', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki config duplicate unknown target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const malformedTargets = [
    `${desired}custom_key: one\ncustom_key: two\n`,
    `${desired}"custom_key": one\n"custom_key": two\n`,
    `${desired}custom_key: one\n"custom_key": two\n`,
    [
      `wiki_root: "${wikiRoot}"`,
      'auto_ingest:',
      '  ignore_globs: []',
      '  require_tag:',
      '  custom_key: one',
      '  custom_key: two',
      'obsidian_cli:',
      '  available: false',
      '',
    ].join('\n'),
    [
      `wiki_root: "${wikiRoot}"`,
      'auto_ingest:',
      '  ignore_globs: []',
      '  require_tag:',
      'obsidian_cli:',
      '  available: false',
      '  custom_key:',
      '    nested: one',
      '  custom_key:',
      '    nested: two',
      '',
    ].join('\n'),
    [
      `wiki_root: "${wikiRoot}"`,
      'auto_ingest:',
      '  ignore_globs: []',
      '  require_tag:',
      '  "custom_key": one',
      '  custom_key: two',
      'obsidian_cli:',
      '  available: false',
      '',
    ].join('\n'),
    [
      `wiki_root: "${wikiRoot}"`,
      'auto_ingest:',
      '  ignore_globs: []',
      '  require_tag:',
      'obsidian_cli:',
      '  available: false',
      "  'custom_key': one",
      '  "custom_key": two',
      '',
    ].join('\n'),
  ];
  for (const existing of malformedTargets) {
    write(target, existing);
    const before = fs.readFileSync(target);
    assert.throws(() => resolveConfigWriteTarget({ HOME: root }, 'codex', {
      desiredConfigText: desired,
    }), (error) => error.code === 'CONFIG_TARGET_CONFLICT');
    assert.deepEqual(fs.readFileSync(target), before);
  }

  const distinctUnknown = `${desired}first_unknown:\n  child: one\nsecond_unknown:\n  child: two\n`;
  write(target, distinctUnknown);
  const before = fs.readFileSync(target);
  assert.deepEqual(resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: desired,
  }), { path: target, status: 'alias' });
  assert.deepEqual(fs.readFileSync(target), before);
});

test('config-write rejects duplicate explicit unknown keys at root and both known sections', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki explicit duplicate config target ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = path.join(root, '.codex', 'deep-wiki-config.yaml');
  const desired = canonicalConfig(wikiRoot);
  const malformedTargets = [
    `${desired}? custom_key\n: one\n? custom_key\n: two\n`,
    desired.replace(
      '  require_tag: \n',
      '  require_tag: \n  ? custom_key\n  : one\n  ? custom_key\n  : two\n',
    ),
    desired.replace(
      '  available: false\n',
      '  available: false\n  ? custom_key\n  : one\n  ? custom_key\n  : two\n',
    ),
  ];
  for (const existing of malformedTargets) {
    write(target, existing);
    const before = fs.readFileSync(target);
    assert.throws(
      () => resolveConfigWriteTarget({ HOME: root }, 'codex', { desiredConfigText: desired }),
      (error) => error.code === 'CONFIG_TARGET_CONFLICT',
      existing,
    );
    assert.deepEqual(fs.readFileSync(target), before);
  }

  const distinct = desired
    .replace(
      '  require_tag: \n',
      '  require_tag: \n  ? auto_one\n  : one\n  ? auto_two\n  : two\n',
    )
    .replace(
      '  available: false\n',
      '  available: false\n  ? obsidian_one\n  : one\n  ? obsidian_two\n  : two\n',
    )
    + '? root_one\n: one\n? root_two\n: two\n';
  write(target, distinct);
  const before = fs.readFileSync(target);
  assert.deepEqual(resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: desired,
  }), { path: target, status: 'alias' });
  assert.deepEqual(fs.readFileSync(target), before);
});

test('config-write rejects malformed and symlink targets without changing target or referent', () => {
  const { resolveConfigWriteTarget } = runtimeModule('config.js');
  const root = temporaryRoot('deep wiki config target safety ');
  const wikiRoot = path.join(root, 'wiki');
  fs.mkdirSync(wikiRoot);
  const target = write(path.join(root, '.codex', 'deep-wiki-config.yaml'), 'wiki_root: one\nwiki_root: two\n');
  const malformed = fs.readFileSync(target);
  assert.throws(() => resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: canonicalConfig(wikiRoot),
  }), (error) => error.code === 'CONFIG_TARGET_CONFLICT');
  assert.deepEqual(fs.readFileSync(target), malformed);

  fs.rmSync(target);
  const referent = write(path.join(root, 'referent.yaml'), canonicalConfig(wikiRoot));
  const referentBefore = fs.readFileSync(referent);
  fs.symlinkSync(referent, target);
  assert.throws(() => resolveConfigWriteTarget({ HOME: root }, 'codex', {
    desiredConfigText: canonicalConfig(wikiRoot), replaceConfig: true,
  }), (error) => error.code === 'CONFIG_TARGET_CONFLICT');
  assert.deepEqual(fs.readFileSync(referent), referentBefore);
});

function newWikiRoot(prefix = 'deep wiki lock ') {
  const wikiRoot = temporaryRoot(prefix);
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta'), { recursive: true });
  return wikiRoot;
}

function lockRenameRace(phase, action) {
  let beforeFired = false;
  let afterFired = false;
  const renames = [];
  const mkdirs = [];
  const raceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') {
        return (pathname, options) => {
          mkdirs.push({ pathname, options });
          return target.mkdirSync(pathname, options);
        };
      }
      if (property === 'renameSync') {
        return (source, destination) => {
          renames.push({ source, destination });
          const isSeizure = path.basename(source) === '.wiki-lock';
          if (isSeizure && !beforeFired && (phase === 'before' || phase === 'both')) {
            beforeFired = true;
            action({ source, destination, phase: 'before' });
          }
          const result = target.renameSync(source, destination);
          if (isSeizure && !afterFired && (phase === 'after' || phase === 'both')) {
            afterFired = true;
            action({ source, destination, phase: 'after' });
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs: raceFs, fired: () => beforeFired || afterFired, mkdirs, renames };
}

function lockQuarantines(wikiRoot) {
  return fs.readdirSync(path.join(wikiRoot, '.wiki-meta'))
    .filter((name) => name.startsWith('.wiki-lock.'));
}

function directoryIdentity(pathname) {
  const stat = fs.lstatSync(pathname, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function fixedRandomBytes(fill) {
  return (size) => Buffer.alloc(size, fill);
}

function sequencedRandomBytes(...fills) {
  let index = 0;
  return (size) => Buffer.alloc(size, fills[Math.min(index++, fills.length - 1)]);
}

function lockReservationPath(wikiRoot, purpose, fill) {
  const suffix = Buffer.alloc(16, fill).toString('hex');
  return path.join(wikiRoot, '.wiki-meta', `.wiki-lock.${purpose}.${process.pid}.${suffix}`);
}

function opaqueReplacementBytes(kind) {
  const files = {
    'a-marker': Buffer.from(`opaque ${kind} a\0\xff`, 'latin1'),
    'z-marker': Buffer.from(`opaque ${kind} z\0\xfe`, 'latin1'),
  };
  if (kind === 'malformed-owner') files['owner.json'] = Buffer.from('{malformed\n');
  if (kind === 'different-valid-owner') {
    files['owner.json'] = Buffer.from(`${JSON.stringify({
      token: 'b'.repeat(64),
      operation: 'different-owner',
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: '2026-07-11T00:00:00.000Z',
    })}\n`);
  }
  return files;
}

function withoutIdentityGenerations(value) {
  if (Array.isArray(value)) return value.map(withoutIdentityGenerations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'birthtime_ns')
    .map(([key, child]) => [key, withoutIdentityGenerations(child)]));
}

function installOpaqueLock(lockDir, files) {
  fs.mkdirSync(lockDir);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(lockDir, name), bytes);
}

function interruptedMismatchRestoreFs(wikiRoot, replacementFiles, boundary) {
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  let seizureInjected = false;
  let crashed = false;
  let movedEntries = 0;
  const seam = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') {
        return (pathname, options) => {
          const result = target.mkdirSync(pathname, options);
          if (seizureInjected && !crashed && pathname === lockDir && boundary === 'after-mkdir') {
            crashed = true;
            const error = new Error('injected restore interruption after canonical mkdir');
            error.code = 'EIO';
            throw error;
          }
          return result;
        };
      }
      if (property === 'renameSync') {
        return (source, destination) => {
          if (!seizureInjected && source === lockDir) {
            seizureInjected = true;
            const { recoverLock } = runtimeModule('lock.js');
            assert.equal(recoverLock({
              wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
            }), true);
            installOpaqueLock(lockDir, replacementFiles);
          }
          const result = target.renameSync(source, destination);
          if (!crashed && path.basename(path.dirname(source)) === 'seized'
              && path.dirname(destination) === lockDir) {
            movedEntries += 1;
            if (boundary === `after-entry-${movedEntries}`) {
              crashed = true;
              const error = new Error(`injected restore interruption after entry ${movedEntries}`);
              error.code = 'EIO';
              throw error;
            }
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs: seam, crashed: () => crashed, seizureInjected: () => seizureInjected };
}

function collisionTrackingFs(reservation) {
  let reservationAttempts = 0;
  const renames = [];
  const seam = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') {
        return (pathname, options) => {
          if (pathname === reservation) reservationAttempts += 1;
          return target.mkdirSync(pathname, options);
        };
      }
      if (property === 'renameSync') {
        return (source, destination) => {
          renames.push({ source, destination });
          return target.renameSync(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs: seam, attempts: () => reservationAttempts, renames };
}

function waitForPathSync(file, timeoutMs = 5_000) {
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(waitState, 0, 0, 10);
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`lock barrier child exited code=${code} signal=${signal}`));
    });
  });
}

function spawnLockPublicationChild(lockDir, barrierB, barrierC) {
  const childScript = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const [lockDir, barrierB, barrierC] = process.argv.slice(1);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(barrierB, 'mkdir-owned\n');
    const state = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(barrierC)) {
      if (Date.now() >= deadline) process.exit(9);
      Atomics.wait(state, 0, 0, 10);
    }
    const owner = {
      token: 'c'.repeat(64), operation: 'child-replacement', pid: process.pid,
      hostname: os.hostname(), acquired_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner) + '\n');
  `;
  return spawn(process.execPath, ['-e', childScript, lockDir, barrierB, barrierC], {
    cwd: path.dirname(lockDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnPausedReleaseChild(wikiRoot, token, pausedFile, continueFile, resultFile) {
  const childScript = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const [repoRoot, wikiRoot, token, pausedFile, continueFile, resultFile] = process.argv.slice(1);
    const { releaseLock } = require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'lock.js'));
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    let paused = false;
    const raceFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            const result = target.renameSync(source, destination);
            if (!paused && source === path.join(wikiRoot, '.wiki-meta', '.wiki-lock')
                && path.basename(destination) === 'seized') {
              paused = true;
              target.writeFileSync(pausedFile, 'paused\n');
              const expires = Date.now() + 10_000;
              while (!target.existsSync(continueFile)) {
                if (Date.now() >= expires) {
                  const error = new Error('timed out waiting to continue release');
                  error.code = 'BARRIER_TIMEOUT';
                  throw error;
                }
                Atomics.wait(waitState, 0, 0, 5);
              }
            }
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const released = releaseLock({ wikiRoot, token, fs: raceFs });
      fs.writeFileSync(resultFile, JSON.stringify({ ok: true, released }) + '\n');
    } catch (error) {
      fs.writeFileSync(resultFile, JSON.stringify({
        ok: false,
        error: { code: error.code || 'ERROR', message: error.message },
      }) + '\n');
      process.stderr.write((error.code || 'ERROR') + ': ' + error.message + '\n');
      process.exitCode = 1;
    }
  `;
  return spawn(process.execPath, [
    '-e', childScript, repoRoot, wikiRoot, token, pausedFile, continueFile, resultFile,
  ], {
    cwd: wikiRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
}

test('live cross-process post-seizure release reports contention until the transition completes', async () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki live cross-process release ');
  const owner = acquireLock({ wikiRoot, operation: 'live-release-owner' });
  const pausedFile = path.join(wikiRoot, 'release.paused');
  const continueFile = path.join(wikiRoot, 'release.continue');
  const resultFile = path.join(wikiRoot, 'release.result.json');
  const child = spawnPausedReleaseChild(
    wikiRoot, owner.token, pausedFile, continueFile, resultFile,
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let contenderError;
  let unexpectedOwner;
  let childError;
  try {
    waitForPathSync(pausedFile);
    const liveReservations = lockQuarantines(wikiRoot);
    assert.equal(liveReservations.length, 1);
    const reservation = path.join(wikiRoot, '.wiki-meta', liveReservations[0]);
    const seized = path.join(reservation, 'seized');
    const intent = JSON.parse(fs.readFileSync(path.join(reservation, 'transition.json'), 'utf8'));
    assert.equal(intent.kind, 'lock-seizure-transition');
    assert.equal(intent.purpose, 'release');
    assert.equal(intent.reservation_name, liveReservations[0]);
    assert.equal(intent.pid, child.pid);
    assert.equal(intent.hostname, os.hostname());
    assert.equal(
      `${intent.reservation_identity.dev}:${intent.reservation_identity.ino}`,
      directoryIdentity(reservation),
    );
    assert.equal(
      `${intent.seized_identity.dev}:${intent.seized_identity.ino}`,
      directoryIdentity(seized),
    );
    try {
      unexpectedOwner = acquireLock({ wikiRoot, operation: 'cross-process-contender' });
    } catch (error) {
      contenderError = error;
    }
  } finally {
    fs.writeFileSync(continueFile, 'continue\n');
    try { await waitForChild(child); } catch (error) { childError = error; }
  }

  assert.equal(childError, undefined, `${stdout}\n${stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), { ok: true, released: true });
  if (unexpectedOwner) releaseLock({ wikiRoot, token: unexpectedOwner.token });
  assert.equal(contenderError?.code, 'LOCK_CONTENDED');
  assert.doesNotMatch(contenderError.message, /manual|unresolved|recovery/i);

  const successor = acquireLock({ wikiRoot, operation: 'post-release-successor' });
  releaseLock({ wikiRoot, token: successor.token });
  assert.deepEqual(lockQuarantines(wikiRoot), []);
});

test('live release completion stays contended when seized disappears after its matching identity snapshot', async () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki live release completion identity ');
  const owner = acquireLock({ wikiRoot, operation: 'live-release-completion-owner' });
  const readyFile = path.join(wikiRoot, 'intent-owner.ready');
  const stopFile = path.join(wikiRoot, 'intent-owner.stop');
  const childScript = String.raw`
    const fs = require('node:fs');
    const [readyFile, stopFile] = process.argv.slice(1);
    const state = new Int32Array(new SharedArrayBuffer(4));
    fs.writeFileSync(readyFile, 'ready\n');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(stopFile)) {
      if (Date.now() >= deadline) process.exit(9);
      Atomics.wait(state, 0, 0, 5);
    }
  `;
  const child = spawn(process.execPath, ['-e', childScript, readyFile, stopFile], {
    cwd: wikiRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const meta = path.join(wikiRoot, '.wiki-meta');
  let reservation;
  let seized;
  let seizedIdentityReads = 0;
  let contenderError;
  let childError;
  try {
    waitForPathSync(readyFile);
    reservation = path.join(meta, `.wiki-lock.release.${child.pid}.${'d'.repeat(32)}`);
    seized = path.join(reservation, 'seized');
    fs.mkdirSync(reservation);
    fs.renameSync(path.join(meta, '.wiki-lock'), seized);
    const serializeIdentity = (pathname) => {
      const stat = fs.lstatSync(pathname, { bigint: true });
      return {
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        type: (stat.mode & 0o170000n).toString(10),
        birthtime_ns: stat.birthtimeNs.toString(10),
      };
    };
    const intent = {
      contract_version: 1,
      kind: 'lock-seizure-transition',
      purpose: 'release',
      reservation_name: path.basename(reservation),
      reservation_identity: serializeIdentity(reservation),
      seized_identity: serializeIdentity(seized),
      pid: child.pid,
      hostname: os.hostname(),
    };
    fs.writeFileSync(path.join(reservation, 'transition.json'), `${JSON.stringify(intent)}\n`);

    const disappearingFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'lstatSync') {
          return (pathname, options) => {
            if (pathname === seized && options?.bigint === true) {
              seizedIdentityReads += 1;
              if (seizedIdentityReads === 2) fs.rmSync(seized, { recursive: true });
            }
            return target.lstatSync(pathname, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      acquireLock({ wikiRoot, operation: 'completion-contender', fs: disappearingFs });
    } catch (error) {
      contenderError = error;
    }
    assert.equal(seizedIdentityReads, 2);
    assert.equal(directoryIdentity(reservation), `${intent.reservation_identity.dev}:${intent.reservation_identity.ino}`);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (reservation) fs.rmSync(reservation, { recursive: true, force: true });
    fs.writeFileSync(stopFile, 'stop\n');
    try { await waitForChild(child); } catch (error) { childError = error; }
  }

  assert.equal(childError, undefined, `${stdout}\n${stderr}`);
  assert.equal(contenderError?.code, 'LOCK_CONTENDED');
  assert.doesNotMatch(contenderError.message, /manual|unresolved|recovery/i);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
});

test('live release completion stays contended when its reservation disappears after intent validation', async () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki live release disappearing reservation ');
  acquireLock({ wikiRoot, operation: 'live-release-disappearing-reservation-owner' });
  const readyFile = path.join(wikiRoot, 'intent-owner.ready');
  const stopFile = path.join(wikiRoot, 'intent-owner.stop');
  const childScript = String.raw`
    const fs = require('node:fs');
    const [readyFile, stopFile] = process.argv.slice(1);
    const state = new Int32Array(new SharedArrayBuffer(4));
    fs.writeFileSync(readyFile, 'ready\n');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(stopFile)) {
      if (Date.now() >= deadline) process.exit(9);
      Atomics.wait(state, 0, 0, 5);
    }
  `;
  const child = spawn(process.execPath, ['-e', childScript, readyFile, stopFile], {
    cwd: wikiRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const meta = path.join(wikiRoot, '.wiki-meta');
  let reservation;
  let seized;
  let contenderError;
  let childError;
  let removedAtSeizedProbe = false;
  try {
    waitForPathSync(readyFile);
    reservation = path.join(meta, `.wiki-lock.release.${child.pid}.${'f'.repeat(32)}`);
    seized = path.join(reservation, 'seized');
    fs.mkdirSync(reservation);
    fs.renameSync(path.join(meta, '.wiki-lock'), seized);
    const serializeIdentity = (pathname) => {
      const stat = fs.lstatSync(pathname, { bigint: true });
      return {
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        type: (stat.mode & 0o170000n).toString(10),
        birthtime_ns: stat.birthtimeNs.toString(10),
      };
    };
    const intent = {
      contract_version: 1,
      kind: 'lock-seizure-transition',
      purpose: 'release',
      reservation_name: path.basename(reservation),
      reservation_identity: serializeIdentity(reservation),
      seized_identity: serializeIdentity(seized),
      pid: child.pid,
      hostname: os.hostname(),
    };
    fs.writeFileSync(path.join(reservation, 'transition.json'), `${JSON.stringify(intent)}\n`);

    const disappearingFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'lstatSync') {
          return (pathname, options) => {
            if (pathname === seized && options === undefined && !removedAtSeizedProbe) {
              removedAtSeizedProbe = true;
              fs.rmSync(reservation, { recursive: true });
            }
            return target.lstatSync(pathname, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      acquireLock({ wikiRoot, operation: 'completion-contender', fs: disappearingFs });
    } catch (error) {
      contenderError = error;
    }
    assert.equal(removedAtSeizedProbe, true);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (reservation) fs.rmSync(reservation, { recursive: true, force: true });
    fs.writeFileSync(stopFile, 'stop\n');
    try { await waitForChild(child); } catch (error) { childError = error; }
  }

  assert.equal(childError, undefined, `${stdout}\n${stderr}`);
  assert.equal(contenderError?.code, 'LOCK_CONTENDED');
  assert.doesNotMatch(contenderError.message, /manual|unresolved|recovery/i);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
});

test('live release completion rejects a replaced reservation when seized disappears before identity capture', async () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki live release replaced reservation ');
  acquireLock({ wikiRoot, operation: 'live-release-replaced-reservation-owner' });
  const readyFile = path.join(wikiRoot, 'intent-owner.ready');
  const stopFile = path.join(wikiRoot, 'intent-owner.stop');
  const childScript = String.raw`
    const fs = require('node:fs');
    const [readyFile, stopFile] = process.argv.slice(1);
    const state = new Int32Array(new SharedArrayBuffer(4));
    fs.writeFileSync(readyFile, 'ready\n');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(stopFile)) {
      if (Date.now() >= deadline) process.exit(9);
      Atomics.wait(state, 0, 0, 5);
    }
  `;
  const child = spawn(process.execPath, ['-e', childScript, readyFile, stopFile], {
    cwd: wikiRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const meta = path.join(wikiRoot, '.wiki-meta');
  let reservation;
  let heldReservation;
  let seized;
  let recordedReservationIdentity;
  let currentReservationIdentity;
  let seizedPresenceReads = 0;
  let seizedIdentityReads = 0;
  let contenderError;
  let childError;
  try {
    waitForPathSync(readyFile);
    reservation = path.join(meta, `.wiki-lock.release.${child.pid}.${'e'.repeat(32)}`);
    heldReservation = path.join(meta, 'held-recorded-release-reservation');
    seized = path.join(reservation, 'seized');
    fs.mkdirSync(reservation);
    fs.renameSync(path.join(meta, '.wiki-lock'), seized);
    const serializeIdentity = (pathname) => {
      const stat = fs.lstatSync(pathname, { bigint: true });
      return {
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        type: (stat.mode & 0o170000n).toString(10),
        birthtime_ns: stat.birthtimeNs.toString(10),
      };
    };
    recordedReservationIdentity = serializeIdentity(reservation);
    const intent = {
      contract_version: 1,
      kind: 'lock-seizure-transition',
      purpose: 'release',
      reservation_name: path.basename(reservation),
      reservation_identity: recordedReservationIdentity,
      seized_identity: serializeIdentity(seized),
      pid: child.pid,
      hostname: os.hostname(),
    };
    fs.writeFileSync(path.join(reservation, 'transition.json'), `${JSON.stringify(intent)}\n`);

    const disappearingFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'lstatSync') {
          return (pathname, options) => {
            if (pathname === seized && options === undefined) {
              seizedPresenceReads += 1;
              if (seizedPresenceReads === 1) {
                fs.renameSync(reservation, heldReservation);
                fs.mkdirSync(reservation);
                fs.mkdirSync(seized);
                fs.copyFileSync(
                  path.join(heldReservation, 'transition.json'),
                  path.join(reservation, 'transition.json'),
                );
                currentReservationIdentity = serializeIdentity(reservation);
              }
            }
            if (pathname === seized && options?.bigint === true) {
              seizedIdentityReads += 1;
              if (seizedIdentityReads === 1) fs.rmdirSync(seized);
            }
            return target.lstatSync(pathname, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      acquireLock({ wikiRoot, operation: 'replaced-reservation-contender', fs: disappearingFs });
    } catch (error) {
      contenderError = error;
    }
    assert.equal(seizedPresenceReads, 2);
    assert.equal(seizedIdentityReads, 1);
    assert.equal(fs.existsSync(seized), false);
    assert.notDeepEqual(currentReservationIdentity, recordedReservationIdentity);
    assert.deepEqual(serializeIdentity(reservation), currentReservationIdentity);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (reservation) fs.rmSync(reservation, { recursive: true, force: true });
    if (heldReservation) fs.rmSync(heldReservation, { recursive: true, force: true });
    fs.writeFileSync(stopFile, 'stop\n');
    try { await waitForChild(child); } catch (error) { childError = error; }
  }

  assert.equal(childError, undefined, `${stdout}\n${stderr}`);
  assert.equal(contenderError?.code, 'LOCK_FILESYSTEM');
  assert.match(contenderError.message, /identity|inconsistent/i);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
});

test('lock seizure exclusively reserves a parent and moves the canonical lock into a missing child', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki reserved seizure ');
  const owner = acquireLock({ wikiRoot, operation: 'old-owner' });
  const foreign = path.join(wikiRoot, '.wiki-meta', '.wiki-lock.foreign-reservation');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'marker'), 'foreign\n');
  let observed;
  const race = lockRenameRace('after', ({ source, destination }) => {
    observed = {
      source,
      destination,
      reservation: path.dirname(destination),
      seizedOwnerExists: fs.existsSync(path.join(destination, 'owner.json')),
    };
  });

  assert.equal(releaseLock({
    wikiRoot, token: owner.token, fs: race.fs, randomBytes: fixedRandomBytes(0x21),
  }), true);
  assert.equal(observed.source, path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  assert.equal(path.basename(observed.destination), 'seized');
  assert.equal(observed.seizedOwnerExists, true);
  assert.ok(race.mkdirs.some(({ pathname, options }) => pathname === observed.reservation && options === undefined));
  assert.equal(fs.existsSync(observed.reservation), false);
  assert.equal(fs.readFileSync(path.join(foreign, 'marker'), 'utf8'), 'foreign\n');
});

test('lock seizure retries a random reservation collision without deleting the foreign directory', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki reservation retry ');
  const owner = acquireLock({ wikiRoot, operation: 'old-owner' });
  const colliding = lockReservationPath(wikiRoot, 'release', 0x31);
  const owned = lockReservationPath(wikiRoot, 'release', 0x32);
  fs.mkdirSync(colliding);

  assert.equal(releaseLock({
    wikiRoot,
    token: owner.token,
    randomBytes: sequencedRandomBytes(0x31, 0x32),
  }), true);
  assert.equal(fs.existsSync(colliding), true);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
});

for (const mode of ['release', 'force', 'stale']) {
  test(`${mode} seizure fails boundedly on empty and nonempty reservation collisions without touching canonical`, () => {
    const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
    for (const shape of ['empty', 'nonempty']) {
      const wikiRoot = newWikiRoot(`deep wiki ${mode} ${shape} reservation collision `);
      const owner = acquireLock({
        wikiRoot,
        operation: 'old-owner',
        now: new Date('2026-07-10T00:00:00.000Z'),
      });
      const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
      const ownerPath = path.join(lockDir, 'owner.json');
      const ownerBytes = fs.readFileSync(ownerPath);
      const purpose = mode === 'release' ? 'release' : 'recovery';
      const reservation = lockReservationPath(wikiRoot, purpose, 0x41);
      fs.mkdirSync(reservation);
      if (shape === 'nonempty') fs.writeFileSync(path.join(reservation, 'foreign'), 'keep\n');
      const tracked = collisionTrackingFs(reservation);
      const action = mode === 'release'
        ? () => releaseLock({
          wikiRoot, token: owner.token, fs: tracked.fs, randomBytes: fixedRandomBytes(0x41),
        })
        : () => recoverLock({
          wikiRoot,
          staleMs: 1,
          now: new Date('2026-07-11T00:00:00.000Z'),
          isPidAlive: () => false,
          force: mode === 'force',
          fs: tracked.fs,
          randomBytes: fixedRandomBytes(0x41),
        });

      assert.throws(action, (error) => error.code === 'LOCK_FILESYSTEM', `${mode}/${shape}`);
      assert.ok(tracked.attempts() >= 2 && tracked.attempts() <= 32, `${mode}/${shape} bounded retry count`);
      assert.deepEqual(tracked.renames, [], `${mode}/${shape} zero canonical rename`);
      assert.deepEqual(fs.readFileSync(ownerPath), ownerBytes);
      assert.equal(fs.existsSync(reservation), true);
      if (shape === 'nonempty') assert.equal(fs.readFileSync(path.join(reservation, 'foreign'), 'utf8'), 'keep\n');

      fs.rmSync(reservation, { recursive: true, force: true });
      releaseLock({ wikiRoot, token: owner.token });
    }
  });
}

test('only the owning token releases the lock', () => {
  const { acquireLock, assertLockOwner, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot();
  const fixedNow = new Date('2026-07-11T00:00:00.000Z');
  const owner = acquireLock({ wikiRoot, operation: 'ingest', now: fixedNow });
  assert.match(owner.token, /^[a-f0-9]{32,}$/);
  assert.deepEqual(Object.keys(owner), ['token', 'operation', 'pid', 'hostname', 'acquired_at']);
  assert.throws(() => releaseLock({ wikiRoot, token: 'wrong-token' }), /lock token mismatch/);
  assertLockOwner({ wikiRoot, token: owner.token });
  releaseLock({ wikiRoot, token: owner.token });
  assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
});

test('wrong lock token fails before any directory seizure and leaves canonical bytes unchanged', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki wrong-token fail-fast ');
  const owner = acquireLock({ wikiRoot, operation: 'legitimate-owner' });
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const before = fs.readFileSync(ownerPath);
  const race = lockRenameRace('before', () => {});

  assert.throws(
    () => releaseLock({ wikiRoot, token: 'wrong-token', fs: race.fs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  assert.equal(race.fired(), false);
  assert.deepEqual(race.renames, []);
  assert.equal(fs.existsSync(lockDir), true);
  assert.deepEqual(fs.readFileSync(ownerPath), before);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
  releaseLock({ wikiRoot, token: owner.token });
});

test('old lock release restores a force-takeover owner seized at the rename boundary', () => {
  const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki release takeover race ');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let replacement;
  const race = lockRenameRace('before', () => {
    assert.equal(recoverLock({
      wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
    }), true);
    replacement = acquireLock({ wikiRoot, operation: 'replacement-owner' });
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  assert.equal(race.fired(), true);
  const canonicalSeizures = race.renames.filter(({ source }) => source === path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  assert.equal(canonicalSeizures.length, 1);
  assert.equal(path.basename(canonicalSeizures[0].destination), 'seized');
  const reservation = path.dirname(canonicalSeizures[0].destination);
  const restoredEntries = race.renames.filter(({ source }) => path.dirname(source) === path.join(reservation, 'seized'));
  assert.equal(restoredEntries.length, 1);
  assert.equal(restoredEntries[0].destination, path.join(wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json'));
  assert.equal(assertLockOwner({ wikiRoot, token: replacement.token }).token, replacement.token);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
  releaseLock({ wikiRoot, token: replacement.token });
});

for (const replacementKind of ['ownerless', 'malformed-owner', 'different-valid-owner']) {
  test(`old lock release restores opaque ${replacementKind} replacement bytes canonically`, () => {
    const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki opaque ${replacementKind} replacement `);
    const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
    const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
    const marker = Buffer.from(`opaque ${replacementKind} marker\0\xff`, 'latin1');
    let ownerBytes = null;
    const race = lockRenameRace('before', () => {
      assert.equal(recoverLock({
        wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
      }), true);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'foreign-marker'), marker);
      if (replacementKind === 'malformed-owner') ownerBytes = Buffer.from('{malformed\n');
      if (replacementKind === 'different-valid-owner') {
        ownerBytes = Buffer.from(`${JSON.stringify({
          token: 'b'.repeat(64),
          operation: 'different-owner',
          pid: process.pid,
          hostname: os.hostname(),
          acquired_at: '2026-07-10T00:00:00.000Z',
        })}\n`);
      }
      if (ownerBytes) fs.writeFileSync(path.join(lockDir, 'owner.json'), ownerBytes);
    });

    assert.throws(
      () => releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs }),
      (error) => error.code === 'LOCK_TOKEN_MISMATCH',
    );
    assert.deepEqual(fs.readFileSync(path.join(lockDir, 'foreign-marker')), marker);
    if (ownerBytes) assert.deepEqual(fs.readFileSync(path.join(lockDir, 'owner.json')), ownerBytes);
    else assert.equal(fs.existsSync(path.join(lockDir, 'owner.json')), false);
    assert.deepEqual(lockQuarantines(wikiRoot), []);
    fs.rmSync(lockDir, { recursive: true, force: true });
  });
}

for (const mode of ['release']) {
  test(`${mode} post-seizure interruption blocks acquisition over an unresolved successor reservation`, () => {
    const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki ${mode} post-seizure interruption `);
    const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
    const oldOwner = acquireLock({
      wikiRoot,
      operation: 'old-owner',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    let successorBytes;
    const race = lockRenameRace('both', ({ phase }) => {
      if (phase === 'before') {
        assert.equal(recoverLock({
          wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
        }), true);
        acquireLock({ wikiRoot, operation: 'successor-at-seizure' });
        successorBytes = fs.readFileSync(path.join(lockDir, 'owner.json'));
        return;
      }
      const error = new Error('injected interruption immediately after canonical seizure');
      error.code = 'EIO';
      throw error;
    });
    const action = mode === 'release'
      ? () => releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs })
      : () => recoverLock({
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
        fs: race.fs,
      });

    assert.throws(action, (error) => error.code === 'EIO');
    const reservations = lockQuarantines(wikiRoot);
    assert.equal(reservations.length, 1);
    const reservation = path.join(wikiRoot, '.wiki-meta', reservations[0]);
    const seizedOwnerPath = path.join(reservation, 'seized', 'owner.json');
    assert.equal(fs.existsSync(path.join(reservation, 'restore.json')), false);
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(fs.readFileSync(seizedOwnerPath), successorBytes);

    assert.throws(
      () => acquireLock({ wikiRoot, operation: 'unauthorized-newcomer' }),
      (error) => error.code === 'LOCK_FILESYSTEM' && /unresolved|inconsistent/.test(error.message),
    );
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(fs.readFileSync(seizedOwnerPath), successorBytes);
    fs.rmSync(reservation, { recursive: true, force: true });
  });
}

test('restore-preparation failure retires live transition intent and leaves the seized owner fail-closed', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki restore preparation interruption ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let successorBytes;
  let takeoverInjected = false;
  let interruptionInjected = false;
  const raceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          if (!takeoverInjected && source === lockDir) {
            takeoverInjected = true;
            const successor = {
              token: 'e'.repeat(64),
              operation: 'seized-successor',
              pid: process.pid,
              hostname: os.hostname(),
              acquired_at: '2026-07-12T00:00:00.000Z',
            };
            fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(successor)}\n`);
            successorBytes = fs.readFileSync(path.join(lockDir, 'owner.json'));
          }
          return target.renameSync(source, destination);
        };
      }
      if (property === 'readdirSync') {
        return (pathname, options) => {
          if (!interruptionInjected && path.basename(pathname) === 'seized') {
            interruptionInjected = true;
            const error = new Error('injected restore preparation interruption');
            error.code = 'EIO';
            throw error;
          }
          return target.readdirSync(pathname, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: raceFs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH' && error.cause?.code === 'EIO',
  );
  assert.equal(takeoverInjected, true);
  assert.equal(interruptionInjected, true);
  const reservations = lockQuarantines(wikiRoot);
  assert.equal(reservations.length, 1);
  const reservation = path.join(wikiRoot, '.wiki-meta', reservations[0]);
  const seizedOwnerPath = path.join(reservation, 'seized', 'owner.json');
  assert.equal(fs.existsSync(path.join(reservation, 'restore.json')), false);
  assert.deepEqual(fs.readFileSync(seizedOwnerPath), successorBytes);
  assert.equal(fs.existsSync(path.join(reservation, 'transition.json')), false);
  assert.throws(
    () => acquireLock({ wikiRoot, operation: 'unauthorized-after-interruption' }),
    (error) => error.code === 'LOCK_FILESYSTEM' && /unresolved lock seizure/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(seizedOwnerPath), successorBytes);
  fs.rmSync(reservation, { recursive: true, force: true });
});

test('active seizure exemption is reservation-identity-bound against same-path replacement', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki active seizure reservation replacement ');
  const meta = path.join(wikiRoot, '.wiki-meta');
  const lockDir = path.join(meta, '.wiki-lock');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let reservation;
  let held;
  let markerPath;
  let newcomerError;
  const race = lockRenameRace('after', ({ destination }) => {
    reservation = path.dirname(destination);
    held = path.join(meta, 'held-reservation');
    fs.renameSync(reservation, held);
    fs.mkdirSync(reservation);
    fs.mkdirSync(path.join(reservation, 'seized'));
    markerPath = path.join(reservation, 'seized', 'foreign-marker');
    fs.writeFileSync(markerPath, 'foreign reservation\n');
    try {
      acquireLock({ wikiRoot, operation: 'unauthorized-newcomer' });
    } catch (error) {
      newcomerError = error;
    }
    const error = new Error('injected reservation replacement interruption');
    error.code = 'EIO';
    throw error;
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs }),
    (error) => error.code === 'EIO',
  );
  const marker = fs.readFileSync(markerPath, 'utf8');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.rmSync(reservation, { recursive: true, force: true });
  fs.rmSync(held, { recursive: true, force: true });
  assert.equal(newcomerError?.code, 'LOCK_FILESYSTEM');
  assert.match(newcomerError.message, /unresolved lock seizure/);
  assert.equal(marker, 'foreign reservation\n');
});

for (const mode of ['release']) {
  for (const replacementKind of ['ownerless', 'malformed-owner', 'different-valid-owner']) {
    for (const boundary of ['after-entry-1', 'after-entry-2']) {
      test(`${mode} mismatch restoration resumes ${replacementKind} bytes after ${boundary} interruption`, () => {
        const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
        const wikiRoot = newWikiRoot(`deep wiki ${mode} durable restore ${replacementKind} ${boundary} `);
        const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
        const oldOwner = acquireLock({
          wikiRoot,
          operation: 'old-owner',
          now: new Date('2026-07-10T00:00:00.000Z'),
        });
        const replacementFiles = opaqueReplacementBytes(replacementKind);
        const interrupted = interruptedMismatchRestoreFs(wikiRoot, replacementFiles, boundary);
        const firstAttempt = mode === 'release'
          ? () => releaseLock({ wikiRoot, token: oldOwner.token, fs: interrupted.fs })
          : () => recoverLock({
            wikiRoot,
            staleMs: 1,
            now: new Date('2026-07-11T00:00:00.000Z'),
            isPidAlive: () => false,
            fs: interrupted.fs,
          });

        assert.throws(firstAttempt, (error) => error.code === 'LOCK_TOKEN_MISMATCH');
        assert.equal(interrupted.seizureInjected(), true);
        assert.equal(interrupted.crashed(), true);
        const interruptedReservations = lockQuarantines(wikiRoot);
        assert.equal(interruptedReservations.length, 1);
        assert.equal(fs.existsSync(path.join(
          wikiRoot, '.wiki-meta', interruptedReservations[0], 'restore.json',
        )), true);

        if (mode === 'release') {
          assert.throws(
            () => releaseLock({ wikiRoot, token: oldOwner.token }),
            (error) => error.code === 'LOCK_TOKEN_MISMATCH',
          );
        } else {
          assert.equal(recoverLock({
            wikiRoot,
            staleMs: 1,
            now: new Date('2026-07-11T00:00:00.000Z'),
            isPidAlive: () => false,
          }), false);
        }
        for (const [name, bytes] of Object.entries(replacementFiles)) {
          assert.deepEqual(fs.readFileSync(path.join(lockDir, name)), bytes, `${mode}/${replacementKind}/${boundary}/${name}`);
        }
        assert.deepEqual(lockQuarantines(wikiRoot), []);
        fs.rmSync(lockDir, { recursive: true, force: true });
      });
    }
  }
}

test('legacy three-field restore identities stop before every recovery mutation', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki legacy unsealed restore ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const oldOwner = acquireLock({
    wikiRoot,
    operation: 'old-owner',
    now: new Date('2026-07-10T00:00:00.000Z'),
  });
  const interrupted = interruptedMismatchRestoreFs(
    wikiRoot,
    opaqueReplacementBytes('ownerless'),
    'after-entry-1',
  );
  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: interrupted.fs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  const reservation = path.join(wikiRoot, '.wiki-meta', lockQuarantines(wikiRoot)[0]);
  const restorePath = path.join(reservation, 'restore.json');
  const legacy = withoutIdentityGenerations(JSON.parse(fs.readFileSync(restorePath, 'utf8')));
  fs.writeFileSync(restorePath, `${JSON.stringify(legacy)}\n`);
  const beforeRestore = fs.readFileSync(restorePath);
  const beforeLockEntries = fs.readdirSync(lockDir).sort();
  const beforeSeizedEntries = fs.readdirSync(path.join(reservation, 'seized')).sort();

  assert.throws(
    () => acquireLock({ wikiRoot, operation: 'must-not-resume-legacy' }),
    (error) => error.code === 'LOCK_FILESYSTEM' && /legacy|generation/i.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(restorePath), beforeRestore);
  assert.deepEqual(fs.readdirSync(lockDir).sort(), beforeLockEntries);
  assert.deepEqual(fs.readdirSync(path.join(reservation, 'seized')).sort(), beforeSeizedEntries);
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.rmSync(reservation, { recursive: true, force: true });
});

for (const mode of ['release']) {
  test(`${mode} resume leaves a canonical_identity null different-inode empty successor untouched through owner publication`, () => {
    const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki ${mode} null identity successor `);
    const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
    const oldOwner = acquireLock({
      wikiRoot,
      operation: 'old-owner',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    const interrupted = interruptedMismatchRestoreFs(
      wikiRoot,
      opaqueReplacementBytes('ownerless'),
      'after-mkdir',
    );
    const firstAttempt = mode === 'release'
      ? () => releaseLock({ wikiRoot, token: oldOwner.token, fs: interrupted.fs })
      : () => recoverLock({
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
        fs: interrupted.fs,
      });
    assert.throws(firstAttempt, (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    const reservationName = lockQuarantines(wikiRoot)[0];
    const reservation = path.join(wikiRoot, '.wiki-meta', reservationName);
    const restoreState = JSON.parse(fs.readFileSync(path.join(reservation, 'restore.json'), 'utf8'));
    assert.equal(restoreState.canonical_identity, null);
    const preparedIdentity = directoryIdentity(lockDir);

    fs.rmSync(lockDir, { recursive: true, force: true });
    const identitySpacer = path.join(wikiRoot, '.wiki-meta', `${mode}-identity-spacer`);
    fs.mkdirSync(identitySpacer);
    fs.mkdirSync(lockDir);
    const successorIdentity = directoryIdentity(lockDir);
    assert.notEqual(successorIdentity, preparedIdentity);

    if (mode === 'release') {
      assert.throws(
        () => releaseLock({ wikiRoot, token: oldOwner.token }),
        (error) => error.code === 'LOCK_TOKEN_MISMATCH',
      );
    } else {
      assert.equal(recoverLock({
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
      }), false);
    }
    assert.equal(directoryIdentity(lockDir), successorIdentity);
    assert.deepEqual(fs.readdirSync(lockDir), []);
    assert.equal(fs.existsSync(reservation), true);

    const successor = {
      token: 'd'.repeat(64),
      operation: `${mode}-later-owner-publication`,
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: '2026-07-11T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(successor)}\n`);
    assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, successor.operation);
    releaseLock({ wikiRoot, token: successor.token });
    fs.rmSync(reservation, { recursive: true, force: true });
    fs.rmSync(identitySpacer, { recursive: true, force: true });
  });
}

test('interrupted mismatch restoration never replaces a concurrent successor before resume', () => {
  const { acquireLock, assertLockOwner, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki interrupted restore successor ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  const interrupted = interruptedMismatchRestoreFs(
    wikiRoot,
    opaqueReplacementBytes('different-valid-owner'),
    'after-mkdir',
  );
  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: interrupted.fs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  fs.rmSync(lockDir, { recursive: true, force: true });
  const successor = {
    token: 'c'.repeat(64),
    operation: 'concurrent-successor',
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  };
  installOpaqueLock(lockDir, {
    'owner.json': Buffer.from(`${JSON.stringify(successor)}\n`),
    'successor-marker': Buffer.from('preserve-successor\n'),
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, 'concurrent-successor');
  assert.equal(fs.readFileSync(path.join(lockDir, 'successor-marker'), 'utf8'), 'preserve-successor\n');
  assert.equal(lockQuarantines(wikiRoot).length, 1);
  releaseLock({ wikiRoot, token: successor.token });
  for (const name of lockQuarantines(wikiRoot)) {
    fs.rmSync(path.join(wikiRoot, '.wiki-meta', name), { recursive: true, force: true });
  }
});

for (const mode of ['release']) {
  test(`${mode} mismatch restoration preserves a successor that takes over after the canonical restore directory is created`, () => {
    const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki ${mode} restore identity takeover `);
    const oldOwner = acquireLock({
      wikiRoot,
      operation: 'old-owner',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
    let seizedOwner;
    let successor;
    let seizureInjected = false;
    let restoreTakeoverInjected = false;
    const raceFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (!seizureInjected && source === lockDir) {
              seizureInjected = true;
              assert.equal(recoverLock({
                wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
              }), true);
              seizedOwner = acquireLock({ wikiRoot, operation: 'seized-owner' });
            }
            return target.renameSync(source, destination);
          };
        }
        if (property === 'readdirSync') {
          return (pathname, options) => {
            if (!restoreTakeoverInjected && path.basename(pathname) === 'seized') {
              restoreTakeoverInjected = true;
              target.rmSync(lockDir, { recursive: true, force: true });
              successor = acquireLock({ wikiRoot, operation: 'restore-successor' });
            }
            return target.readdirSync(pathname, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const action = mode === 'release'
      ? () => releaseLock({ wikiRoot, token: oldOwner.token, fs: raceFs })
      : () => recoverLock({
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
        fs: raceFs,
      });

    assert.throws(action, (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(seizureInjected, true);
    assert.equal(restoreTakeoverInjected, true);
    assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, 'restore-successor');
    assert.notEqual(successor.token, seizedOwner.token);
    releaseLock({ wikiRoot, token: successor.token });
    for (const name of lockQuarantines(wikiRoot)) {
      fs.rmSync(path.join(wikiRoot, '.wiki-meta', name), { recursive: true, force: true });
    }
  });
}

test('lock release deletes only its quarantine while a post-seizure owner survives', () => {
  const { acquireLock, assertLockOwner, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki release post-seizure race ');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let replacement;
  const race = lockRenameRace('after', () => {
    replacement = acquireLock({ wikiRoot, operation: 'replacement-owner' });
  });

  assert.equal(releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs }), true);
  assert.equal(race.fired(), true);
  const canonicalSeizures = race.renames.filter(({ source }) => source === path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  assert.equal(canonicalSeizures.length, 1);
  assert.equal(path.basename(canonicalSeizures[0].destination), 'seized');
  assert.equal(assertLockOwner({ wikiRoot, token: replacement.token }).token, replacement.token);
  assert.deepEqual(lockQuarantines(wikiRoot), []);
  releaseLock({ wikiRoot, token: replacement.token });
});

for (const mode of ['release', 'force', 'stale']) {
  test(`${mode} quarantine cleanup preserves a same-path foreign reservation replacement`, () => {
    const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki ${mode} reservation replacement `);
    const owner = acquireLock({
      wikiRoot,
      operation: 'old-owner',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    const purpose = mode === 'release' ? 'release' : 'recovery';
    let replacementPath;
    const replaceReservation = (target, pathname, remove) => {
      const name = path.basename(pathname);
      if (replacementPath || !name.startsWith(`.wiki-lock.${purpose}.`)) return remove();
      remove();
      target.mkdirSync(pathname);
      target.writeFileSync(path.join(pathname, 'foreign-marker'), 'foreign\n');
      replacementPath = pathname;
      return remove();
    };
    const raceFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'rmSync') {
          return (pathname, options) => replaceReservation(
            target,
            pathname,
            () => target.rmSync(pathname, options),
          );
        }
        if (property === 'rmdirSync') {
          return (pathname, options) => replaceReservation(
            target,
            pathname,
            () => target.rmdirSync(pathname, options),
          );
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const action = mode === 'release'
      ? () => releaseLock({ wikiRoot, token: owner.token, fs: raceFs })
      : () => recoverLock({
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
        force: mode === 'force',
        fs: raceFs,
      });

    assert.throws(action, (error) => error.code === 'LOCK_FILESYSTEM');
    assert.ok(replacementPath);
    assert.equal(fs.readFileSync(path.join(replacementPath, 'foreign-marker'), 'utf8'), 'foreign\n');
    fs.rmSync(replacementPath, { recursive: true, force: true });
  });
}

test('quarantine cleanup preserves a same-path foreign seized-directory replacement', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki seized replacement ');
  const owner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let replacedSeized;
  const raceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readdirSync') {
        return (pathname, options) => {
          if (!replacedSeized && path.basename(pathname) === 'seized') {
            target.rmSync(pathname, { recursive: true, force: true });
            target.mkdirSync(pathname);
            target.writeFileSync(path.join(pathname, 'foreign-marker'), 'foreign\n');
            replacedSeized = pathname;
          }
          return target.readdirSync(pathname, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: owner.token, fs: raceFs }),
    (error) => error.code === 'LOCK_FILESYSTEM',
  );
  assert.ok(replacedSeized);
  assert.equal(fs.readFileSync(path.join(replacedSeized, 'foreign-marker'), 'utf8'), 'foreign\n');
  fs.rmSync(path.dirname(replacedSeized), { recursive: true, force: true });
});

test('lock release fails closed when a mismatched quarantine cannot be restored', () => {
  const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki release restore conflict ');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  let seizedReplacement;
  let replacement;
  const race = lockRenameRace('both', ({ phase }) => {
    if (phase === 'before') {
      assert.equal(recoverLock({
        wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
      }), true);
      seizedReplacement = acquireLock({ wikiRoot, operation: 'seized-replacement' });
    } else {
      replacement = acquireLock({ wikiRoot, operation: 'post-seizure-owner' });
    }
  });

  assert.throws(
    () => releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs }),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH' && error.cause?.code === 'EEXIST',
  );
  assert.equal(race.fired(), true);
  const canonicalSeizures = race.renames.filter(({ source }) => source === path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  assert.equal(canonicalSeizures.length, 1);
  assert.equal(path.basename(canonicalSeizures[0].destination), 'seized');
  assert.equal(assertLockOwner({ wikiRoot, token: replacement.token }).token, replacement.token);
  const quarantines = lockQuarantines(wikiRoot);
  assert.equal(quarantines.length, 1);
  const quarantinedOwner = JSON.parse(fs.readFileSync(
    path.join(wikiRoot, '.wiki-meta', quarantines[0], 'seized', 'owner.json'),
  ));
  assert.equal(quarantinedOwner.token, seizedReplacement.token);
  releaseLock({ wikiRoot, token: replacement.token });
  for (const name of lockQuarantines(wikiRoot)) {
    fs.rmSync(path.join(wikiRoot, '.wiki-meta', name), { recursive: true, force: true });
  }
});

test('mismatch restoration never replaces the mkdir-to-owner-publication acquisition window', async () => {
  const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki child publication barrier ');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const barrierB = path.join(wikiRoot, '.wiki-meta', 'child-barrier-b');
  const barrierC = path.join(wikiRoot, '.wiki-meta', 'child-barrier-c');
  let seizedReplacement;
  let child;
  const race = lockRenameRace('both', ({ phase }) => {
    if (phase === 'before') {
      assert.equal(recoverLock({
        wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
      }), true);
      seizedReplacement = acquireLock({ wikiRoot, operation: 'seized-replacement' });
      return;
    }
    child = spawnLockPublicationChild(lockDir, barrierB, barrierC);
    waitForPathSync(barrierB);
  });

  let releaseError;
  try {
    releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs });
  } catch (error) {
    releaseError = error;
  }
  const ownerExistedBeforePublication = fs.existsSync(ownerPath);
  const reservationsBeforePublication = lockQuarantines(wikiRoot);
  fs.writeFileSync(barrierC, 'publish\n');
  await waitForChild(child);

  assert.equal(releaseError?.code, 'LOCK_TOKEN_MISMATCH');
  assert.equal(releaseError?.cause?.code, 'EEXIST');
  assert.equal(ownerExistedBeforePublication, false);
  assert.equal(reservationsBeforePublication.length, 1);
  const retainedOwner = JSON.parse(fs.readFileSync(path.join(
    wikiRoot, '.wiki-meta', reservationsBeforePublication[0], 'seized', 'owner.json',
  )));
  assert.equal(retainedOwner.token, seizedReplacement.token);
  assert.equal(assertLockOwner({ wikiRoot, token: 'c'.repeat(64) }).operation, 'child-replacement');

  releaseLock({ wikiRoot, token: 'c'.repeat(64) });
  for (const name of lockQuarantines(wikiRoot)) {
    fs.rmSync(path.join(wikiRoot, '.wiki-meta', name), { recursive: true, force: true });
  }
});

test('mismatch restoration keeps the acquisition path present when seizure catches the pre-publication barrier', async () => {
  const { acquireLock, assertLockOwner, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki child pre-seizure barrier ');
  const oldOwner = acquireLock({ wikiRoot, operation: 'old-owner' });
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const barrierB = path.join(wikiRoot, '.wiki-meta', 'child-before-seizure-b');
  const barrierC = path.join(wikiRoot, '.wiki-meta', 'child-before-seizure-c');
  let child;
  const race = lockRenameRace('before', () => {
    assert.equal(recoverLock({
      wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
    }), true);
    child = spawnLockPublicationChild(lockDir, barrierB, barrierC);
    waitForPathSync(barrierB);
  });

  let releaseError;
  try {
    releaseLock({ wikiRoot, token: oldOwner.token, fs: race.fs });
  } catch (error) {
    releaseError = error;
  }
  const canonicalExistsBeforePublication = fs.existsSync(lockDir);
  const reservationsBeforePublication = lockQuarantines(wikiRoot);
  fs.writeFileSync(barrierC, 'publish\n');
  let childError;
  try {
    await waitForChild(child);
  } catch (error) {
    childError = error;
  }

  assert.equal(releaseError?.code, 'LOCK_TOKEN_MISMATCH');
  assert.equal(childError, undefined);
  assert.equal(canonicalExistsBeforePublication, true);
  assert.equal(reservationsBeforePublication.length, 0);
  assert.equal(assertLockOwner({ wikiRoot, token: 'c'.repeat(64) }).operation, 'child-replacement');

  releaseLock({ wikiRoot, token: 'c'.repeat(64) });
  for (const name of lockQuarantines(wikiRoot)) {
    fs.rmSync(path.join(wikiRoot, '.wiki-meta', name), { recursive: true, force: true });
  }
});

test('lock contention returns stable metadata without replacing the owner', () => {
  const { acquireLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki lock contention ');
  const owner = acquireLock({ wikiRoot, operation: 'ingest', now: new Date('2026-07-11T00:00:00Z') });
  assert.throws(() => acquireLock({ wikiRoot, operation: 'rebuild' }), (error) =>
    error.code === 'LOCK_CONTENDED'
      && error.owner.token === owner.token
      && error.owner.operation === 'ingest');
  const persisted = JSON.parse(fs.readFileSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json')));
  assert.deepEqual(persisted, owner);
  releaseLock({ wikiRoot, token: owner.token });
});

test('lock acquisition removes its newly created directory if owner publication fails', () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki owner write failure ');
  assert.throws(() => acquireLock({
    wikiRoot,
    operation: 'ingest',
    writeOwner() {
      const error = new Error('injected owner write failure');
      error.code = 'EIO';
      throw error;
    },
  }), /owner write failure/);
  assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
});

test('lock acquisition cleans its identity-bound directory when entropy generation fails', () => {
  const { acquireLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki owner entropy failure ');
  assert.throws(() => acquireLock({
    wikiRoot,
    operation: 'entropy-failure',
    randomBytes() {
      const error = new Error('injected entropy failure');
      error.code = 'EIO';
      throw error;
    },
  }), /entropy failure/);
  assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
});

test('owner-construction cleanup preserves a successor that takes over before the failure escapes', () => {
  const { acquireLock, assertLockOwner, recoverLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki owner construction takeover ');
  let successor;
  assert.throws(() => acquireLock({
    wikiRoot,
    operation: 'failing-owner-construction',
    randomBytes() {
      fs.rmSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock'), { recursive: true });
      successor = acquireLock({ wikiRoot, operation: 'construction-successor' });
      const error = new Error('injected post-takeover entropy failure');
      error.code = 'EIO';
      throw error;
    },
  }), /post-takeover entropy failure/);
  assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, 'construction-successor');
  releaseLock({ wikiRoot, token: successor.token });
});

test('owner-construction cleanup rejects reused directory inode with a changed birth-time generation', () => {
  const { acquireLock, assertLockOwner, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki owner generation takeover ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  let successor;
  let replaced = false;
  const generationFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (pathname, options) => {
          const stat = target.lstatSync(pathname, options);
          if (pathname !== lockDir) return stat;
          return {
            ...stat,
            dev: 13n,
            ino: 17n,
            birthtimeNs: replaced ? 200n : 100n,
          };
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(() => acquireLock({
    wikiRoot,
    operation: 'failing-generation-owner',
    fs: generationFs,
    randomBytes() {
      fs.rmSync(lockDir, { recursive: true });
      successor = acquireLock({ wikiRoot, operation: 'generation-successor' });
      replaced = true;
      const error = new Error('injected generation replacement');
      error.code = 'EIO';
      throw error;
    },
  }), /generation replacement/);
  assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, 'generation-successor');
  releaseLock({ wikiRoot, token: successor.token });
});

test('lock acquisition publication failure preserves a forced-recovery successor at the canonical path', () => {
  const { acquireLock, assertLockOwner, recoverLock, releaseLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki owner write successor ');
  let successor;
  assert.throws(() => acquireLock({
    wikiRoot,
    operation: 'failing-owner',
    writeOwner() {
      fs.rmSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock'), { recursive: true });
      successor = acquireLock({ wikiRoot, operation: 'successor-owner' });
      const error = new Error('injected original publication failure');
      error.code = 'EIO';
      throw error;
    },
  }), /original publication failure/);
  assert.equal(assertLockOwner({ wikiRoot, token: successor.token }).operation, 'successor-owner');
  releaseLock({ wikiRoot, token: successor.token });
});

test('lock stale recovery never steals a live or ownerless legacy lock', () => {
  const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki lock recovery ');
  const oldNow = new Date('2026-07-10T00:00:00Z');
  const fixedNow = new Date('2026-07-11T00:00:00Z');
  const owner = acquireLock({ wikiRoot, operation: 'rebuild', now: oldNow });
  assert.equal(recoverLock({ wikiRoot, staleMs: 1, now: fixedNow, isPidAlive: () => true }), false);
  releaseLock({ wikiRoot, token: owner.token });
  fs.mkdirSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  const ownerlessBefore = fs.readdirSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock'));
  assert.equal(recoverLock({ wikiRoot, staleMs: 1, now: fixedNow }), false);
  assert.equal(recoverLock({ wikiRoot, staleMs: 1, now: fixedNow, force: true }), false);
  assert.deepEqual(fs.readdirSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), ownerlessBefore);
});

test('lock recovery removes only an abandoned same-host valid owner and treats EPERM as alive', () => {
  const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki abandoned lock ');
  const oldNow = new Date('2026-07-10T00:00:00Z');
  const fixedNow = new Date('2026-07-11T00:00:00Z');
  let owner = acquireLock({ wikiRoot, operation: 'rebuild', now: oldNow });
  assert.equal(recoverLock({ wikiRoot, staleMs: 1, now: fixedNow, isPidAlive: () => false }), true);
  owner = acquireLock({ wikiRoot, operation: 'rebuild', now: oldNow });
  assert.equal(recoverLock({ wikiRoot, staleMs: 1, now: fixedNow, isPidAlive: () => {
    const error = new Error('not permitted'); error.code = 'EPERM'; throw error;
  } }), false);
  releaseLock({ wikiRoot, token: owner.token });
});

test('force preserves foreign-host, malformed, young live, and invalid-token owners byte-identically', () => {
  const { recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki conservative recovery ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const valid = {
    token: 'a'.repeat(32), operation: 'ingest', pid: 12345,
    hostname: os.hostname(), acquired_at: '2026-07-11T00:00:00.000Z',
  };
  const cases = [
    { ...valid, hostname: 'foreign-host', acquired_at: '2026-07-10T00:00:00.000Z' },
    { ...valid, token: 'bad', acquired_at: '2026-07-10T00:00:00.000Z' },
    { ...valid, acquired_at: '2026-07-11T00:00:00.000Z' },
  ];
  for (const value of cases) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerPath, `${JSON.stringify(value)}\n`);
    assert.equal(recoverLock({
      wikiRoot, staleMs: 60_000, now: new Date('2026-07-11T00:00:01.000Z'), isPidAlive: () => false,
    }), false);
    const before = fs.readFileSync(ownerPath);
    assert.equal(fs.existsSync(lockDir), true);
    assert.equal(recoverLock({
      wikiRoot,
      staleMs: 60_000,
      now: new Date('2026-07-11T00:00:01.000Z'),
      force: true,
      isPidAlive: value.pid === valid.pid && value.hostname === valid.hostname && value.token === valid.token
        ? () => true : () => false,
    }), false);
    assert.deepEqual(fs.readFileSync(ownerPath), before);
  }
});

test('lock recovery treats parseable but noncanonical acquisition timestamps as malformed', () => {
  const { recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki noncanonical owner time ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const valid = {
    token: 'a'.repeat(32), operation: 'ingest', pid: 12345, hostname: os.hostname(),
  };
  const noncanonical = [
    'July 10, 2026 00:00:00',
    '2026-07-10T00:00:00Z',
    '2026-07-10T00:00:00.000+00:00',
  ];
  for (const acquiredAt of noncanonical) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerPath, `${JSON.stringify({ ...valid, acquired_at: acquiredAt })}\n`);
    assert.equal(recoverLock({
      wikiRoot,
      staleMs: 1,
      now: new Date('2026-07-11T00:00:00.000Z'),
      isPidAlive: () => false,
    }), false, acquiredAt);
    assert.equal(fs.existsSync(lockDir), true, acquiredAt);
    const before = fs.readFileSync(ownerPath);
    assert.equal(recoverLock({
      wikiRoot,
      staleMs: 0,
      force: true,
      isPidAlive: () => false,
    }), false, acquiredAt);
    assert.deepEqual(fs.readFileSync(ownerPath), before, acquiredAt);
  }
});

test('force bypasses age only after a valid same-host owner is proved dead', () => {
  const { acquireLock, releaseLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki force age only ');
  let owner = acquireLock({
    wikiRoot,
    operation: 'young-dead-owner',
    now: new Date('2026-07-11T00:00:00.000Z'),
  });
  assert.equal(recoverLock({
    wikiRoot,
    staleMs: 60_000,
    now: new Date('2026-07-11T00:00:01.000Z'),
    force: true,
    isPidAlive: () => true,
  }), false);
  assert.equal(recoverLock({
    wikiRoot,
    staleMs: 60_000,
    now: new Date('2026-07-11T00:00:01.000Z'),
    force: true,
    isPidAlive: () => false,
  }), true);
  owner = acquireLock({ wikiRoot, operation: 'eperm-owner' });
  assert.equal(recoverLock({
    wikiRoot,
    staleMs: 0,
    force: true,
    isPidAlive() {
      const error = new Error('not permitted');
      error.code = 'EPERM';
      throw error;
    },
  }), false);
  releaseLock({ wikiRoot, token: owner.token });
});

for (const mutation of [
  {
    name: 'owner field substitution',
    apply(ownerPath) {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, operation: 'substituted' })}\n`);
    },
  },
  {
    name: 'owner key-order drift',
    apply(ownerPath) {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, `${JSON.stringify({
        operation: owner.operation,
        token: owner.token,
        pid: owner.pid,
        hostname: owner.hostname,
        acquired_at: owner.acquired_at,
      })}\n`);
    },
  },
  {
    name: 'owner whitespace drift',
    apply(ownerPath) {
      fs.writeFileSync(ownerPath, Buffer.concat([Buffer.from(' '), fs.readFileSync(ownerPath)]));
    },
  },
  {
    name: 'unknown owner field',
    apply(ownerPath) {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, unknown: true })}\n`);
    },
  },
  {
    name: 'missing owner field',
    apply(ownerPath) {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      delete owner.hostname;
      fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
    },
  },
  {
    name: 'unreadable owner bytes',
    apply(ownerPath) {
      fs.writeFileSync(ownerPath, Buffer.from([0xff, 0xfe, 0xfd]));
    },
  },
  {
    name: 'extra quarantine entry',
    apply(ownerPath) {
      fs.writeFileSync(path.join(path.dirname(ownerPath), 'foreign-entry'), 'foreign\n');
    },
  },
  {
    name: 'directory identity drift',
    apply(ownerPath) {
      const ownerBytes = fs.readFileSync(ownerPath);
      const seized = path.dirname(ownerPath);
      fs.rmSync(seized, { recursive: true });
      fs.mkdirSync(seized);
      fs.writeFileSync(path.join(seized, 'owner.json'), ownerBytes);
    },
  },
]) {
  test(`recovery stops before deletion on ${mutation.name}`, () => {
    const { acquireLock, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki sealed recovery ${mutation.name} `);
    acquireLock({
      wikiRoot,
      operation: 'dead-owner',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    const race = lockRenameRace('after', ({ destination }) => {
      mutation.apply(path.join(destination, 'owner.json'));
    });

    assert.throws(() => recoverLock({
      wikiRoot,
      staleMs: 1,
      now: new Date('2026-07-11T00:00:00.000Z'),
      isPidAlive: () => false,
      fs: race.fs,
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
    const reservations = lockQuarantines(wikiRoot);
    assert.equal(reservations.length, 1);
    assert.equal(fs.existsSync(path.join(
      wikiRoot, '.wiki-meta', reservations[0], 'seized',
    )), true);
  });
}

test('recovery stops when the quarantine physical path seal changes', () => {
  const { acquireLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki physical recovery seal ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  acquireLock({
    wikiRoot,
    operation: 'dead-owner',
    now: new Date('2026-07-10T00:00:00.000Z'),
  });
  let renamed = false;
  const sealFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          const result = target.renameSync(source, destination);
          if (source === lockDir) renamed = true;
          return result;
        };
      }
      if (property === 'realpathSync') {
        return (pathname) => {
          const actual = target.realpathSync(pathname);
          return renamed && path.basename(pathname) === 'seized'
            ? path.join(path.dirname(actual), 'different-seized')
            : actual;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.throws(() => recoverLock({
    wikiRoot,
    staleMs: 1,
    now: new Date('2026-07-11T00:00:00.000Z'),
    isPidAlive: () => false,
    fs: sealFs,
  }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  assert.equal(lockQuarantines(wikiRoot).length, 1);
});

test('lock recovery treats JSON owner field order as semantically irrelevant', () => {
  const { recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki reordered owner ');
  const lockDir = path.join(wikiRoot, '.wiki-meta', '.wiki-lock');
  fs.mkdirSync(lockDir);
  const reordered = {
    operation: 'ingest',
    token: 'b'.repeat(64),
    hostname: os.hostname(),
    pid: 987654,
    acquired_at: '2026-07-10T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(reordered)}\n`);
  assert.equal(recoverLock({
    wikiRoot,
    staleMs: 1,
    now: new Date('2026-07-11T00:00:00.000Z'),
    isPidAlive: () => false,
  }), true);
});

test('stale recovery leaves a replaced candidate quarantined instead of restoring or deleting it', () => {
  const { acquireLock, recoverLock } = runtimeModule('lock.js');
  const wikiRoot = newWikiRoot('deep wiki stale replacement race ');
  acquireLock({ wikiRoot, operation: 'stale-owner', now: new Date('2026-07-10T00:00:00.000Z') });
  let replacement;
  const race = lockRenameRace('before', () => {
    assert.equal(recoverLock({
      wikiRoot, staleMs: 0, force: true, isPidAlive: () => false,
    }), true);
    replacement = acquireLock({ wikiRoot, operation: 'replacement-owner' });
  });

  assert.throws(() => recoverLock({
    wikiRoot,
    staleMs: 1,
    now: new Date('2026-07-11T00:00:00.000Z'),
    isPidAlive: () => false,
    fs: race.fs,
  }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  assert.equal(race.fired(), true);
  assert.equal(fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), false);
  const reservations = lockQuarantines(wikiRoot);
  assert.equal(reservations.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(
    wikiRoot, '.wiki-meta', reservations[0], 'seized', 'owner.json',
  ))).token, replacement.token);
});

for (const mode of ['stale', 'force']) {
  test(`${mode} recovery stops before deletion when a canonical successor appears`, () => {
    const { acquireLock, assertLockOwner, recoverLock } = runtimeModule('lock.js');
    const wikiRoot = newWikiRoot(`deep wiki ${mode} post-seizure race `);
    acquireLock({ wikiRoot, operation: 'old-owner', now: new Date('2026-07-10T00:00:00.000Z') });
    let replacement;
    const race = lockRenameRace('after', () => {
      replacement = acquireLock({ wikiRoot, operation: 'replacement-owner' });
    });
    const options = mode === 'force'
      ? { wikiRoot, staleMs: 1, force: true, isPidAlive: () => false, fs: race.fs }
      : {
        wikiRoot,
        staleMs: 1,
        now: new Date('2026-07-11T00:00:00.000Z'),
        isPidAlive: () => false,
        fs: race.fs,
      };

    assert.throws(() => recoverLock(options), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(race.fired(), true);
    const canonicalSeizures = race.renames.filter(
      ({ source }) => source === path.join(wikiRoot, '.wiki-meta', '.wiki-lock'),
    );
    assert.equal(canonicalSeizures.length, 1);
    assert.equal(path.basename(canonicalSeizures[0].destination), 'seized');
    assert.equal(assertLockOwner({ wikiRoot, token: replacement.token }).token, replacement.token);
    assert.equal(lockQuarantines(wikiRoot).length, 1);
  });
}

test('runtime CLI exposes config and token-lock commands with stable JSON and exit codes', () => {
  const root = temporaryRoot('deep wiki runtime cli ');
  const wikiRoot = path.join(root, 'Wiki Root');
  fs.mkdirSync(wikiRoot);
  write(path.join(root, '.codex', 'deep-wiki-config.yaml'), canonicalConfig(wikiRoot));
  const baseEnv = { ...process.env, HOME: root, CODEX_HOME: '' };
  const resolveResult = spawnSync(process.execPath, [cli, 'config', 'resolve', '--json'], {
    cwd: temporaryRoot('deep wiki unrelated cwd '), env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(resolveResult.status, 0, resolveResult.stderr);
  assert.equal(JSON.parse(resolveResult.stdout).config.wikiRoot, fs.realpathSync.native(wikiRoot));

  const acquire = spawnSync(process.execPath, [cli, 'lock', 'acquire', '--wiki-root', wikiRoot, '--operation', 'ingest', '--json'], {
    cwd: root, env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(acquire.status, 0, acquire.stderr);
  const token = JSON.parse(acquire.stdout).token;
  const status = spawnSync(process.execPath, [cli, 'lock', 'status', '--wiki-root', wikiRoot, '--json'], {
    cwd: root, env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).owner.token, token);
  const mismatch = spawnSync(process.execPath, [cli, 'lock', 'release', '--wiki-root', wikiRoot, '--token', 'wrong', '--json'], {
    cwd: root, env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(mismatch.status, 3);
  const release = spawnSync(process.execPath, [cli, 'lock', 'release', '--wiki-root', wikiRoot, '--token', token, '--json'], {
    cwd: root, env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(release.status, 0, release.stderr);
  const usage = spawnSync(process.execPath, [cli, 'lock', 'acquire', '--wiki-root', wikiRoot, '--json'], {
    cwd: root, env: baseEnv, encoding: 'utf8', shell: false,
  });
  assert.equal(usage.status, 2);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', shell: false });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--force bypasses age only/);
  assert.match(help.stdout, /never bypasses owner validity, same-host liveness/);
});

test('runtime lock status rejects a relative wiki root independently of cwd', () => {
  const first = temporaryRoot('deep wiki status cwd one ');
  const second = temporaryRoot('deep wiki status cwd two ');
  for (const cwd of [first, second]) {
    const result = spawnSync(process.execPath, [cli, 'lock', 'status', '--wiki-root', 'relative-root', '--json'], {
      cwd, env: process.env, encoding: 'utf8', shell: false,
    });
    assert.equal(result.status, 4, `${cwd}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^LOCK_INVALID:/);
  }
});
