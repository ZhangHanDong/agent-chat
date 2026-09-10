import { describe, expect, test, vi } from 'vitest';
import { startRepresentativeSyncCollector, reconcileRepresentativeTimeline } from '../lib/representative-sync.js';

const response = body => ({ ok: true, status: 200, json: async () => body });
const base = {
  side: 'project.test', baseUrl: 'https://project.invalid', registration: 'project.test@generation',
  representativeMxid: '@rep:project.test',
  accessToken: 'fixture-representative-token', logger: { warn() {} }, sleep: async () => {},
};

describe('registration representative collector', () => {
  test('representative sync reports an unprovable gap once and preserves blocked recovery', async () => {
    const pending = new Set(['!p:project.test']);
    const warning = vi.fn();
    const readPage = vi.fn();
    const onReconcile = vi.fn(() => reconcileRepresentativeTimeline({ from: null, knownEventIds: [], readPage, onEvents: vi.fn() }));
    let polls = 0;
    const collector = startRepresentativeSyncCollector({ ...base, onEvents: async () => {},
      readCursor: () => 'existing', shouldContinue: () => polls < 3,
      fetchImpl: async () => { polls += 1; return response({ next_batch: `next-${polls}`, rooms: {} }); },
      readPendingReconcile: () => [...pending], onReconcile,
      writePendingReconcile: async (room, verdict) => { if (verdict === 'cleared') pending.delete(room); },
      onReconcileBlocked: warning,
    });
    await collector.loop;
    expect(onReconcile).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledExactlyOnceWith('!p:project.test', expect.stringContaining('no proven'));
    expect(readPage).not.toHaveBeenCalled();
    expect(pending.has('!p:project.test')).toBe(true);
    expect(polls).toBe(3);
  });

  test('registration representative sync delivers invites and retries before committing its cursor', async () => {
    let cursor = null;
    let polls = 0;
    const delivered = [];
    const cursors = [];
    const invite = { type: 'm.room.member', sender: '@borrower:project.test',
      state_key: '@rep:project.test', content: { membership: 'invite' } };
    const event = { type: 'm.room.message', event_id: '$work', sender: '@borrower:project.test', content: { body: 'work' } };
    const fetchImpl = vi.fn(async (input, options) => {
      expect(options.headers.Authorization).toBe('Bearer fixture-representative-token');
      expect(new URL(input).pathname).toBe('/_matrix/client/v3/sync');
      expect(new URL(input).searchParams.get('user_id')).toBeNull();
      polls += 1;
      if (polls === 1) return response({ next_batch: 'one', rooms: {
        invite: { '!p:project.test': { invite_state: { events: [invite] } } },
        join: { '!old:project.test': { timeline: { events: [{ ...event, event_id: '$old' }] } } },
      } });
      expect(new URL(input).searchParams.get('since')).toBe('one');
      return response({ next_batch: 'two', rooms: { join: { '!p:project.test': { timeline: { events: [event] } } } } });
    });
    let failed = false;
    const collector = startRepresentativeSyncCollector({ ...base, fetchImpl,
      shouldContinue: () => cursor !== 'two', readCursor: () => cursor,
      writeCursor: async value => { cursor = value; cursors.push(value); },
      onEvents: async (events, meta) => {
        expect(meta.provenance).toEqual({ registration: base.registration, sideId: base.side, mode: 'sync' });
        delivered.push(events);
        if (events[0].event_id === '$work' && !failed) { failed = true; throw new Error('backend unavailable'); }
      },
    });
    await collector.loop;
    expect(cursors).toEqual(['one', 'two']);
    expect(delivered.map(events => events.map(event => event.event_id || event.content.membership)))
      .toEqual([['invite'], ['$work'], ['$work']]);
    expect(collector.stats.failed).toBe(1);
    expect(collector.stats.batchAttempts).toBe(0);
  });

  test('registration representative sync aborts stopped polls and never dispatches stale results', async () => {
    let finish;
    let signal;
    const onEvents = vi.fn();
    const writeCursor = vi.fn();
    const collector = startRepresentativeSyncCollector({ ...base, onEvents, writeCursor,
      readCursor: () => 'previous',
      fetchImpl: async (_input, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
      },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    collector.stop();
    expect(signal.aborted).toBe(true);
    finish(response({ next_batch: 'stale', rooms: { join: { '!p:project.test': {
      timeline: { events: [{ type: 'm.room.message', event_id: '$stale' }] },
    } } } }));
    await collector.loop;
    expect(onEvents).not.toHaveBeenCalled();
    expect(writeCursor).not.toHaveBeenCalled();
  });

  test('registration representative sync persists pending gaps before cursor commit and retries recovery', async () => {
    const calls = [];
    const pending = new Set();
    let polls = 0;
    let recovered = false;
    const collector = startRepresentativeSyncCollector({ ...base, readCursor: () => 'previous',
      shouldContinue: () => polls < 2,
      fetchImpl: async () => { polls += 1; return response({ next_batch: `next-${polls}`, rooms: { join: {
        '!p:project.test': { timeline: { limited: polls === 1, events: [] } },
      } } }); },
      readPendingReconcile: () => [...pending],
      writePendingReconcile: async (room, verdict) => { calls.push(verdict); if (verdict === 'pending') pending.add(room); else pending.delete(room); },
      writeCursor: async () => calls.push('cursor'), onEvents: async () => {},
      onReconcile: async () => { if (!recovered) { recovered = true; throw new Error('transient history failure'); } },
    });
    await collector.loop;
    expect(calls).toEqual(['pending', 'cursor', 'cleared']);
    expect(pending.size).toBe(0);
  });

  test('registration representative sync circuit breaks poison delivery without consuming its cursor', async () => {
    const warning = vi.fn();
    const writeCursor = vi.fn();
    const collector = startRepresentativeSyncCollector({ ...base, writeCursor, onCircuitBreak: warning,
      readCursor: () => 'held', onEvents: async () => { throw new Error('poison'); },
      fetchImpl: async () => response({ next_batch: 'uncommitted', rooms: { join: { '!p:project.test': {
        timeline: { events: [{ type: 'm.room.message', event_id: '$failed' }] },
      } } } }),
    });
    await collector.loop;
    expect(collector.stats.polls).toBe(8);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempts: 8, heldCursor: 'held' }));
    expect(writeCursor).not.toHaveBeenCalled();
  });

  test('registration sync gap recovery stops at a recorded event and never guesses a history boundary', async () => {
    const event = id => ({ type: 'm.room.message', event_id: id });
    const onEvents = vi.fn();
    const readPage = vi.fn()
      .mockResolvedValueOnce({ known: true, chunk: [event('$newer')], end: 'older-page' })
      .mockResolvedValueOnce({ known: true, chunk: [event('$older'), event('$already-observed'), event('$historical')], end: 'end' });
    await reconcileRepresentativeTimeline({ from: 'gap-page', knownEventIds: ['$already-observed'], readPage, onEvents });
    expect(readPage.mock.calls).toEqual([['gap-page'], ['older-page']]);
    expect(onEvents).toHaveBeenCalledExactlyOnceWith([event('$older'), event('$newer')]);
    onEvents.mockClear();
    await expect(reconcileRepresentativeTimeline({ from: 'gap-page', knownEventIds: ['$absent'],
      readPage: async () => ({ known: true, chunk: [event('$unsafe-history')], end: null }), onEvents,
    })).rejects.toThrow('did not reach');
    expect(onEvents).not.toHaveBeenCalled();
  });
});
