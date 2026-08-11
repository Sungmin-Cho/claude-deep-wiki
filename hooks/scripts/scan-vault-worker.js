'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ISO_UTC_RE,
  compilePortableGlob,
  canonicalPolicyDigest,
  loadWikiLocalConfig,
  readFrontmatterTags,
  resolveConfig,
  resolveEffectivePolicy,
} = require('./runtime/config.js');
const { createDeadline, assertBeforeDeadline } = require('./runtime/deadline.js');

const WORKER_BUDGET_MS = 11_000;
const MAX_FILES = 20;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POLICY_SOURCES = new Set(['default', 'global_legacy', 'wiki_local', 'wiki_local_migrated']);
const EXCLUDED_DIRECTORIES = new Set([
  '.obsidian', '.trash', '.git', '.wiki-meta', 'node_modules',
  '.claude', '.codex', '.ssh', '.gnupg', '.aws', '.azure', '.kube',
]);

function codePointCompare(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalNow(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function readTimestamp(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch { return null; }
  if (!ISO_UTC_RE.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) return null;
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function verifySupervisorPolicyProof(resolved, env = process.env) {
  const expectedSource = env.DEEP_WIKI_EXPECTED_POLICY_SOURCE;
  const expectedDigest = env.DEEP_WIKI_EXPECTED_POLICY_SHA256;
  if (typeof expectedSource !== 'string' || !POLICY_SOURCES.has(expectedSource)) {
    throw new Error('policy proof source is invalid');
  }
  if (typeof expectedDigest !== 'string' || !SHA256_RE.test(expectedDigest)) {
    throw new Error('policy proof digest is invalid');
  }
  if (resolved.policy_source !== expectedSource) {
    throw new Error('policy source transition is not allowed');
  }
  if (resolved.policy_digest !== expectedDigest) {
    throw new Error('policy digest does not match supervisor proof');
  }
}

function effectiveAutoIngestPolicy(resolved) {
  const localConfig = loadWikiLocalConfig(resolved.config.wikiRoot);
  const effective = resolveEffectivePolicy({ globalConfig: resolved.config, localConfig });
  if (effective.policySource !== resolved.policy_source
      || canonicalPolicyDigest(effective.policy) !== resolved.policy_digest) {
    throw new Error('policy proof resolved state changed before scanning');
  }
  return effective.policy;
}

function scanVault({ vaultRoot, wikiRoot, boundMs, config, deadline }) {
  const globs = config.autoIngest.ignoreGlobs.map((value) => compilePortableGlob(value));
  const requiredTag = config.autoIngest.requireTag;
  const found = new Set();

  function visit(directory, relativeDirectory) {
    assertBeforeDeadline(deadline, `scan-directory:${relativeDirectory || '.'}`);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => codePointCompare(left.name, right.name));
    assertBeforeDeadline(deadline, `scan-directory-result:${relativeDirectory || '.'}`);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertBeforeDeadline(deadline, `scan-entry:${relative}`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || isInside(wikiRoot, absolute)) continue;
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      if (entry.name === 'Personal To-dos.md' || entry.name === 'Work To-dos.md'
          || entry.name.startsWith('VPN ')) continue;
      const portable = relative.replaceAll('\\', '/');
      if (globs.some((glob) => glob.test(portable))) continue;
      assertBeforeDeadline(deadline, `scan-stat:${relative}`);
      const stat = fs.statSync(absolute);
      assertBeforeDeadline(deadline, `scan-stat-result:${relative}`);
      if (!(stat.mtimeMs > boundMs)) continue;
      if (requiredTag && !readFrontmatterTags(absolute, { deadline }).includes(requiredTag)) continue;
      assertBeforeDeadline(deadline, `scan-candidate:${relative}`);
      found.add(portable);
    }
  }

  visit(vaultRoot, '');
  assertBeforeDeadline(deadline, 'scan-complete');
  return [...found].sort(codePointCompare);
}

function workerMain() {
  const deadline = createDeadline({ budgetMs: WORKER_BUDGET_MS });
  const detectedAt = canonicalNow();
  const resolved = resolveConfig(process.env);
  assertBeforeDeadline(deadline, 'config-resolved');
  verifySupervisorPolicyProof(resolved, process.env);
  assertBeforeDeadline(deadline, 'policy-proof-verified');
  const autoIngest = effectiveAutoIngestPolicy(resolved);
  assertBeforeDeadline(deadline, 'effective-policy-resolved');
  const wikiRoot = fs.realpathSync.native(resolved.config.wikiRoot);
  const vaultRoot = fs.realpathSync.native(path.dirname(wikiRoot));
  const meta = path.join(wikiRoot, '.wiki-meta');
  const last = readTimestamp(path.join(meta, '.last-scan'));
  const pending = last ? null : readTimestamp(path.join(meta, '.pending-scan'));
  const bound = last || pending || canonicalNow(new Date(Date.now() - 60 * 60 * 1000));
  const files = scanVault({
    vaultRoot,
    wikiRoot,
    boundMs: Date.parse(bound),
    config: { autoIngest },
    deadline,
  });
  const result = {
    contract_version: 1,
    status: 'ok',
    detected_at: detectedAt,
    wiki_root: wikiRoot,
    vault_root: vaultRoot,
    total: files.length,
    files: files.slice(0, MAX_FILES),
  };
  assertBeforeDeadline(deadline, 'worker-result-publication');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) workerMain();

module.exports = {
  WORKER_BUDGET_MS,
  workerMain,
  scanVault,
  readTimestamp,
  verifySupervisorPolicyProof,
};
