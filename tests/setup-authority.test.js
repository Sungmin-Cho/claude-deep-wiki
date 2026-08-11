'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTHORITY_FILE,
  RESERVATION_DIRECTORY,
  loadSetupAuthority,
  resolvePhysicalHome,
  sealAbsentPath,
  revalidatePathSeal,
} = require('../hooks/scripts/runtime/setup-authority.js');
const { setupWiki } = require('../hooks/scripts/runtime/wiki-state.js');

const roots = new Set();
const TS = '2026-08-11T00:00:00Z';

function fixture(prefix = 'deep wiki setup authority ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(root);
  return root;
}

function envFor(home, extra = {}) {
  return { HOME: home, USERPROFILE: home, CODEX_HOME: '', ...extra };
}

function authorityPath(home) {
  return path.join(home, AUTHORITY_FILE);
}

function authorityEvidence(record) {
  const payload = {
    candidates: record.candidates,
    candidate_permits: record.candidate_permits,
    requested_wiki_claim: record.requested_wiki_claim,
  };
  if (record.state === 'rebind_pending') payload.allowed_route_created = record.allowed_route_created;
  return crypto.createHash('sha256').update(Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')).digest('hex');
}

function setup(home, wikiRoot, extra = {}) {
  return setupWiki({
    wikiRoot,
    configHost: 'codex',
    env: envFor(home),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM01',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM02',
    ...extra,
  });
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('physical home aliases converge while divergent physical homes remain separate domains', () => {
  const parent = fixture('deep wiki physical homes ');
  const homeA = path.join(parent, 'home-a');
  const homeB = path.join(parent, 'home-b');
  const aliasA = path.join(parent, 'home-a-alias');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  fs.symlinkSync(homeA, aliasA, 'dir');
  const physicalA = resolvePhysicalHome(envFor(homeA));
  const physicalAlias = resolvePhysicalHome(envFor(aliasA));
  const physicalB = resolvePhysicalHome(envFor(homeB));
  assert.equal(physicalAlias.path, physicalA.path);
  assert.deepEqual(physicalAlias.identity, physicalA.identity);
  assert.notEqual(physicalB.path, physicalA.path);
  assert.equal(physicalA.reservationPath, path.join(homeA, RESERVATION_DIRECTORY));
  assert.equal(physicalA.authorityPath, authorityPath(homeA));
});

test('physical home must be an existing identity-sealed directory', () => {
  const parent = fixture('deep wiki invalid home ');
  const missing = path.join(parent, 'missing');
  const file = path.join(parent, 'file-home');
  fs.writeFileSync(file, 'not a directory');
  assert.throws(
    () => resolvePhysicalHome(envFor(missing)),
    (error) => error.code === 'SETUP_AUTHORITY_INVALID',
  );
  assert.throws(
    () => resolvePhysicalHome(envFor(file)),
    (error) => error.code === 'SETUP_AUTHORITY_INVALID',
  );
});

test('setup through a home symlink publishes only in the sealed physical-home domain', () => {
  const parent = fixture('deep wiki setup home alias ');
  const physicalHome = path.join(parent, 'physical-home');
  const aliasHome = path.join(parent, 'alias-home');
  fs.mkdirSync(physicalHome);
  fs.symlinkSync(physicalHome, aliasHome, 'dir');
  const wiki = path.join(physicalHome, 'wiki');
  const result = setupWiki({
    wikiRoot: wiki,
    configHost: 'codex',
    env: envFor(aliasHome),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM05',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM06',
  });
  assert.equal(result.config.path, path.join(physicalHome, '.codex', 'deep-wiki-config.yaml'));
  assert.equal(fs.existsSync(authorityPath(physicalHome)), true);
  assert.equal(fs.existsSync(path.join(aliasHome, RESERVATION_DIRECTORY)), false);
});

test('setup returns only the committed root decision and generation from durable authority', () => {
  const home = fixture('deep wiki redacted authority home ');
  const vault = fixture('deep wiki redacted authority vault ');
  const wiki = path.join(vault, 'wiki');

  const result = setup(home, wiki);

  assert.deepEqual(result.authority, {
    wiki_root: fs.realpathSync.native(wiki),
    generation: 1,
  });
  assert.doesNotMatch(JSON.stringify(result.authority), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(Object.hasOwn(result.authority, 'owner'), false);
  assert.equal(Object.hasOwn(result.authority, 'candidates'), false);
  assert.equal(Object.hasOwn(result.authority, 'requested_wiki_claim'), false);
});

test('an absent requested wiki below a symlinked container is claimed in the physical path domain', () => {
  const home = fixture('deep wiki physical requested root ');
  const physicalVault = path.join(home, 'physical-vault');
  const existingContainer = path.join(physicalVault, 'existing');
  const aliasVault = path.join(home, 'alias-vault');
  fs.mkdirSync(existingContainer, { recursive: true });
  fs.symlinkSync(physicalVault, aliasVault, 'dir');
  const requestedWiki = path.join(aliasVault, 'existing', 'nested', 'wiki');
  const physicalWiki = path.join(existingContainer, 'nested', 'wiki');

  const result = setup(home, requestedWiki);
  const authority = loadSetupAuthority(home);

  assert.equal(result.authority.wiki_root, fs.realpathSync.native(physicalWiki));
  assert.equal(authority.wiki_root, fs.realpathSync.native(physicalWiki));
  assert.equal(authority.requested_wiki_claim.path, fs.realpathSync.native(physicalWiki));
  assert.match(authority.requested_wiki_claim.route_created_permit.owner_token, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(physicalWiki, 'pages', 'welcome.md')), true);
  assert.equal(setup(home, requestedWiki).status, 'compatible');
});

test('a route-created CODEX_HOME candidate below a symlinked ancestor uses one physical key', () => {
  const home = fixture('deep wiki physical codex candidate ');
  const physicalContainer = path.join(home, 'physical-config');
  const physicalCodexHome = path.join(physicalContainer, 'codex-home');
  const aliasContainer = path.join(home, 'alias-config');
  fs.mkdirSync(physicalCodexHome, { recursive: true });
  fs.symlinkSync(physicalContainer, aliasContainer, 'dir');
  const lexicalCodexHome = path.join(aliasContainer, 'codex-home');
  const lexicalConfig = path.join(lexicalCodexHome, 'deep-wiki-config.yaml');
  const physicalConfig = path.join(physicalCodexHome, 'deep-wiki-config.yaml');
  const wiki = path.join(home, 'wiki');
  const env = envFor(home, { CODEX_HOME: lexicalCodexHome });

  const first = setupWiki({
    wikiRoot: wiki,
    configHost: 'codex',
    env,
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0N',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0P',
  });
  const authority = loadSetupAuthority(home);

  assert.equal(first.config.path, lexicalConfig);
  assert.equal(fs.realpathSync.native(lexicalConfig), physicalConfig);
  assert.equal(authority.state, 'committed');
  assert.equal(authority.candidates.some((entry) => entry.path === physicalConfig && entry.state === 'present'), true);
  assert.equal(authority.candidate_permits.some((permit) => permit.path === physicalConfig), true);
  assert.equal(setupWiki({ wikiRoot: wiki, configHost: 'codex', env, now: new Date(TS) }).status, 'compatible');
});

test('setup accepts an absent opposite-host config under a symlinked host dot-directory', () => {
  const home = fixture('deep wiki symlinked opposite host ');
  const dotfiles = path.join(home, 'dotfiles');
  const physicalClaude = path.join(dotfiles, 'claude');
  fs.mkdirSync(physicalClaude, { recursive: true });
  fs.symlinkSync(physicalClaude, path.join(home, '.claude'), 'dir');
  const wiki = path.join(home, 'wiki');
  const result = setup(home, wiki, { configHost: 'codex' });
  const authority = loadSetupAuthority(home);
  const physicalClaudeConfig = path.join(physicalClaude, 'deep-wiki-config.yaml');

  assert.equal(result.config.path, path.join(home, '.codex', 'deep-wiki-config.yaml'));
  assert.equal(fs.existsSync(physicalClaudeConfig), false);
  assert.equal(
    authority.candidates.some((entry) => entry.state === 'absent' && entry.path === physicalClaudeConfig),
    true,
  );
  assert.equal(setup(home, wiki, { configHost: 'codex' }).status, 'compatible');
});

test('DEEP_WIKI_CONFIG and CODEX_HOME aliases of one route-created file collapse to one physical key', () => {
  const home = fixture('deep wiki twin config aliases ');
  const physicalContainer = path.join(home, 'physical-config');
  const physicalCodexHome = path.join(physicalContainer, 'codex-home');
  const aliasA = path.join(home, 'alias-a');
  const aliasB = path.join(home, 'alias-b');
  fs.mkdirSync(physicalCodexHome, { recursive: true });
  fs.symlinkSync(physicalContainer, aliasA, 'dir');
  fs.symlinkSync(physicalContainer, aliasB, 'dir');
  const lexicalCodexHome = path.join(aliasA, 'codex-home');
  const lexicalExplicit = path.join(aliasB, 'codex-home', 'deep-wiki-config.yaml');
  const physicalConfig = path.join(physicalCodexHome, 'deep-wiki-config.yaml');
  const wiki = path.join(home, 'wiki');
  const env = envFor(home, {
    CODEX_HOME: lexicalCodexHome,
    DEEP_WIKI_CONFIG: lexicalExplicit,
  });

  const first = setupWiki({
    wikiRoot: wiki,
    configHost: 'codex',
    env,
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0Q',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0R',
  });
  const authority = loadSetupAuthority(home);
  const physicalKeys = authority.candidates.filter((entry) => entry.path === physicalConfig);

  assert.equal(first.config.path, path.join(lexicalCodexHome, 'deep-wiki-config.yaml'));
  assert.equal(fs.realpathSync.native(lexicalExplicit), physicalConfig);
  assert.equal(authority.state, 'committed');
  assert.equal(physicalKeys.length, 1);
  assert.equal(authority.candidate_permits.filter((permit) => permit.path === physicalConfig).length, 1);
  assert.equal(setupWiki({ wikiRoot: wiki, configHost: 'codex', env, now: new Date(TS) }).status, 'compatible');
});

test('authority loading rejects noncanonical, duplicate, oversized, and identity-changing records', () => {
  const home = fixture('deep wiki authority parse ');
  const file = authorityPath(home);
  fs.writeFileSync(file, '{"contract_version":1,"contract_version":1}\n');
  assert.throws(() => loadSetupAuthority(home), (error) => error.code === 'SETUP_AUTHORITY_INVALID');
  fs.writeFileSync(file, `${' '.repeat(64 * 1024)}x`);
  assert.throws(() => loadSetupAuthority(home), (error) => error.code === 'SETUP_AUTHORITY_INVALID');
  fs.writeFileSync(file, '{}');
  assert.throws(() => loadSetupAuthority(home), (error) => error.code === 'SETUP_AUTHORITY_INVALID');
  fs.rmSync(file);
  fs.symlinkSync(path.join(home, 'missing-record'), file);
  assert.throws(() => loadSetupAuthority(home), (error) => error.code === 'SETUP_AUTHORITY_INVALID');
});

test('authority loading rejects a canonical JSON record with a non-normalized root decision', () => {
  const home = fixture('deep wiki authority normalized path ');
  const wiki = path.join(home, 'wiki');
  setup(home, wiki);
  const record = loadSetupAuthority(home);
  record.wiki_root = `${home}${path.sep}alias${path.sep}..${path.sep}wiki`;
  fs.writeFileSync(authorityPath(home), `${JSON.stringify(record)}\n`);
  assert.throws(
    () => loadSetupAuthority(home),
    (error) => error.code === 'SETUP_AUTHORITY_INVALID',
  );
});

test('authority loading maps a malformed pending-owner timestamp to its fail-closed error code', () => {
  const home = fixture('deep wiki authority owner timestamp ');
  const wiki = path.join(home, 'wiki');
  assert.throws(() => setup(home, wiki, {
    faultInjector(boundary) {
      if (boundary === 'after-authority-pending') throw new Error('stop after pending');
    },
  }), /stop after pending/);
  const record = loadSetupAuthority(home);
  record.owner.acquired_at = 'not-a-timestamp';
  fs.writeFileSync(authorityPath(home), `${JSON.stringify(record)}\n`);
  assert.throws(
    () => loadSetupAuthority(home),
    (error) => error.code === 'SETUP_AUTHORITY_INVALID',
  );
});

test('absence seals bind the nearest physical ancestor and normalized suffix', () => {
  const home = fixture('deep wiki absence seal ');
  const container = path.join(home, 'container');
  fs.mkdirSync(container);
  const target = path.join(container, 'nested', 'deep-wiki-config.yaml');
  const seal = sealAbsentPath(target);
  assert.equal(seal.state, 'absent');
  assert.equal(seal.ancestor_path, container);
  assert.equal(seal.relative_suffix, path.join('nested', 'deep-wiki-config.yaml'));
  assert.equal(revalidatePathSeal(seal).state, 'absent');
  fs.renameSync(container, path.join(home, 'old-container'));
  fs.mkdirSync(container);
  assert.throws(
    () => revalidatePathSeal(seal),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
});

test('a permitted candidate still rejects an ancestor symlink retarget before pending resume', () => {
  const home = fixture('deep wiki candidate retarget ');
  const wiki = path.join(home, 'wiki');
  assert.throws(() => setup(home, wiki, {
    faultInjector(boundary) {
      if (boundary === 'after-candidate-permit') throw new Error('stop after candidate permit');
    },
  }), /stop after candidate permit/);
  const codexDirectory = path.join(home, '.codex');
  const moved = path.join(home, 'moved-codex');
  fs.renameSync(codexDirectory, moved);
  fs.symlinkSync(moved, codexDirectory, 'dir');
  assert.throws(
    () => setup(home, wiki),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(loadSetupAuthority(home).state, 'pending');
});

test('first install publishes one canonical committed authority with an owner-bound requested-wiki permit', () => {
  const home = fixture('deep wiki first install ');
  const wiki = path.join(home, 'Vault', 'Wiki');
  const result = setup(home, wiki);
  const authority = loadSetupAuthority(home);
  assert.equal(authority.state, 'committed');
  assert.equal(result.authority.generation, 1);
  assert.equal(result.authority.wiki_root, fs.realpathSync.native(wiki));
  assert.equal(authority.requested_wiki_claim.claim_state, 'absent');
  assert.match(authority.requested_wiki_claim.route_created_permit.owner_token, /^[a-f0-9]{64}$/);
  assert.equal(
    authority.requested_wiki_claim.route_created_permit.operation_id,
    '01K2CP8QT0B2D2QCR6HVG8YM01',
  );
  assert.equal(authority.candidates.some((entry) => (
    entry.path === path.join(home, '.codex', 'deep-wiki-config.yaml') && entry.state === 'present'
  )), true);
  assert.equal(fs.existsSync(path.join(home, RESERVATION_DIRECTORY)), false);
  assert.deepEqual(fs.readFileSync(authorityPath(home)), Buffer.from(`${JSON.stringify(authority)}\n`));
});

test('committed same-root setup can publish a second host alias without a pending operation identity', () => {
  const home = fixture('deep wiki dual host setup ');
  const wiki = path.join(home, 'wiki');
  setup(home, wiki, { configHost: 'codex' });

  const second = setup(home, wiki, {
    configHost: 'claude',
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0D',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0E',
  });

  assert.equal(second.status, 'compatible');
  assert.equal(second.config.path, path.join(home, '.claude', 'deep-wiki-config.yaml'));
  assert.equal(fs.existsSync(path.join(home, '.codex', 'deep-wiki-config.yaml')), true);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'deep-wiki-config.yaml')), true);
  assert.equal(loadSetupAuthority(home).state, 'committed');
});

test('committed same-root setup accepts documented removal of legacy global auto_ingest', () => {
  const home = fixture('deep wiki committed global cleanup ');
  const wiki = path.join(home, 'wiki');
  const global = path.join(home, '.codex', 'deep-wiki-config.yaml');
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, [
    `wiki_root: "${wiki}"`,
    'auto_ingest:',
    '  ignore_globs: ["private/**"]',
    '  require_tag: public',
    '',
  ].join('\n'));
  setup(home, wiki);

  fs.writeFileSync(global, `wiki_root: "${wiki}"\n`);

  assert.equal(setup(home, wiki).status, 'compatible');
  assert.equal(loadSetupAuthority(home).state, 'committed');
});

