'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeRecoverySuppressionScope } = require('./helpers/wiki-lint-pruning-fixture.js');

test('initially invalid marker preserves no-op ensure recovery residue', () => {
  const observed = observeRecoverySuppressionScope();
  assert.strictEqual(observed.remaining, 1, 'Expected values to be strictly equal');
});
