#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { createDeadline } = require('./runtime/deadline.js');
const { ensurePendingScan } = require('./runtime/scan-window.js');

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--wiki-root', '--proposed', '--budget-ms']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || Object.hasOwn(values, flag)) {
      throw new Error('invalid scan-window worker arguments');
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== allowed.size
      || typeof values['--wiki-root'] !== 'string'
      || !path.isAbsolute(values['--wiki-root'])
      || !/^\d+$/.test(values['--budget-ms'])) {
    throw new Error('invalid scan-window worker arguments');
  }
  const budgetMs = Number(values['--budget-ms']);
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 12_000) {
    throw new Error('invalid scan-window worker budget');
  }
  return {
    wikiRoot: path.normalize(values['--wiki-root']),
    proposed: values['--proposed'],
    budgetMs,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = ensurePendingScan({
    wikiRoot: options.wikiRoot,
    proposed: options.proposed,
    now: new Date(options.proposed),
    deadline: createDeadline({ budgetMs: options.budgetMs }),
  });
  if (!result || result.status === 'deferred') process.exitCode = 2;
}

try { main(); } catch { process.exitCode = 1; }