test('committed same-root setup accepts a semantically valid manual global config edit', () => {
  const home = fixture('deep wiki committed global edit ');
  const wiki = path.join(home, 'wiki');
  const global = path.join(home, '.codex', 'deep-wiki-config.yaml');
  setup(home, wiki);

  fs.writeFileSync(global, [
    `wiki_root: "${wiki}"`,
    'obsidian_cli:',
    '  available: true',
    `  vault_path: "${home}"`,
    '  wiki_prefix: wiki',
    '',
  ].join('\n'));

  assert.equal(setup(home, wiki).status, 'compatible');
  assert.equal(loadSetupAuthority(home).state, 'committed');
});

test('committed same-root setup accepts a hand-added second alias for the same root', () => {
  const home = fixture('deep wiki committed second alias ');
  const wiki = path.join(home, 'wiki');
  const claude = path.join(home, '.claude', 'deep-wiki-config.yaml');
  setup(home, wiki);
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, `wiki_root: "${wiki}"\n`);

  assert.equal(setup(home, wiki).status, 'compatible');
  assert.equal(loadSetupAuthority(home).state, 'committed');
});

test('committed same-root setup accepts an authenticated backup restore at the sealed root', () => {
  const home = fixture('deep wiki committed restore ');
  const wiki = path.join(home, 'wiki');
  const backup = path.join(home, 'wiki-backup');
  setup(home, wiki);
  const originalIdentity = fs.lstatSync(wiki, { bigint: true }).ino;
  fs.renameSync(wiki, backup);
  fs.cpSync(backup, wiki, { recursive: true });
  assert.notEqual(fs.lstatSync(wiki, { bigint: true }).ino, originalIdentity);

  assert.equal(setup(home, wiki).status, 'compatible');
  assert.equal(loadSetupAuthority(home).state, 'committed');
});

