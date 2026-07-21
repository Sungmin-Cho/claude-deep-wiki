#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runtimeRoot = path.resolve(__dirname, '..', 'hooks', 'scripts', 'runtime');
const { resolveConfig } = require(path.join(runtimeRoot, 'config.js'));
const {
  acquireLock,
  releaseLock,
  recoverLock,
  assertLockOwner,
} = require(path.join(runtimeRoot, 'lock.js'));
const wikiState = require(path.join(runtimeRoot, 'wiki-state.js'));
const { sha256 } = require(path.join(runtimeRoot, 'fs-safe.js'));
const { probeObsidian, runObsidian } = require(path.join(runtimeRoot, 'obsidian-probe.js'));

const HELP = `deep-wiki portable runtime

Usage:
  node scripts/wiki-runtime.js config resolve --json
  node scripts/wiki-runtime.js lock acquire --wiki-root <absolute> --operation <name> --json
  node scripts/wiki-runtime.js lock status --wiki-root <absolute> --json
  node scripts/wiki-runtime.js lock release --wiki-root <absolute> --token <token> --json
  node scripts/wiki-runtime.js lock recover --wiki-root <absolute> --stale-ms <integer> [--force] --json
  node scripts/wiki-runtime.js setup --wiki-root <absolute> --config-host <claude|codex> [--replace-config] --json
  node scripts/wiki-runtime.js probe obsidian --json
  node scripts/wiki-runtime.js obsidian search --query <text> [--limit <n>] --json
  node scripts/wiki-runtime.js obsidian backlinks --path <vault-note-path> --json
  node scripts/wiki-runtime.js obsidian tags --json
  node scripts/wiki-runtime.js snapshot --wiki-root <absolute> --json
  node scripts/wiki-runtime.js commit --wiki-root <absolute> --lock-token <token> --manifest-file <absolute-json> --json
  node scripts/wiki-runtime.js transaction recover --wiki-root <absolute> --lock-token <token> --operation-id <id> --json
  node scripts/wiki-runtime.js index read --wiki-root <absolute> --json
  node scripts/wiki-runtime.js scan-window promote --wiki-root <absolute> --lock-token <token> --expected <UTC-Z> --json
  node scripts/wiki-runtime.js scan-window fail --wiki-root <absolute> --lock-token <token> --source <slug> --json
  node scripts/wiki-runtime.js inbox cleanup --wiki-root <absolute> --lock-token <token> --max-age-days 7 --json
  node scripts/wiki-runtime.js lint inspect --wiki-root <absolute> --json
  node scripts/wiki-runtime.js lint fix --wiki-root <absolute> --json

Recovery safety:
  --force bypasses age only. It never bypasses owner validity, same-host liveness,
  complete owner equality, or lock-directory identity checks.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

function parseFlags(argv, schema) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!Object.hasOwn(schema, flag) || Object.hasOwn(values, flag)) throw new UsageError(`unknown or repeated flag: ${flag}`);
    if (schema[flag] === 'boolean') values[flag] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${flag}`);
      values[flag] = value;
      index += 1;
    }
  }
  return values;
}

