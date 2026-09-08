import { expect, test } from 'vitest';
import { resourceAllocationBudget } from '../lib/resource-allocation-budget.js';

const base = { preset: { id: 'medium', ceiling: { tokens: 1000, period: 'monthly' } }, seatId: 'shared' };
const active = (id, presetId, tokens, seatId = 'shared') => ({ id, presetId, allocatedTokens: tokens, seatId, state: 'active' });

test('pool ledger counts unprovisioned reservations once and releases ended or failed allocations', () => {
  const commitments = [active('other-pool', 'high', 4000), active('other-account', 'private', 9000, 'private'),
    active('active', 'medium', 100), { ...active('reserved', 'medium', 200), state: 'pending', fulfillment: { phase: 'planned' } },
    { ...active('ended', 'medium', 10000), state: 'ended' },
    { ...active('failed', 'medium', 10000), state: 'pending', fulfillment: { phase: 'failed' } },
    { ...active('not-approved', 'medium', 10000), state: 'pending', allocatedTokens: null }];
  const budget = resourceAllocationBudget({ ...base, commitments });
  expect(budget).toMatchObject({ remainingTokens: 700, pool: { committed: 300, remaining: 700 }, seat: { committed: 4300, quota: null, remaining: null } });
  expect(resourceAllocationBudget({ ...base, commitments, excludeEngagementId: 'reserved' })).toMatchObject({
    reserved: 200, remainingTokens: 900, pool: { committed: 100 }, seat: { committed: 4100 },
  });
});

test('a declared account quota cannot be bypassed with a different pool period', () => {
  const options = { ...base, commitments: [], declaration: { quotaTokens: 100, period: 'daily' } };
  expect(resourceAllocationBudget(options)).toMatchObject({ remainingTokens: null, seat: { status: 'period_mismatch' } });
  expect(resourceAllocationBudget({ ...options, declaration: { quotaTokens: 100, period: 'monthly' } })).toMatchObject({ remainingTokens: 100 });
  expect(resourceAllocationBudget({ ...options, declaration: { quotaTokens: 0, period: 'monthly' } })).toMatchObject({ remainingTokens: 0 });
  expect(resourceAllocationBudget({ ...base, commitments: [], declaration: {}, forAutoJoin: true }).remainingTokens).toBeNull();
});