test('a durable authority rejects a different requested root even when its custom winning target is no longer enumerated', () => {
  const home = fixture('deep wiki hidden candidate ');
  const custom = path.join(home, 'custom-codex');
  fs.mkdirSync(custom);
  const winnerWiki = path.join(home, 'winner-wiki');
  setupWiki({
    wikiRoot: winnerWiki,
    configHost: 'codex',
    env: envFor(home, { CODEX_HOME: custom }),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM03',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM04',
  });
  const loserWiki = path.join(home, 'loser-wiki');
  assert.throws(
    () => setup(home, loserWiki),
    (error) => error.code === 'SETUP_AUTHORITY_CONFLICT',
  );
  assert.equal(fs.existsSync(loserWiki), false);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'deep-wiki-config.yaml')), false);
});

test('different-target first-install race lets only the reservation winner mutate or publish an alias', () => {
  const home = fixture('deep wiki different target race ');
  const losingWiki = path.join(home, 'wiki-a');
  const winningWiki = path.join(home, 'wiki-b');
  let winner;
  assert.throws(() => setupWiki({
    wikiRoot: losingWiki,
    configHost: 'codex',
    env: envFor(home),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM07',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM08',
    faultInjector(boundary) {
      if (boundary === 'before-setup-reservation') {
        winner = setupWiki({
          wikiRoot: winningWiki,
          configHost: 'claude',
          env: envFor(home),
          now: new Date(TS),
          operationId: '01K2CP8QT0B2D2QCR6HVG8YM09',
          eventId: '01K2CP8QT0B2D2QCR6HVG8YM0A',
        });
      }
    },
  }), (error) => error.code === 'SETUP_AUTHORITY_CONFLICT');
  assert.equal(winner.authority.wiki_root, fs.realpathSync.native(winningWiki));
  assert.equal(fs.existsSync(losingWiki), false);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'deep-wiki-config.yaml')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'deep-wiki-config.yaml')), true);
});

