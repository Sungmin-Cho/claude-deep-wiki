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
} = require(path.join(runtimeRoot, 'lock.js'));

const HELP = `deep-wiki portable runtime

Usage:
  node scripts/wiki-runtime.js config resolve --json
  node scripts/wiki-runtime.js lock acquire --wiki-root <absolute> --operation <name> --json
  node scripts/wiki-runtime.js lock status --wiki-root <absolute> --json
  node scripts/wiki-runtime.js lock release --wiki-root <absolute> --token <token> --json
  node scripts/wiki-runtime.js lock recover --wiki-root <absolute> --stale-ms <integer> [--force] --json

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

function exitCode(error) {
  if (error.code === 'USAGE') return 2;
  if (['LOCK_CONTENDED', 'LOCK_TOKEN_MISMATCH'].includes(error.code)) return 3;
  if (error.code === 'CONFIG_CONFLICT' || error.code === 'CONFIG_TARGET_CONFLICT'
      || error.code === 'CONFIG_NOT_FOUND' || error.code === 'CONFIG_INVALID'
      || error.code === 'LOCK_INVALID') return 4;
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
    else throw new UsageError('command must be config or lock');
    return 0;
  } catch (error) {
    process.stderr.write(`${error.code || 'FILESYSTEM'}: ${error.message}\n`);
    return exitCode(error);
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
