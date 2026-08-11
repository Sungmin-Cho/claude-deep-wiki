'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

const {
  canonicalPolicyDigest,
  loadWikiLocalConfig,
  resolveConfig,
  resolveEffectivePolicy,
} = require('./config.js');
const { assertBeforeDeadline } = require('./deadline.js');
const { atomicWriteFile, regularFileIdentity, regularFileIdentitiesMatch, sha256 } = require('./fs-safe.js');
const { acquireLock, assertLockOwner, releaseLock } = require('./lock.js');

const MIGRATION_OPERATION = 'config-migration';

function configError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'ConfigMigrationError';
  error.code = code;
  return error;
}

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realpathNative(fs, pathname) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  return realpath(pathname);
}

function physicalDirectory(fs, pathname, label) {
  let physical;
  try { physical = realpathNative(fs, pathname); } catch (cause) {
    throw configError('CONFIG_INVALID', `${label} cannot be resolved`, cause);
  }
  let stat;
  try { stat = fs.lstatSync(physical, { bigint: true }); } catch (cause) {
    throw configError('CONFIG_INVALID', `${label} cannot be inspected`, cause);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw configError('CONFIG_INVALID', `${label} must be a physical directory`);
  }
  return physical;
}

function assertMetaDirectory(fs, wikiRoot) {
  const meta = path.join(wikiRoot, '.wiki-meta');
  let stat;
  try { stat = fs.lstatSync(meta, { bigint: true }); } catch (cause) {
    throw configError('CONFIG_INVALID', 'wiki metadata directory cannot be inspected', cause);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw configError('CONFIG_INVALID', 'wiki metadata directory must be a physical directory');
  }
  return meta;
}