test('pending authority refuses foreign and live same-host transition owners', () => {
  for (const [label, mutate, extra] of [
    ['foreign', (record) => { record.owner.hostname = 'foreign-host'; }, {}],
    ['live', (record) => { record.owner.pid += 1000; }, { isPidAlive: () => true }],
  ]) {
    const home = fixture(`deep wiki ${label} pending owner `);
    const wiki = path.join(home, 'wiki');
    assert.throws(() => setup(home, wiki, {
      faultInjector(boundary) {
        if (boundary === 'after-authority-pending') throw new Error('stop after pending');
      },
    }), /stop after pending/);
    const record = loadSetupAuthority(home);
    mutate(record);
    fs.writeFileSync(authorityPath(home), `${JSON.stringify(record)}\n`);
    assert.throws(
      () => setup(home, wiki, extra),
      (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
    );
    assert.equal(fs.existsSync(wiki), false);
  }
});

test('pending recovery reads the union and rejects an unrecorded present candidate', () => {
  const home = fixture('deep wiki pending candidate union ');
  const customCodex = path.join(home, 'custom-codex');
  fs.mkdirSync(customCodex);
  const wiki = path.join(home, 'wiki');
  assert.throws(() => setupWiki({
    wikiRoot: wiki,
    configHost: 'codex',
    env: envFor(home, { CODEX_HOME: customCodex }),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0B',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0C',
    faultInjector(boundary) {
      if (boundary === 'after-authority-pending') throw new Error('stop after pending');
    },
  }), /stop after pending/);
  const explicit = path.join(home, 'late-explicit.yaml');
  fs.writeFileSync(explicit, `wiki_root: "${wiki}"\n`);
  assert.throws(
    () => setupWiki({
      wikiRoot: wiki,
      configHost: 'codex',
      env: envFor(home, { DEEP_WIKI_CONFIG: explicit }),
      now: new Date(TS),
    }),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(wiki), false);
});

test('a pending absent-root claim rejects ancestor replacement and a compatible same-lexical wiki without its permit', () => {
  const home = fixture('deep wiki pending claim ');
  const container = path.join(home, 'vault-container');
  fs.mkdirSync(container);
  const wiki = path.join(container, 'wiki');
  assert.throws(() => setup(home, wiki, {
    faultInjector(boundary) {
      if (boundary === 'after-authority-pending') throw new Error('stop after pending');
    },
  }), /stop after pending/);
  fs.renameSync(container, path.join(home, 'original-container'));
  fs.mkdirSync(container);
  fs.mkdirSync(wiki);
  assert.throws(
    () => setup(home, wiki),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.deepEqual(fs.readdirSync(wiki), []);
});

test('a present-at-claim root is revalidated on resume and cannot be authenticated by a missing permit', () => {
  const home = fixture('deep wiki present claim ');
  const wiki = path.join(home, 'prepared-wiki');
  fs.mkdirSync(wiki);
  assert.throws(() => setup(home, wiki, {
    faultInjector(boundary) {
      if (boundary === 'after-authority-pending') throw new Error('stop after pending');
    },
  }), /stop after pending/);
  fs.rmdirSync(wiki);
  assert.throws(
    () => setup(home, wiki),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(wiki), false);
});

test('a published absent-to-present permit resumes, but later re-absence fails closed', () => {
  const home = fixture('deep wiki permit recovery ');
  const wiki = path.join(home, 'wiki');
  assert.throws(() => setup(home, wiki, {
    faultInjector(boundary) {
      if (boundary === 'after-route-created-permit') throw new Error('stop after permit');
    },
  }), /stop after permit/);
  const resumed = setup(home, wiki);
  assert.equal(loadSetupAuthority(home).state, 'committed');
  assert.equal(resumed.authority.wiki_root, fs.realpathSync.native(wiki));
  fs.rmSync(wiki, { recursive: true });
  assert.throws(
    () => setup(home, wiki),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(wiki), false);
});

test('rebind_pending without a selected config host preserves a null target and resumes safely', () => {
  const home = fixture('deep wiki hostless rebind ');
  const oldWiki = path.join(home, 'wiki-a');
  const newWiki = path.join(home, 'wiki-b');
  const global = path.join(home, '.codex', 'deep-wiki-config.yaml');
  setup(home, oldWiki);
  fs.rmSync(oldWiki, { recursive: true });
  fs.writeFileSync(global, `wiki_root: "${newWiki}"\n`);

  assert.throws(() => setupWiki({
    wikiRoot: newWiki,
    rebindAuthorityFrom: oldWiki,
    env: envFor(home),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0F',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0G',
    faultInjector(boundary) {
      if (boundary === 'after-rebind-pending') throw new Error('stop hostless rebind');
    },
  }), /stop hostless rebind/);
  assert.equal(loadSetupAuthority(home).selected_target, null);

  const resumed = setupWiki({
    wikiRoot: newWiki,
    rebindAuthorityFrom: oldWiki,
    env: envFor(home),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0H',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0J',
  });
  assert.equal(fs.existsSync(path.join(newWiki, 'pages', 'welcome.md')), true);
  assert.equal(resumed.authority.wiki_root, fs.realpathSync.native(newWiki));
});

test('setup without a selected config host still migrates an eligible legacy policy', () => {
  const home = fixture('deep wiki hostless migration ');
  const wiki = path.join(home, 'wiki');
  const global = path.join(home, '.codex', 'deep-wiki-config.yaml');
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, [
    `wiki_root: "${wiki}"`,
    'auto_ingest:',
    '  ignore_globs: ["private/**"]',
    '  require_tag: public',
    '',
  ].join('\n'));

  const result = setupWiki({
    wikiRoot: wiki,
    env: envFor(home),
    now: new Date(TS),
    operationId: '01K2CP8QT0B2D2QCR6HVG8YM0K',
    eventId: '01K2CP8QT0B2D2QCR6HVG8YM0M',
  });

  assert.equal(result.migration.status, 'migrated');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(wiki, '.wiki-meta', '.config.json'), 'utf8')),
    { auto_ingest: { ignore_globs: ['private/**'], require_tag: 'public' } },
  );
});