function requireFlag(flags, name) {
  if (!Object.hasOwn(flags, name) || flags[name] === '') throw new UsageError(`required flag missing: ${name}`);
  return flags[name];
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function lockOwner(wikiRoot) {
  const ownerPath = path.join(wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function validateLockWikiRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    const error = new Error('wikiRoot must be absolute');
    error.code = 'LOCK_INVALID';
    throw error;
  }
  return path.normalize(value);
}

function runConfig(argv) {
  if (argv[0] !== 'resolve') throw new UsageError('config requires the resolve command');
  const flags = parseFlags(argv.slice(1), { '--json': 'boolean' });
  requireFlag(flags, '--json');
  emit(resolveConfig(process.env));
}

function runLock(argv) {
  const command = argv[0];
  if (!command) throw new UsageError('lock command is required');
  if (command === 'acquire') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--operation': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    emit(acquireLock({
      wikiRoot: requireFlag(flags, '--wiki-root'),
      operation: requireFlag(flags, '--operation'),
    }));
    return;
  }
  if (command === 'status') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    const wikiRoot = validateLockWikiRoot(requireFlag(flags, '--wiki-root'));
    const owner = lockOwner(wikiRoot);
    emit({ locked: fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), owner });
    return;
  }
  if (command === 'release') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--token': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    releaseLock({
      wikiRoot: requireFlag(flags, '--wiki-root'),
      token: requireFlag(flags, '--token'),
    });
    emit({ released: true });
    return;
  }
  if (command === 'recover') {
    const flags = parseFlags(argv.slice(1), {
      '--wiki-root': 'value', '--stale-ms': 'value', '--force': 'boolean', '--json': 'boolean',
    });
    requireFlag(flags, '--json');
    const rawStale = requireFlag(flags, '--stale-ms');
    if (!/^\d+$/.test(rawStale)) throw new UsageError('--stale-ms must be a nonnegative integer');
    emit({
      recovered: recoverLock({
        wikiRoot: requireFlag(flags, '--wiki-root'),
        staleMs: Number(rawStale),
        force: flags['--force'] === true,
      }),
    });
    return;
  }
  throw new UsageError(`unsupported lock command: ${command}`);
}

function wikiFlags(argv, schema) {
  const flags = parseFlags(argv, { '--wiki-root': 'value', '--json': 'boolean', ...schema });
  requireFlag(flags, '--json');
  requireFlag(flags, '--wiki-root');
  return flags;
}

function readManifestFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new UsageError('--manifest-file must be absolute');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (cause) { throw Object.assign(new Error(`manifest file is unavailable: ${cause.message}`), { code: 'MANIFEST_INVALID' }); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('manifest file must be regular and non-symlink'), { code: 'MANIFEST_INVALID' });
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw Object.assign(new Error(`manifest file is invalid JSON: ${cause.message}`), { code: 'MANIFEST_INVALID' }); }
}

function runSetup(argv) {
  const flags = wikiFlags(argv, { '--config-host': 'value', '--replace-config': 'boolean' });
  emit(wikiState.setupWiki({
    wikiRoot: flags['--wiki-root'],
    configHost: requireFlag(flags, '--config-host'),
    replaceConfig: flags['--replace-config'] === true,
    env: process.env,
  }));
}

function runProbe(argv) {
  if (argv[0] !== 'obsidian') throw new UsageError('probe requires the obsidian target');
  const flags = parseFlags(argv.slice(1), { '--json': 'boolean' });
  requireFlag(flags, '--json');
  emit(probeObsidian());
}

function runObsidianBridge(argv) {
  const subcommand = argv[0];
  const schemas = {
    search: { '--query': 'value', '--limit': 'value', '--json': 'boolean' },
    backlinks: { '--path': 'value', '--json': 'boolean' },
    tags: { '--json': 'boolean' },
  };
  if (!subcommand || !Object.hasOwn(schemas, subcommand)) {
    throw new UsageError(`obsidian requires one of: ${Object.keys(schemas).join(', ')}`);
  }
  const flags = parseFlags(argv.slice(1), schemas[subcommand]);
  requireFlag(flags, '--json');
  let limit;
  if (subcommand === 'search') {
    requireFlag(flags, '--query');
    if (flags['--limit'] !== undefined) {
      if (!/^\d+$/.test(flags['--limit'])) throw new UsageError('--limit must be a nonnegative integer');
      limit = Number(flags['--limit']);
    }
  }
  if (subcommand === 'backlinks') requireFlag(flags, '--path');

  let obsidianCli = null;
  try { obsidianCli = resolveConfig(process.env).config.obsidianCli; } catch { obsidianCli = null; }
  if (obsidianCli && obsidianCli.enabled === false) {
    emit({
      ok: false, found: false, executable: null, source: null, format: null, data: null,
      error: 'obsidian integration is disabled in the resolved configuration',
    });
    return;
  }
  emit(runObsidian({
    subcommand,
    query: flags['--query'],
    targetPath: flags['--path'],
    limit,
    vaultName: obsidianCli ? obsidianCli.vaultName : null,
  }));
}

