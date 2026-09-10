import { expect, test } from 'vitest';
import { startAppserviceSyncCollector } from '../lib/appservice-sync.js';

test('sync gap bounds are recorded before cursor advancement', async () => {
  let polls = 0;
  let ticks = 0;
  let cursor = 'before';
  const operations = [];
  const collector = startAppserviceSyncCollector({
    baseUrl: 'https://side.test', side: 'side.test',
    credentialFor: () => ({ asToken: 'as', hsToken: 'hs', senderLocalpart: 'hagency' }),
    router: { handle: async () => ({ status: 200 }) },
    readCursor: () => cursor,
    writeCursor: async (value) => { operations.push(['cursor', value]); cursor = value; },
    writePendingReconcile: (...args) => operations.push(['reconcile', ...args]),
    onRoomsNeedingReconcile: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/login')) return Response.json({ access_token: 'access', user_id: '@hagency:side.test' });
      polls += 1;
      return Response.json({ next_batch: 'after', rooms: { join: {
        '!room:side.test': { timeline: { limited: true, events: [{ type: 'm.room.message', event_id: '$latest' }] } },
      } } });
    },
    shouldContinue: () => { if (++ticks > 10) throw new Error('collector watchdog'); return polls < 1; },
    sleep: async () => { throw new Error('unexpected retry'); },
  });
  try { await collector.loop; } finally { collector.stop(); }
  expect(operations).toEqual([
    ['reconcile', '!room:side.test', 'pending', { kind: 'gap', from: 'before', to: 'after' }],
    ['cursor', 'after'],
    ['reconcile', '!room:side.test', 'cleared'],
  ]);
});
