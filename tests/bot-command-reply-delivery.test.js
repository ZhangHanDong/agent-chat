import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotEnv, restoreEnv } from './helpers/env.js';

let MatrixBridge;
let BotCommands;
let runtimeDir;
let env;
beforeAll(async () => {
  env = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_SERVER_NAME']);
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-command-replies-'));
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_SERVER_NAME = 'fleet.test';
  ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?command-replies`));
  ({ default: BotCommands } = await import('../lib/bot-commands.js'));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { restoreEnv(env); rmSync(runtimeDir, { recursive: true, force: true }); });

function fixture(server = 'fleet.test') {
  const room = `!project:${server}`;
  const deliveries = new Map();
  const attempts = [];
  let beforeRead = async () => {};
  const bridge = {
    actingSideFor: () => ({
      side: { serverName: server, apiBaseUrl: 'https://matrix.invalid' },
      credential: { kind: 'registrationToken', representativeToken: 'fixture-representative' },
    }),
    botClient: { sendMessage: vi.fn(async () => {
      throw Object.assign(new Error("sender's membership is not `join`"), {
        errcode: 'M_FORBIDDEN', error: "sender's membership is not `join`",
      });
    }) },
  };
  bridge.sayInRoom = MatrixBridge.prototype.sayInRoom.bind(bridge);
  const makeCommands = () => new BotCommands({ bridge, botClient: bridge.botClient, botUserId: '@bot:fleet.test' });
  const json = body => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/offer-book') {
      await beforeRead();
      return json({ roles: [{ role: 'coding', serving: { framework: 'codex', model: 'fixture' } }], whitelisted: false });
    }
    expect(url.origin).toBe('https://matrix.invalid');
    expect(url.pathname).toContain(`/rooms/${encodeURIComponent(room)}/send/m.room.message/`);
    expect(options.method).toBe('PUT');
    expect(options.headers.Authorization).toBe('Bearer fixture-representative');
    const key = url.pathname;
    attempts.push(key);
    if (!deliveries.has(key)) deliveries.set(key, { event_id: `$reply-${deliveries.size}`, content: JSON.parse(options.body) });
    return json({ event_id: deliveries.get(key).event_id });
  }));
  const commands = makeCommands();
  const offer = (eventId, handler = commands) => handler.handle(room, `@borrower:${server}`, '!offer', { eventId });
  return { room, bridge, deliveries, attempts, offer, makeCommands, setReadHook: fn => { beforeRead = fn; } };
}

describe('representative command reply delivery', () => {
  for (const [label, server] of [['the bot homeserver', 'fleet.test'], ['another homeserver', 'borrower.test']]) {
    test(`identical fresh offers remain visible on ${label}`, async () => {
      const f = fixture(server);
      await f.offer('$first');
      await f.offer('$second');
      expect(f.deliveries.size).toBe(2);
      const replies = [...f.deliveries.values()];
      expect(replies[0].content).toEqual(replies[1].content);
      expect(replies[0].event_id).not.toBe(replies[1].event_id);
    });
  }

  test('replaying one offer after command handler recreation does not duplicate its reply', async () => {
    const f = fixture();
    await f.offer('$first');
    await f.offer('$first', f.makeCommands());
    expect(f.attempts).toHaveLength(2);
    expect(f.deliveries.size).toBe(1);
    expect(f.attempts[0]).toBe(f.attempts[1]);
  });

  test('overlapping offer handlers preserve independent replay identities', async () => {
    const f = fixture();
    const releases = [];
    f.setReadHook(() => new Promise(resolve => releases.push(resolve)));
    const first = f.offer('$first');
    const second = f.offer('$second');
    expect(releases).toHaveLength(2);
    releases[1]();
    await second;
    releases[0]();
    await first;
    expect(f.deliveries.size).toBe(2);
    f.setReadHook(async () => {});
    await f.offer('$first');
    await f.offer('$second');
    expect(f.attempts[2]).toBe(f.attempts[1]);
    expect(f.attempts[3]).toBe(f.attempts[0]);
    expect(f.deliveries.size).toBe(2);
  });

  test('commands without an event id do not suppress later identical replies', async () => {
    const f = fixture();
    await f.offer(undefined);
    await f.offer(undefined);
    expect(f.deliveries.size).toBe(2);
  });

  test('independent bridge notices do not share a content-derived transaction id', async () => {
    const f = fixture();
    const content = { msgtype: 'm.text', body: 'Delivery is temporarily unavailable' };
    await f.bridge.sayInRoom(f.room, content);
    await f.bridge.sayInRoom(f.room, content);
    expect(f.deliveries.size).toBe(2);
    await f.bridge.sayInRoom(f.room, content, { txnSeed: 'durable-notice' });
    await f.bridge.sayInRoom(f.room, content, { txnSeed: 'durable-notice' });
    expect(f.deliveries.size).toBe(3);
  });
});