test('explicit rebind requires exact old-root authorization and never restores A after rebind_pending publication', () => {
  const home = fixture('deep wiki rebind ');
  const oldWiki = path.join(home, 'wiki-a');
  setup(home, oldWiki);
  fs.rmSync(oldWiki, { recursive: true });
  const newWiki = path.join(home, 'wiki-b');
  const config = path.join(home, '.codex', 'deep-wiki-config.yaml');
  fs.writeFileSync(config, `wiki_root: "${newWiki}"\n`);
  assert.throws(
    () => setup(home, newWiki, { rebindAuthorityFrom: path.join(home, 'wrong-a') }),
    (error) => error.code === 'SETUP_AUTHORITY_CONFLICT',
  );
  assert.throws(() => setup(home, newWiki, {
    rebindAuthorityFrom: oldWiki,
    faultInjector(boundary) {
      if (boundary === 'after-rebind-pending') throw new Error('stop after rebind pending');
    },
  }), /stop after rebind pending/);
  const pending = loadSetupAuthority(home);
  assert.equal(pending.state, 'rebind_pending');
  assert.equal(pending.previous_root, path.normalize(oldWiki));
  assert.equal(pending.wiki_root, path.normalize(newWiki));
  assert.throws(
    () => setup(home, oldWiki),
    (error) => ['SETUP_AUTHORITY_CONFLICT', 'SETUP_AUTHORITY_RECOVERY_REQUIRED'].includes(error.code),
  );
  assert.equal(loadSetupAuthority(home).state, 'rebind_pending');
  const completed = setup(home, newWiki, { rebindAuthorityFrom: oldWiki });
  assert.equal(loadSetupAuthority(home).state, 'committed');
  assert.equal(completed.authority.generation, 2);
  assert.equal(completed.authority.wiki_root, fs.realpathSync.native(newWiki));
});

