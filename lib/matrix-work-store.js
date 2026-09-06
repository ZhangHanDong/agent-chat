import { randomUUID } from 'node:crypto';

// Commands belong to the backend; account credentials remain in bridge-state.json.
// Only command metadata and public outcomes are persisted here.
export function createMatrixWorkStore({ load, persist, now = Date.now }) {
  let rows = load() || [];
  if (!Array.isArray(rows)) throw new Error('invalid Matrix work store');
  function mutate(fn) {
    const before = structuredClone(rows);
    try {
      const result = fn();
      if (persist(rows) === false) throw new Error('Matrix work persistence failed');
      return structuredClone(result);
    } catch (error) { rows = before; throw error; }
  }
  return {
    enqueue({ action, agent, sideId, localpart, roomId = null, mxid = null, engagementId = null }) {
      const existing = rows.find((r) => r.action === action && r.agent === agent
        && r.sideId === sideId && r.roomId === roomId && r.state !== 'complete');
      if (existing) return structuredClone(existing);
      return mutate(() => {
        const row = { id: randomUUID(), action, agent, sideId, localpart, roomId, mxid, engagementId,
          state: 'pending', createdAt: now() };
        rows.push(row);
        const completed = rows.filter((r) => r.state === 'complete');
        const prune = new Set(completed.slice(0, Math.max(0, completed.length - 500)).map((r) => r.id));
        rows = rows.filter((r) => !prune.has(r.id));
        return row;
      });
    },
    claim() {
      const row = rows.find((r) => r.state === 'pending' || r.state === 'running' && r.leaseUntil <= now());
      if (!row) return null;
      return mutate(() => {
        Object.assign(row, { state: 'running', claimToken: randomUUID(), leaseUntil: now() + 90_000 });
        return row;
      });
    },
    complete(id, claimToken, outcome) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.claimToken !== claimToken) throw new Error('stale Matrix work claim');
      if (row.state === 'complete') return structuredClone(row);
      return mutate(() => {
        row.state = 'complete';
        // An allowlist prevents an accidental bridge token response becoming another secret store.
        row.outcome = { ok: outcome.ok === true, mxid: typeof outcome.mxid === 'string' ? outcome.mxid : null,
          code: typeof outcome.code === 'string' ? outcome.code.slice(0, 80) : null };
        row.completedAt = now();
        return row;
      });
    },
    unsettled(sideId) { return rows.some((r) => r.sideId === sideId && r.state !== 'complete'); },
    loggedOut(agent, sideId) { return rows.some((r) => r.agent === agent && r.sideId === sideId && ['logout', 'representative-logout'].includes(r.action) && r.outcome?.ok); },
    list() { return rows.map(({ claimToken: _claim, ...row }) => structuredClone(row)); },
    get(id) { return structuredClone(rows.find((r) => r.id === id) || null); },
  };
}

export async function awaitMatrixWork(store, id, { timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  do {
    const row = store.get(id);
    if (row?.state === 'complete') return row.outcome;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error('Matrix bridge work remains pending; retry after the bridge completes it');
}
