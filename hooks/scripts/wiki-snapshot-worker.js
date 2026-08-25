#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { createDeadline } = require('./runtime/deadline.js');
const { snapshotWiki } = require('./runtime/wiki-state.js');

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--wiki-root', '--budget-ms']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || Object.hasOwn(values, flag)) {
      throw new Error('invalid snapshot worker arguments');
    }
    values[flag] = value;
  }
  if (!hasExactKeys(values, allowed)
      || typeof values['--wiki-root'] !== 'string'
      || !path.isAbsolute(values['--wiki-root'])
      || !/^\d+$/.test(values['--budget-ms'])) {
    throw new Error('invalid snapshot worker arguments');
  }
  const budgetMs = Number(values['--budget-ms']);
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 12_000) {
    throw new Error('invalid snapshot worker budget');
  }
  return { wikiRoot: path.normalize(values['--wiki-root']), budgetMs };
}

function snapshotErrorDetail(error) {
  const operationId = error && error.operationId;
  if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 256
      || !/^[.]?[A-Za-z0-9._-]+$/.test(operationId)) return null;
  const method = error.method;
  if (method !== 'stat' && method !== 'enumeration' && method !== 'none') return null;
  const estimated = error.estimatedEntries;
  if (!(estimated === null || (Number.isSafeInteger(estimated) && estimated >= 0))) return null;
  return {
    operation_id: operationId,
    estimated_entries: estimated,
    method,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    emit({
      contract_version: 1,
      status: 'ok',
      snapshot: snapshotWiki({
        wikiRoot: options.wikiRoot,
        deadline: createDeadline({ budgetMs: options.budgetMs }),
      }),
    });
    return 0;
  } catch (error) {
    const payload = {
      code: typeof error.code === 'string' && error.code ? error.code : 'FILESYSTEM',
      message: error instanceof Error ? error.message : String(error),
    };
    const detail = snapshotErrorDetail(error);
    if (detail) payload.detail = detail;
    emit({
      contract_version: 1,
      status: 'error',
      error: payload,
    });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArguments, snapshotErrorDetail };