test('rebind resume consumes allowed_route_created before creating an absent wiki', () => {
  const home = fixture('deep wiki rebind route-created allowlist ');
  const oldWiki = path.join(home, 'wiki-a');
  const newWiki = path.join(home, 'wiki-b');
  setup(home, oldWiki);
  fs.rmSync(oldWiki, { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'deep-wiki-config.yaml'), `wiki_root: "${newWiki}"\n`);
  assert.throws(() => setup(home, newWiki, {
    rebindAuthorityFrom: oldWiki,
    faultInjector(boundary) {
      if (boundary === 'after-rebind-pending') throw new Error('stop after rebind pending');
    },
  }), /stop after rebind pending/);
  const pending = loadSetupAuthority(home);
  const physicalNewWiki = fs.realpathSync.native(path.dirname(newWiki)) + path.sep + path.basename(newWiki);
  assert.equal(pending.allowed_route_created.includes(physicalNewWiki), true);
  pending.allowed_route_created = pending.allowed_route_created.filter((entry) => entry !== physicalNewWiki);
  pending.evidence_sha256 = authorityEvidence(pending);
  fs.writeFileSync(authorityPath(home), `${JSON.stringify(pending)}\n`);

  assert.throws(
    () => setup(home, newWiki, { rebindAuthorityFrom: oldWiki }),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(newWiki), false);
  assert.equal(loadSetupAuthority(home).state, 'rebind_pending');
});

