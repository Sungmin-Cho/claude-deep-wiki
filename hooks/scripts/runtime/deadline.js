'use strict';

const MAX_BUDGET_MS = 12_000;

const monotonicClock = Object.freeze({
  nowMs() {
    return Number(process.hrtime.bigint()) / 1_000_000;
  },
});

class DeadlineExceeded extends Error {
  constructor(boundary) {
    super(`DEADLINE_EXCEEDED at ${boundary}`);
    this.name = 'DeadlineExceeded';
    this.code = 'DEADLINE_EXCEEDED';
    this.boundary = boundary;
  }
}

function createDeadline({ clock = monotonicClock, budgetMs } = {}) {
  if (!clock || typeof clock.nowMs !== 'function') throw new TypeError('deadline clock must expose nowMs()');
  if (!Number.isFinite(budgetMs) || !Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > MAX_BUDGET_MS) {
    throw new RangeError('deadline budgetMs must be an integer from 1 through 12_000');
  }
  const startedAtMs = clock.nowMs();
  if (!Number.isFinite(startedAtMs)) throw new TypeError('deadline clock must return a finite number');
  return Object.freeze({ clock, startedAtMs, expiresAtMs: startedAtMs + budgetMs, budgetMs });
}

function assertBeforeDeadline(deadline, boundary) {
  if (!deadline || !deadline.clock || typeof deadline.clock.nowMs !== 'function') {
    throw new TypeError('a deadline created by createDeadline() is required');
  }
  if (typeof boundary !== 'string' || boundary.length === 0) throw new TypeError('deadline boundary is required');
  if (deadline.clock.nowMs() >= deadline.expiresAtMs) throw new DeadlineExceeded(boundary);
}

module.exports = {
  createDeadline,
  assertBeforeDeadline,
  DeadlineExceeded,
};
