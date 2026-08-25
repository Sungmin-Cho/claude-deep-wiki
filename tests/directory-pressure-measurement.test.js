'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRESSURE_ENTRY_CAP,
  PRESSURE_SIZE_THRESHOLD,
  PRESSURE_NLINK_THRESHOLD,
} = require('../hooks/scripts/runtime/transaction-debris.js');

function fillDirectory(root, count) {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(root, `e${String(index).padStart(5, '0')}`), '');
  }
}

function measure(root, entries) {
  const stat = fs.lstatSync(root, { bigint: true });
  return {
    platform: process.platform,
    entries,
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    sizeThreshold: PRESSURE_SIZE_THRESHOLD,
    nlinkThreshold: PRESSURE_NLINK_THRESHOLD,
  };
}

test('directory pressure measurement records lstat nlink and size at cap+1', (t) => {
  assert.equal(PRESSURE_ENTRY_CAP, 4096);
  assert.equal(PRESSURE_SIZE_THRESHOLD, 196608);
  assert.equal(PRESSURE_NLINK_THRESHOLD, 512);

  const healthy = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki pressure healthy ')));
  const oversized = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki pressure measure ')));
  try {
    fillDirectory(healthy, 9);
    const healthyObservation = measure(healthy, 9);
    console.log(JSON.stringify({ measurement: 'directory-pressure-healthy', ...healthyObservation }));

    const count = PRESSURE_ENTRY_CAP + 1;
    fillDirectory(oversized, count);
    const observation = measure(oversized, count);
    const sizeOver = observation.size > PRESSURE_SIZE_THRESHOLD;
    const nlinkOver = observation.nlink > PRESSURE_NLINK_THRESHOLD;
    console.log(JSON.stringify({
      measurement: 'directory-pressure',
      ...observation,
      sizeOverThreshold: sizeOver,
      nlinkOverThreshold: nlinkOver,
    }));

    const hasSignal = observation.size > 0 || observation.nlink > 2;
    if (!hasSignal) {
      t.skip('no directory-stat signal on this platform (NTFS reports size 0, nlink 1)');
      return;
    }
    assert.equal(Number.isFinite(observation.size), true);
    assert.equal(Number.isFinite(observation.nlink), true);
    assert.equal(typeof sizeOver, 'boolean');
    assert.equal(typeof nlinkOver, 'boolean');
    // False-positive bound: a healthy ~9-entry store directory must stay
    // below both thresholds. cap+1 may sit on either side — APFS nlink
    // tracks file count, so cap+1 is expected to exceed NLINK_THRESHOLD.
    assert.equal(healthyObservation.size > PRESSURE_SIZE_THRESHOLD, false,
      `healthy size ${healthyObservation.size} exceeded PRESSURE_SIZE_THRESHOLD`);
    assert.equal(healthyObservation.nlink > PRESSURE_NLINK_THRESHOLD, false,
      `healthy nlink ${healthyObservation.nlink} exceeded PRESSURE_NLINK_THRESHOLD`);
  } finally {
    fs.rmSync(healthy, { recursive: true, force: true });
    fs.rmSync(oversized, { recursive: true, force: true });
  }
});