test('rebind resume commits absent-to-created proof without retaining the transient route allowlist', () => {
  const home = fixture('deep wiki rebind route-created proof ');
  const oldWiki = path.join(home, 'wiki-a');
  const newWiki = path.join(home, 'wiki-b');
  setup(home, oldWiki);
  fs.rmSync(oldWiki, { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'deep-wiki-config.yaml'), `wiki_root: "${newWiki}"\n`);
  assert.throws(() => setup(home, newWiki, {
    rebindAuthorityFrom: oldWiki,
    faultInjector(boundary) {
      if (boundary === 'after-rebind-pending') throw new Error('stop after rebind pending');
    },
  }), /stop after rebind pending/);
  const pending = loadSetupAuthority(home);
  assert.equal(pending.state, 'rebind_pending');
  assert.equal(pending.allowed_route_created.includes(path.join(home, 'wiki-b')), true);

  const result = setup(home, newWiki, { rebindAuthorityFrom: oldWiki });
  const committed = loadSetupAuthority(home);

  assert.equal(result.authority.generation, 2);
  assert.equal(committed.state, 'committed');
  assert.equal(Object.hasOwn(committed, 'allowed_route_created'), false);
  assert.equal(committed.requested_wiki_claim.claim_state, 'absent');
  assert.match(committed.requested_wiki_claim.route_created_permit.owner_token, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(newWiki, 'pages', 'welcome.md')), true);
});

test('explicit rebind preserves a sealed pre-existing B wiki without inventing a route-created permit', () => {
  const home = fixture('deep wiki preexisting rebind ');
  const preparerHome = fixture('deep wiki preexisting rebind preparer ');
  const oldWiki = path.join(home, 'wiki-a');
  const newWiki = path.join(home, 'wiki-b');
  setup(home, oldWiki);
  setup(preparerHome, newWiki);
  fs.rmSync(oldWiki, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'deep-wiki-config.yaml'),
    `wiki_root: "${newWiki}"\n`,
  );
  const result = setup(home, newWiki, { rebindAuthorityFrom: oldWiki });
  const authority = loadSetupAuthority(home);
  assert.equal(result.status, 'compatible');
  assert.equal(result.authority.generation, 2);
  assert.equal(authority.requested_wiki_claim.claim_state, 'present');
  assert.equal(authority.requested_wiki_claim.route_created_permit, null);
});
