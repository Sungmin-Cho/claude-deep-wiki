'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER_BASENAME = 'scan-window-maintenance.json';
const MARKER_RELATIVE = path.join('.wiki-meta', '.runtime', MARKER_BASENAME);

function markerPath(root) {
  return path.join(root, MARKER_RELATIVE);
}

function runtimePath(root) {
  return path.join(root, '.wiki-meta', '.runtime');
}

function metaPath(root) {
  return path.join(root, '.wiki-meta');
}

function quarantinePath(root) {
  return path.join(root, '.wiki-meta', '.quarantine');
}

function emptyMarker(overrides = {}) {
  return {
    schema: 1,
    updated_at: '2026-08-25T00:00:00Z',
    prune_failures: [],
    promoted: [],
    skipped_oversized: [],
    quarantine_bundles: [],
    ...overrides,
  };
}

function canonicalMarkerObject(marker) {
  return {
    schema: marker.schema,
    updated_at: marker.updated_at,
    prune_failures: marker.prune_failures,
    promoted: marker.promoted,
    skipped_oversized: marker.skipped_oversized,
    quarantine_bundles: marker.quarantine_bundles,
  };
}

function canonicalMarkerBytes(marker) {
  return Buffer.from(`${JSON.stringify(canonicalMarkerObject(marker))}\n`, 'utf8');
}

function ensureWikiMeta(root) {
  fs.mkdirSync(metaPath(root), { recursive: true });
  return root;
}

function ensureRuntime(root) {
  ensureWikiMeta(root);
  try { fs.mkdirSync(runtimePath(root), { recursive: false }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return root;
}

function writeRawMarker(root, bytes) {
  ensureRuntime(root);
  fs.writeFileSync(markerPath(root), bytes);
  return markerPath(root);
}

function bundleName({ stamp = '20260825T000000Z', pid = '1', uuid } = {}, index = 0) {
  const hex = uuid || index.toString(16).padStart(32, '0');
  return `${stamp}-${pid}-${hex}`;
}

function bundleRecord(overrides = {}, index = 0) {
  return {
    bundle: bundleName({}, index),
    source_name: `scan-window-ensure-${index.toString(16).padStart(40, '0')}`,
    state: 'pending',
    at: '2026-08-25T00:00:00Z',
    ...overrides,
  };
}

function countCappedMarker() {
  return emptyMarker({
    prune_failures: Array.from({ length: 8 }, (_, index) => ({
      code: 'PRUNE_FAIL',
      at: '2026-08-25T00:00:00Z',
    })).map((row, index) => ({ ...row, at: `2026-08-25T00:00:0${index}Z` })),
    promoted: Array.from({ length: 32 }, (_, index) => `promoted-${index}`),
    skipped_oversized: Array.from({ length: 32 }, (_, index) => `skipped-${index}`),
    quarantine_bundles: Array.from({ length: 64 }, (_, index) => bundleRecord({
      state: index < 16 ? 'complete' : index < 32 ? 'pending' : 'incomplete',
    }, index)),
  });
}

function longestAdmittedName(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (let length = 255; length >= 1; length -= 1) {
    const name = 'a'.repeat(length);
    const target = path.join(directory, name);
    try {
      fs.mkdirSync(target);
      fs.rmdirSync(target);
      return name;
    } catch {
      // Platform rejected this length; try a shorter component.
    }
  }
  throw new Error('platform admitted no directory name');
}

function worstCaseFilledMarker(name) {
  return emptyMarker({
    promoted: Array.from({ length: 32 }, (_, index) => `${name}-${String(index).padStart(2, '0')}`),
    skipped_oversized: Array.from({ length: 32 }, (_, index) => `s${name}-${String(index).padStart(2, '0')}`),
  });
}

function maxFittingMarkerBytes(maxBytes, probeDirectory) {
  const admitted = longestAdmittedName(probeDirectory);
  const candidates = [];
  for (let length = Math.min(admitted.length, 255); length >= 8; length -= 8) {
    const marker = worstCaseFilledMarker(admitted.slice(0, length));
    const bytes = canonicalMarkerBytes(marker);
    if (bytes.length <= maxBytes) candidates.push({ length, bytes, marker });
  }
  const short = worstCaseFilledMarker('n');
  const shortBytes = canonicalMarkerBytes(short);
  if (shortBytes.length <= maxBytes) candidates.push({ length: 1, bytes: shortBytes, marker: short });
  if (candidates.length === 0) throw new Error('no marker candidate fitted the byte budget');
  candidates.sort((left, right) => right.bytes.length - left.bytes.length);
  return candidates[0];
}

function replaceWithSymlink(source, target) {
  fs.rmSync(source, { recursive: true, force: true });
  fs.symlinkSync(target, source);
}

module.exports = {
  MARKER_BASENAME,
  MARKER_RELATIVE,
  markerPath,
  runtimePath,
  metaPath,
  quarantinePath,
  emptyMarker,
  canonicalMarkerObject,
  canonicalMarkerBytes,
  ensureWikiMeta,
  ensureRuntime,
  writeRawMarker,
  bundleName,
  bundleRecord,
  countCappedMarker,
  longestAdmittedName,
  worstCaseFilledMarker,
  maxFittingMarkerBytes,
  replaceWithSymlink,
};
