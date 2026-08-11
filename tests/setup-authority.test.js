'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(result.authority.state, 'committed');
  assert.equal(result.authority.generation, 1);
  assert.equal(result.authority.wiki_root, fs.realpathSync.native(wiki));
  assert.equal(result.authority.requested_wiki_claim.claim_state, 'absent');
  assert.match(result.authority.requested_wiki_claim.route_created_permit.owner_token, /^[a-f0-9]{64}$/);
  assert.equal(
    result.authority.requested_wiki_claim.route_created_permit.operation_id,
    '01K2CP8QT0B2D2QCR6HVG8YM01',
  );
  assert.equal(result.authority.candidates.some((entry) => (
    entry.path === path.join(home, '.codex', 'deep-wiki-config.yaml') && entry.state === 'present'
  )), true);
  assert.equal(fs.existsSync(path.join(home, RESERVATION_DIRECTORY)), false);
  assert.deepEqual(loadSetupAuthority(home), result.authority);
  assert.deepEqual(fs.readFileSync(authorityPath(home)), Buffer.from(`${JSON.stringify(result.authority)}\n`));
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
  assert.equal(resumed.authority.state, 'committed');
  fs.rmSync(wiki, { recursive: true });
  assert.throws(
    () => setup(home, wiki),
    (error) => error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(wiki), false);
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
  assert.equal(completed.authority.state, 'committed');
  assert.equal(completed.authority.generation, 2);
  assert.equal(completed.authority.wiki_root, fs.realpathSync.native(newWiki));
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
  assert.equal(result.status, 'compatible');
  assert.equal(result.authority.generation, 2);
  assert.equal(result.authority.requested_wiki_claim.claim_state, 'present');
  assert.equal(result.authority.requested_wiki_claim.route_created_permit, null);
});