function targetSeal(fs, target) {
  let before;
  try { before = fs.lstatSync(target, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return { status: 'absent' };
    throw configError('CONFIG_INVALID', 'wiki-local config cannot be inspected', cause);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw configError('CONFIG_INVALID', 'wiki-local config must be a regular non-symlink file');
  }
  const identity = regularFileIdentity(before);
  if (!identity) throw configError('CONFIG_INVALID', 'wiki-local config identity is unavailable or linked');
  let bytes;
  try { bytes = fs.readFileSync(target); } catch (cause) {
    throw configError('CONFIG_INVALID', 'wiki-local config cannot be read', cause);
  }
  let after;
  try { after = fs.lstatSync(target, { bigint: true }); } catch (cause) {
    throw configError('CONFIG_INVALID', 'wiki-local config identity was lost', cause);
  }
  if (after.isSymbolicLink() || !after.isFile()
      || !regularFileIdentitiesMatch(identity, regularFileIdentity(after))) {
    throw configError('CONFIG_INVALID', 'wiki-local config identity changed while reading');
  }
  return { status: 'present', identity, digest: sha256(bytes) };
}

function sameTargetSeal(left, right) {
  if (left.status !== right.status) return false;
  if (left.status === 'absent') return true;
  return left.digest === right.digest && regularFileIdentitiesMatch(left.identity, right.identity);
}

function invokeFault(faultInjector, boundary) {
  if (typeof faultInjector === 'function') return faultInjector(boundary);
  if (faultInjector?.[boundary] === true) throw new Error(`injected fault at ${boundary}`);
  return undefined;
}

function policyResult(status, effective) {
  return {
    status,
    policy: effective.policy,
    policySource: effective.policySource,
  };
}

function resolveState({ env, wikiRoot, fs }) {
  const resolved = resolveConfig(env, { fs });
  const physicalRoot = physicalDirectory(fs, wikiRoot, 'wiki root');
  if (!samePath(physicalRoot, resolved.config.wikiRoot)) {
    throw configError('CONFIG_INVALID', 'migration wiki root does not match the resolved global configuration');
  }
  assertMetaDirectory(fs, physicalRoot);
  const local = loadWikiLocalConfig(physicalRoot, { fs });
  const effective = resolveEffectivePolicy({ globalConfig: resolved.config, localConfig: local });
  return { physicalRoot, global: resolved.config, local, effective };
}

function canonicalLocalBytes(local, policy) {
  const output = {};
  if (local.status === 'present' && Object.hasOwn(local.config, 'a5FanoutThreshold')) {
    output.a5_fanout_threshold = local.config.a5FanoutThreshold;
  }
  if (local.status === 'present' && Object.hasOwn(local.config, 'a5WorkerTimeoutSec')) {
    output.a5_worker_timeout_sec = local.config.a5WorkerTimeoutSec;
  }
  output.auto_ingest = { ignore_globs: policy.ignoreGlobs };
  if (policy.requireTag !== null) output.auto_ingest.require_tag = policy.requireTag;
  return Buffer.from(`${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function assertPublicationBoundary({ env, wikiRoot, fs, deadline, token, expectedSeal, expectedPolicy, faultInjector, boundary }) {
  if (boundary) invokeFault(faultInjector, boundary);
  assertBeforeDeadline(deadline, `config-migration:${boundary || 'pre-write'}`);
  assertLockOwner({ wikiRoot, token, fs });
  if (!samePath(physicalDirectory(fs, wikiRoot, 'wiki root'), wikiRoot)) {
    throw configError('CONFIG_INVALID', 'wiki root changed before migration publication');
  }
  assertMetaDirectory(fs, wikiRoot);
  if (!sameTargetSeal(expectedSeal, targetSeal(fs, path.join(wikiRoot, '.wiki-meta', '.config.json')))) {
    throw configError('CONFIG_INVALID', 'wiki-local config changed before publication');
  }
  const current = resolveState({ env, wikiRoot, fs });
  if (!current.effective.migrationRequired) {
    throw configError('CONFIG_INVALID', 'wiki-local configuration changed before migration publication');
  }
  if (canonicalPolicyDigest(current.effective.policy) !== canonicalPolicyDigest(expectedPolicy)) {
    throw configError('CONFIG_CONFLICT', 'legacy auto-ingest policy changed before migration publication');
  }
}

function classifyAtomicError({ error, initial, initialSeal, env, wikiRoot, fs }) {
  const current = resolveState({ env, wikiRoot, fs });
  if (!samePath(current.physicalRoot, wikiRoot)) {
    throw configError('CONFIG_INVALID', 'wiki root changed during migration', error);
  }
  const currentDigest = canonicalPolicyDigest(current.effective.policy);
  const expectedDigest = canonicalPolicyDigest(initial.effective.policy);
  if (current.effective.policySource === 'wiki_local_migrated' && currentDigest === expectedDigest) {
    return policyResult('migrated', current.effective);
  }
  const currentSeal = targetSeal(fs, path.join(wikiRoot, '.wiki-meta', '.config.json'));
  if (current.effective.migrationRequired && currentDigest === expectedDigest
      && sameTargetSeal(initialSeal, currentSeal)) {
    return policyResult('deferred', current.effective);
  }
  if (current.effective.policySource === 'wiki_local_migrated') {
    throw configError('CONFIG_CONFLICT', 'wiki-local auto-ingest policy diverged during migration', error);
  }
  throw configError('CONFIG_INVALID', 'wiki-local config changed during migration', error);
}

function migrateAutoIngestPolicy(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || nodeFs;
  const deadline = options.deadline;
  const requestedRoot = options.wikiRoot;
  if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot)) {
    throw configError('CONFIG_INVALID', 'wikiRoot must be absolute');
  }
  const preflight = resolveState({ env, wikiRoot: requestedRoot, fs });
  if (!preflight.effective.migrationRequired) return policyResult('already-local', preflight.effective);
  let owner;
  try {
    assertBeforeDeadline(deadline, 'config-migration:before-lock');
    owner = acquireLock({ wikiRoot: preflight.physicalRoot, operation: MIGRATION_OPERATION, fs });
  } catch (error) {
    if (error?.code === 'LOCK_CONTENDED' || error?.code === 'DEADLINE_EXCEEDED') {
      return policyResult('deferred', preflight.effective);
    }
    throw error;
  }

  let result;
  let primaryError;
  try {
    const target = path.join(preflight.physicalRoot, '.wiki-meta', '.config.json');
    const initialSeal = targetSeal(fs, target);
    const initial = resolveState({ env, wikiRoot: preflight.physicalRoot, fs });
    if (!samePath(initial.physicalRoot, preflight.physicalRoot)) {
      throw configError('CONFIG_INVALID', 'wiki root changed while acquiring the wiki lock');
    }
    if (!initial.effective.migrationRequired) {
      if (initial.effective.policySource !== 'wiki_local_migrated'
          || canonicalPolicyDigest(initial.effective.policy) !== canonicalPolicyDigest(preflight.effective.policy)) {
        throw configError('CONFIG_INVALID', 'migration preconditions changed while acquiring the wiki lock');
      }
      result = policyResult('already-local', initial.effective);
    } else {
      assertPublicationBoundary({
        env, wikiRoot: initial.physicalRoot, fs, deadline, token: owner.token,
        expectedSeal: initialSeal, expectedPolicy: initial.effective.policy,
        faultInjector: options.faultInjector, boundary: null,
      });
      const bytes = canonicalLocalBytes(initial.local, initial.effective.policy);
      try {
        atomicWriteFile(target, bytes, {
          fs,
          createParent: false,
          beforeRename: () => assertPublicationBoundary({
            env, wikiRoot: initial.physicalRoot, fs, deadline, token: owner.token,
            expectedSeal: initialSeal, expectedPolicy: initial.effective.policy,
            faultInjector: options.faultInjector, boundary: 'before-rename',
          }),
          beforePublish: () => assertPublicationBoundary({
            env, wikiRoot: initial.physicalRoot, fs, deadline, token: owner.token,
            expectedSeal: initialSeal, expectedPolicy: initial.effective.policy,
            faultInjector: options.faultInjector, boundary: 'before-publish',
          }),
        });
        const after = resolveState({ env, wikiRoot: initial.physicalRoot, fs });
        if (after.effective.policySource !== 'wiki_local_migrated'
            || canonicalPolicyDigest(after.effective.policy) !== canonicalPolicyDigest(initial.effective.policy)) {
          throw configError('CONFIG_INVALID', 'published wiki-local configuration cannot be validated');
        }
        result = policyResult('migrated', after.effective);
      } catch (error) {
        assertLockOwner({ wikiRoot: initial.physicalRoot, token: owner.token, fs });
        result = classifyAtomicError({
          error, initial, initialSeal, env, wikiRoot: initial.physicalRoot, fs,
        });
      }
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    assertLockOwner({ wikiRoot: preflight.physicalRoot, token: owner.token, fs });
    releaseLock({ wikiRoot: preflight.physicalRoot, token: owner.token, fs });
  } catch (releaseError) {
    if (primaryError) primaryError.release_error = releaseError;
    else primaryError = releaseError;
  }
  if (primaryError) throw primaryError;
  return result;
}

module.exports = {
  migrateAutoIngestPolicy,
};