function runSnapshot(argv) {
  const flags = wikiFlags(argv, {});
  emit(wikiState.snapshotWiki({ wikiRoot: flags['--wiki-root'] }));
}

function cleanupRuntimeManifests(wikiRoot, token, operationId) {
  const root = path.resolve(wikiRoot);
  const directory = path.join(root, '.wiki-meta', '.runtime');
  assertLockOwner({ wikiRoot: root, token });
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.operation_id !== operationId) continue;
    assertLockOwner({ wikiRoot: root, token });
    fs.rmSync(file, { force: true });
    assertLockOwner({ wikiRoot: root, token });
  }
}

function recoverHint(wikiRoot, operationId) {
  const root = path.resolve(wikiRoot);
  return `resume with:\nnode scripts/wiki-runtime.js transaction recover --wiki-root "${root}" --lock-token <token> --operation-id ${operationId} --json`;
}

function transactionDurablyExists(wikiRoot, operationId) {
  const transaction = path.join(path.resolve(wikiRoot), '.wiki-meta', '.transactions', operationId);
  return fs.existsSync(path.join(transaction, 'journal.json'))
    || fs.existsSync(path.join(transaction, 'cancelled.json'));
}

function commitRetryHint(wikiRoot, manifestFile) {
  const root = path.resolve(wikiRoot);
  const manifest = path.resolve(manifestFile);
  return `rerun with:\nnode scripts/wiki-runtime.js commit --wiki-root "${root}" --lock-token <token> --manifest-file "${manifest}" --json`;
}

function runCommit(argv) {
  const flags = wikiFlags(argv, { '--lock-token': 'value', '--manifest-file': 'value' });
  const manifestFile = requireFlag(flags, '--manifest-file');
  const token = requireFlag(flags, '--lock-token');
  const manifest = readManifestFile(manifestFile);
  let result;
  try {
    result = wikiState.applyCommit({
      wikiRoot: flags['--wiki-root'],
      token,
      manifest,
    });
  } catch (error) {
    if (error.code === 'DEADLINE_EXCEEDED') {
      error.message = transactionDurablyExists(flags['--wiki-root'], manifest.operation_id)
        ? `${error.message} — ${recoverHint(flags['--wiki-root'], manifest.operation_id)}`
        : `${error.message} — ${commitRetryHint(flags['--wiki-root'], manifestFile)}`;
    }
    throw error;
  }
  emit(result);
  const runtimeDirectory = path.join(path.resolve(flags['--wiki-root']), '.wiki-meta', '.runtime');
  const relative = path.relative(runtimeDirectory, path.resolve(manifestFile));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    try {
      cleanupRuntimeManifests(flags['--wiki-root'], token, manifest.operation_id);
    } catch (error) {
      if (error.code !== 'LOCK_TOKEN_MISMATCH') throw error;
      process.stderr.write(`WARNING: runtime manifest cleanup skipped after lock ownership changed: ${error.message}\n`);
    }
  }
}

function runTransaction(argv) {
  if (argv[0] !== 'recover') throw new UsageError('transaction requires recover');
  const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--operation-id': 'value' });
  const token = requireFlag(flags, '--lock-token');
  const operationId = requireFlag(flags, '--operation-id');
  let result;
  try {
    result = wikiState.recoverTransaction({
      wikiRoot: flags['--wiki-root'], token, operationId,
    });
  } catch (error) {
    if (error.code === 'DEADLINE_EXCEEDED') {
      error.message = `${error.message} — ${recoverHint(flags['--wiki-root'], operationId)}`;
    }
    throw error;
  }
  emit(result);
  try {
    cleanupRuntimeManifests(flags['--wiki-root'], token, operationId);
  } catch (error) {
    if (error.code !== 'LOCK_TOKEN_MISMATCH') throw error;
    process.stderr.write(`WARNING: runtime manifest cleanup skipped after lock ownership changed: ${error.message}\n`);
  }
}

