// ADR-025: an authenticated project definition selects its funding pool.
// Role-only requests retain the separate project-side allocation policy.
export const usesResourcePool = engagement => Boolean(engagement?.requestContext?.agentDefinition);

export function holdsAllocation(e) {
  return e.state === 'active' || (e.state === 'pending' && e.fulfillment
    && !['failed', 'complete'].includes(e.fulfillment.phase));
}

/** Operator projection; never publish these commitments in the public catalog. */
export function resourceAllocationBudget({ preset, seatId, declaration, commitments, excludeEngagementId = null, forAutoJoin = false }) {
  let poolCommitted = 0, seatCommitted = 0, reserved = 0;
  for (const row of commitments) {
    if (!holdsAllocation(row)) continue;
    const tokens = row.allocatedTokens ?? 0;
    if (row.id === excludeEngagementId) {
      if (row.presetId === preset.id) reserved = tokens;
      continue;
    }
    if (row.presetId === preset.id) poolCommitted += tokens;
    if (row.seatId === seatId) seatCommitted += tokens;
  }
  const ceiling = Number.isFinite(preset.ceiling?.tokens) ? preset.ceiling.tokens : null;
  const quota = Number.isFinite(declaration?.quotaTokens) ? declaration.quotaTokens : null;
  const matchingPeriod = declaration?.period === preset.ceiling?.period;
  const pool = { ceiling, period: preset.ceiling?.period ?? null, committed: poolCommitted,
    remaining: ceiling === null ? null : Math.max(0, ceiling - poolCommitted) };
  const seat = { quota, period: declaration?.period ?? null, committed: seatCommitted,
    remaining: quota === null || !matchingPeriod ? null : Math.max(0, quota - seatCommitted),
    status: quota === null ? 'undeclared' : matchingPeriod ? 'declared' : 'period_mismatch' };
  const unknown = ceiling === null || seat.status === 'period_mismatch'
    || forAutoJoin && declaration && seat.remaining === null;
  const remainingTokens = unknown ? null : Math.min(pool.remaining, seat.remaining ?? Infinity);
  return { scope: 'resource', pool, seat, reserved, remainingTokens };
}