function runIndex(argv) {
  if (argv[0] !== 'read') throw new UsageError('index requires read');
  const flags = wikiFlags(argv.slice(1), {});
  emit(wikiState.snapshotWiki({ wikiRoot: flags['--wiki-root'] }).index);
}

function runScanWindow(argv) {
  const command = argv[0];
  if (command === 'promote') {
    const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--expected': 'value' });
    const expected = requireFlag(flags, '--expected');
    emit(wikiState.promotePendingScan({
      wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'), expected,
      operationId: `scan-window-cli-${sha256(Buffer.from(`${flags['--wiki-root']}\0${expected}`)).slice(0, 40)}`,
    }));
    return;
  }
  if (command === 'fail') {
    const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--source': 'value' });
    emit(wikiState.registerIngestFailure({
      wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'),
      source: requireFlag(flags, '--source'),
    }));
    return;
  }
  throw new UsageError('scan-window requires promote or fail');
}

function runInbox(argv) {
  if (argv[0] !== 'cleanup') throw new UsageError('inbox requires cleanup');
  const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--max-age-days': 'value' });
  const raw = requireFlag(flags, '--max-age-days');
  if (!/^\d+$/.test(raw)) throw new UsageError('--max-age-days must be a nonnegative integer');
  emit(wikiState.cleanupInbox({
    wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'), maxAgeDays: Number(raw),
  }));
}

function runLint(argv) {
  const command = argv[0];
  const flags = wikiFlags(argv.slice(1), {});
  if (command === 'inspect') emit(wikiState.inspectWiki({ wikiRoot: flags['--wiki-root'] }));
  else if (command === 'fix') emit(wikiState.fixWiki({ wikiRoot: flags['--wiki-root'] }));
  else throw new UsageError('lint requires inspect or fix');
}

function exitCode(error) {
  if (error.code === 'USAGE') return 2;
  if (['LOCK_CONTENDED', 'LOCK_TOKEN_MISMATCH'].includes(error.code)) return 3;
  if (error.code === 'CONFIG_CONFLICT' || error.code === 'CONFIG_TARGET_CONFLICT'
      || error.code === 'CONFIG_NOT_FOUND' || error.code === 'CONFIG_INVALID'
      || error.code === 'LOCK_INVALID' || error.code === 'MANIFEST_INVALID'
      || error.code === 'EXPECTED_HASH_CONFLICT' || error.code === 'TRANSACTION_CANCELLED'
      || error.code === 'WIKI_STATE_INVALID') return 4;
  return 5;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (argv[0] === 'config') runConfig(argv.slice(1));
    else if (argv[0] === 'lock') runLock(argv.slice(1));
    else if (argv[0] === 'setup') runSetup(argv.slice(1));
    else if (argv[0] === 'probe') runProbe(argv.slice(1));
    else if (argv[0] === 'obsidian') runObsidianBridge(argv.slice(1));
    else if (argv[0] === 'snapshot') runSnapshot(argv.slice(1));
    else if (argv[0] === 'commit') runCommit(argv.slice(1));
    else if (argv[0] === 'transaction') runTransaction(argv.slice(1));
    else if (argv[0] === 'index') runIndex(argv.slice(1));
    else if (argv[0] === 'scan-window') runScanWindow(argv.slice(1));
    else if (argv[0] === 'inbox') runInbox(argv.slice(1));
    else if (argv[0] === 'lint') runLint(argv.slice(1));
    else throw new UsageError('unsupported command family');
    return 0;
  } catch (error) {
    process.stderr.write(`${error.code || 'FILESYSTEM'}: ${error.message}\n`);
    return exitCode(error);
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, recoverHint, commitRetryHint, cleanupRuntimeManifests };
