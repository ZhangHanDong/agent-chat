import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { snapshotEnv, restoreEnv } from './helpers/env.js';
import { startRepresentativeSyncCollector } from '../lib/representative-sync.js';

let MatrixBridge;
let ReliableMatrixClient;
let markRoomTrusted;
let bridgeStateForTest;
let runtimeDir;
let env;
const side = 'borrower.test';
const room = '!project:borrower.test';
const borrower = '@borrower:borrower.test';
const representative = '@rep:borrower.test';
const representativeRow = (registration = 'borrower.test@generation') => ({
  sideId: side, serverName: side, apiBaseUrl: 'https://borrower.invalid', kind: 'registrationToken',
  representativeToken: 'representative-fixture-token', representative: { mxid: representative }, registration,
});
const json = body => ({ ok: true, status: 200, json: async () => body });
const memberState = members => members.map(state_key => ({ type: 'm.room.member', state_key, origin_server_ts: 50, content: { membership: 'join' } }));
const bindings = () => ['coding', 'docs'].map(agent => ({
  agent, projectRoomId: room, project: room, ownerMxid: borrower,
  ownerDmRoomId: `!approval-${agent}:borrower.test`, active: true,
}));

beforeAll(async () => {
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hagency-representative-intake-'));
  env = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_TRUST_MODE', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
  process.env.HAGENCY_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_TRUST_MODE = 'enforce';
  process.env.MATRIX_AGENT_PREFIX = 'ac_';
  process.env.MATRIX_SERVER_NAME = 'fleet.test';
  const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
  ({ MatrixBridge, ReliableMatrixClient, markRoomTrusted, bridgeStateForTest } = await import(`${url}?representative-intake=${Date.now()}`));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { restoreEnv(env); rmSync(runtimeDir, { recursive: true, force: true }); });

function fixture() {
  const bridge = new MatrixBridge();
  bridge.actingCredentials = new Map([[side, representativeRow()]]);
  bridge.addKnownAgent('coding');
  bridge.addKnownAgent('docs');
  bridge.getAgentCredential = name => ({ mxid: `@ac_${name}:borrower.test` });
  bridge.botUserId = '@fleetbot:fleet.test';
  bridge.botClient = null;
  bridge.postWarning = vi.fn();
  bridge.beginAgentWork = vi.fn();
  bridge.commands = { handle: vi.fn() };
  bridge.callBackendApi = vi.fn(async () => ({ bindings: bindings() }));
  bridge.submitHumanMessage = vi.fn(async () => ({ id: 'accepted-message' }));
  const members = [borrower, representative, '@ac_coding:borrower.test', '@ac_docs:borrower.test'];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    if (new URL(input).pathname.endsWith('/messages')) return json({ chunk: [] });
    if (new URL(input).pathname.endsWith('/state')) return json(memberState(members));
    expect(new URL(input).pathname).toMatch(/\/joined_members$/);
    expect(options.headers.Authorization).toBe('Bearer representative-fixture-token');
    expect(new URL(input).searchParams.has('user_id')).toBe(false);
    return json({ joined: Object.fromEntries(members.map(mxid => [mxid, {}])) });
  }));
  markRoomTrusted(room, { side, inviter: borrower, trustReason: 'project_side_invite' });
  return { bridge, members };
}
const message = (id, name = 'coding', sender = borrower) => ({ type: 'm.room.message', event_id: id, sender,
  content: { msgtype: 'm.text', body: `@${name} please implement this`,
    'm.mentions': { user_ids: [`@ac_${name}:borrower.test`] },
    'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
  },
});

describe('representative room admission and intake', () => {
  test('public agent replies are archived as discussion without triggering a loop', async () => {
    const { bridge } = fixture();
    await bridge.onRoomMessage(room, { type: 'm.room.message', event_id: '$agent-discussion-context', sender: '@ac_coding:borrower.test',
      content: { msgtype: 'm.text', body: 'I recommend Friday. @docs review it.', 'm.mentions': { user_ids: ['@ac_docs:borrower.test'] } } });
    expect(bridge.callBackendApi).toHaveBeenCalledWith('POST', '/api/matrix/conversations/events', expect.objectContaining({
      eventId: '$agent-discussion-context', senderMxid: '@ac_coding:borrower.test',
    }));
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  });
  test('an admitted direct room overrides stale group mapping and requires no mention', async () => {
    const { bridge } = fixture();
    const privateRoom = '!private-conversation:borrower.test';
    const binding = { roomId: privateRoom, agent: 'coding', humanMxid: borrower };
    const entry = { sender: { agentName: 'coding', agentUserId: '@ac_coding:borrower.test' }, rooms: { [privateRoom]: binding } };
    bridge.directChats = { entryForRoom: () => entry, entriesForRoom: () => [entry],
      verify: vi.fn(async () => ({ ok: true, mode: 'direct', members: [borrower, entry.sender.agentUserId] })) };
    markRoomTrusted(privateRoom, { dm: true, directChat: true, agent: 'coding', humanMxid: borrower });
    bridgeStateForTest().roomGroupMap[privateRoom] = 'stale-group';
    await bridge.onRoomMessage(privateRoom, { type: 'm.room.message', event_id: '$direct-without-mention', sender: borrower,
      content: { msgtype: 'm.text', body: 'Continue our private discussion', 'm.mentions': {} } });
    expect(bridge.submitHumanMessage).toHaveBeenCalledExactlyOnceWith(privateRoom, expect.objectContaining({
      to: 'coding', mentions: [], summary: 'Continue our private discussion', source_room: privateRoom,
    }));
    expect(bridge.submitHumanMessage.mock.calls[0][1]).not.toHaveProperty('group');
    expect(bridge.directChats.verify).toHaveBeenCalled();
  });
  test('project discussion is archived before unaddressed intake returns and failed archival retries', async () => {
    const { bridge, members } = fixture();
    members.push('@colleague:borrower.test');
    const ordinary = { type: 'm.room.message', event_id: '$ordinary-discussion', sender: '@colleague:borrower.test',
      origin_server_ts: 100, content: { msgtype: 'm.text', body: 'Ship on Friday', 'm.mentions': {} } };
    await bridge.onRoomMessage(room, ordinary);
    expect(bridge.callBackendApi).toHaveBeenCalledWith('POST', '/api/matrix/conversations/events', expect.objectContaining({
      eventId: '$ordinary-discussion', senderMxid: '@colleague:borrower.test', body: 'Ship on Friday', roomId: room,
    }));
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    bridge.callBackendApi.mockImplementation(async (_method, endpoint) => {
      if (endpoint.endsWith('/events')) throw new Error('archive persistence unavailable');
      return { bindings: bindings() };
    });
    await expect(bridge.onRoomMessage(room, { ...ordinary, event_id: '$retry-archive' })).rejects.toThrow('archive persistence unavailable');
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  });
  test('project thread discussion is archived without waking until explicitly mentioned', async () => {
    const { bridge, members } = fixture();
    const queries = [];
    bridge.callBackendApi.mockImplementation(async (_method, endpoint) => {
      const query = new URL(endpoint, 'http://backend.test').searchParams;
      if (!query.has('thread_root_event_id')) return { bindings: bindings() };
      const root = query.get('thread_root_event_id');
      const requester = query.get('requester_mxid');
      queries.push({ room: query.get('project'), root, requester });
      return { ok: true, threadLookup: { v: 1, roomId: query.get('project'), threadRootEventId: root,
        requesterMxid: requester, target: root === '$canonical-root' && requester === borrower
          ? { agent: 'coding', taskId: 'task_canonical' } : null } };
    });
    const followup = (id, root = '$canonical-root', sender = borrower) => ({ type: 'm.room.message', event_id: id, sender,
      content: { msgtype: 'm.text', body: 'Add the requested validation and run all tests.',
        'm.mentions': { user_ids: [] }, 'm.relates_to': { rel_type: 'm.thread', event_id: root } } });
    await bridge.onRoomMessage(room, followup('$canonical-followup'));
    expect(queries).toEqual([]);
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    expect(bridge.callBackendApi).toHaveBeenCalledWith('POST', '/api/matrix/conversations/events', expect.objectContaining({ eventId: '$canonical-followup' }));
    expect(await bridge.onRoomMessage(room, followup('$unknown-followup', '$unknown-root')))
      .toMatchObject({ ignored: true, reason: 'managed_thread_unaddressed' });
    const other = '@another:borrower.test';
    members.push(other);
    expect(await bridge.onRoomMessage(room, followup('$foreign-requester-followup', '$canonical-root', other)))
      .toMatchObject({ ignored: true, reason: 'managed_thread_unaddressed' });
    members.splice(members.indexOf('@ac_coding:borrower.test'), 1);
    expect(await bridge.onRoomMessage(room, followup('$revoked-followup')))
      .toMatchObject({ ignored: true, reason: 'managed_thread_unaddressed' });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    members.push('@ac_coding:borrower.test');
    await bridge.onRoomMessage(room, message('$explicit-followup'));
    expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(1);
  });

  test.each([
    { msgtype: 'm.notice', body: 'Approved coding. Agent: @ac_coding:borrower.test', 'm.mentions': { user_ids: [] } },
    { msgtype: 'm.text', body: '!offer' },
    { msgtype: 'm.text', body: '!request coding 1000 100' },
  ])('representative output is ignored before command parsing and agent dispatch', async (content) => {
    const { bridge } = fixture();
    const result = await bridge.onRoomMessage(room, { ...message(`$own-output-${content.body}`, 'coding', representative), content });
    expect(result).toEqual({ ignored: true, reason: 'representative_message' });
    expect(bridge.commands.handle).not.toHaveBeenCalled();
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    expect(bridge.beginAgentWork).not.toHaveBeenCalled();
  });

  test('project requests read the room label through its representative authority', async () => {
    const { bridge } = fixture();
    const { default: BotCommands } = await import('../lib/bot-commands.js');
    bridge.botClient = { getRoomStateEvent: vi.fn(async () => { throw new Error('bot is not joined'); }) };
    bridge.sayInRoom = vi.fn();
    const submitted = [];
    const fetchImpl = vi.fn(async (input, options) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/state/m.room.name/')) {
        expect(url.origin).toBe('https://borrower.invalid');
        expect(url.pathname).toContain(encodeURIComponent(room));
        expect(url.searchParams.has('user_id')).toBe(false);
        expect(options.headers.Authorization).toBe('Bearer representative-fixture-token');
        return json({ name: 'Readable project label' });
      }
      expect(url.pathname).toBe('/api/engagements');
      submitted.push(JSON.parse(options.body));
      return json({ engagement: { id: 'requested', role: 'coding', route: 'notWhitelisted' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const commands = new BotCommands({ botClient: bridge.botClient, bridge, botUserId: bridge.botUserId });
    await commands.cmdRequest(room, ['coding', '1000'], borrower, { eventId: '$real-request' });
    expect(submitted).toEqual([expect.objectContaining({
      project: 'Readable project label', projectRoomId: room, requester: borrower, requestId: '$real-request',
    })]);
    expect(bridge.botClient.getRoomStateEvent).not.toHaveBeenCalled();
  });

  test('an unloaded appservice registry remains retryable beside an empty representative registry', async () => {
    const { bridge } = fixture();
    bridge.representativeInboundSnapshot = new Map();
    bridge.appserviceInboundSnapshot = null;
    const event = { ...message('$unloaded-registry'), room_id: room };
    const meta = { provenance: { registration: 'as-registration', sideId: side, mode: 'push' } };
    await expect(bridge.handleAppserviceEvents(side, [event], meta)).rejects.toMatchObject({ code: 'side_registry_unavailable', retryable: true });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    expect(bridge.isDuplicateMatrixEvent(event.event_id)).toBe(false);
    expect(bridge.sideProvenanceClaims?.size ?? 0).toBe(0);
    await expect(bridge.assertSideProvenanceForEvent(side, room, event, { ...meta, representativeSync: true }))
      .resolves.toEqual({ rejected: 'side_not_registered' });
  });

  test('bot sync retries side-room hydration from the committed cursor', async () => {
    const { bridge } = fixture();
    let committed = 'before-work';
    let client;
    const storage = {
      getSyncToken: () => committed,
      setSyncToken: vi.fn(value => { committed = value; client.stopSyncing = true; }),
    };
    client = new ReliableMatrixClient('https://fleet.invalid', 'bot-fixture', storage);
    client.doRequest = vi.fn(async (_method, endpoint, query) => {
      expect(endpoint).toBe('/_matrix/client/v3/sync');
      expect(query.since).toBe('before-work');
      return { next_batch: 'after-work', rooms: { join: { [room]: { timeline: { events: [message('$bot-retry')] } } } } };
    });
    bridge.callBackendApi.mockRejectedValueOnce(new Error('temporary backend outage')).mockResolvedValue({ bindings: bindings() });
    bridge.onRoomEvent = vi.fn();
    bridge.configureReliableBotSync(client);
    vi.useFakeTimers();
    try {
      await client.startSync();
      await vi.advanceTimersByTimeAsync(1);
      expect(storage.setSyncToken).not.toHaveBeenCalled();
      expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(client.doRequest).toHaveBeenCalledTimes(2);
      expect(bridge.submitHumanMessage).toHaveBeenCalledOnce();
      expect(storage.setSyncToken).toHaveBeenCalledExactlyOnceWith('after-work');
    } finally { client.stopSyncing = true; vi.useRealTimers(); }
  });

  test('representative room control commands remain forbidden to a non-operator borrower', async () => {
    const { bridge } = fixture();
    const { default: BotCommands } = await import('../lib/bot-commands.js');
    bridge.commands = new BotCommands({ botClient: null, bridge, botUserId: bridge.botUserId });
    bridge.commands.reply = vi.fn();
    bridge.commands.cmdAgentctl = vi.fn();
    await bridge.onRoomMessage(room, { ...message('$forbidden-control'), content: { msgtype: 'm.text', body: '!ctl send approved' } });
    expect(bridge.commands.reply).toHaveBeenCalledWith(room, expect.stringMatching(/Access denied/));
    expect(bridge.commands.cmdAgentctl).not.toHaveBeenCalled();
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  });

  test('representative room hydrates authoritative bindings and routes an admitted mention without a bot', async () => {
    const { bridge } = fixture();
    await bridge.onRoomMessage(room, message('$admitted'));
    expect(bridge.submitHumanMessage).toHaveBeenCalledExactlyOnceWith(room, expect.objectContaining({
      to: 'coding', sender_mxid: borrower, source_room: room, source_event_id: '$admitted',
      thread_root_event_id: '$root', target_type: 'agent',
    }));
    expect(bridge.roomAgentBindings(room)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentName: 'coding', ownerMxid: borrower, approvalDmRoomId: '!approval-coding:borrower.test', source: 'backend_admission' }),
      expect.objectContaining({ agentName: 'docs', ownerMxid: borrower, approvalDmRoomId: '!approval-docs:borrower.test', source: 'backend_admission' }),
    ]));
    const recorded = JSON.parse(readFileSync(path.join(runtimeDir, 'data/matrix/bridge-state.json')));
    expect(recorded.roomAgentBindings[room].coding.ownerMxid).toBe(borrower);
    bridge.callBackendApi.mockClear();
    expect(await bridge.syncApprovalBindingForRoomAgent(room, 'coding')).toEqual({ ok: true, reason: 'backend_owned_binding' });
    expect(bridge.callBackendApi).not.toHaveBeenCalled();
    await bridge.onRoomMessage(room, { ...message('$offer'), content: { msgtype: 'm.text', body: '!offer' } });
    expect(bridge.commands.handle).toHaveBeenCalledWith(room, borrower, '!offer', expect.any(Object));
  });

  test('representative room rejects unbound targets and removes revoked imported bindings', async () => {
    const { bridge, members } = fixture();
    await bridge.onRoomMessage(room, message('$before-revoke'));
    bridge.submitHumanMessage.mockClear();
    bridge.callBackendApi.mockResolvedValue({ bindings: [] });
    expect(await bridge.onRoomMessage(room, message('$after-revoke'))).toMatchObject({ ignored: true });
    expect(bridge.roomAgentBindings(room)).toEqual([]);
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    bridge.callBackendApi.mockResolvedValue({ bindings: bindings() });
    members.splice(members.indexOf('@ac_coding:borrower.test'), 1);
    expect(await bridge.onRoomMessage(room, message('$not-joined'))).toMatchObject({ ignored: true });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    expect(await bridge.onRoomMessage(room, message('$outsider', 'docs', '@borrower:evil.test')))
      .toEqual({ ignored: true, reason: 'project_sender_or_representative_not_joined' });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  });

  test('appservice representative routes admitted agents without per-agent token records', async () => {
    const { bridge, members } = fixture();
    bridge.actingCredentials.set(side, { ...representativeRow(), kind: 'appservice',
      asToken: 'fixture-as-token', senderLocalpart: 'rep', namespace: '@ac_.*:borrower\\.test',
    });
    bridge.getAgentCredential = () => null;
    vi.stubGlobal('fetch', vi.fn(async (input, options) => {
      expect(options.headers.Authorization).toBe('Bearer fixture-as-token');
      expect(new URL(input).searchParams.get('user_id')).toBe(representative);
      if (new URL(input).pathname.endsWith('/messages')) return json({ chunk: [] });
    if (new URL(input).pathname.endsWith('/state')) return json(memberState(members));
      expect(new URL(input).pathname).toMatch(/\/joined_members$/);
      return json({ joined: Object.fromEntries(members.map(mxid => [mxid, {}])) });
    }));
    await bridge.onRoomMessage(room, message('$as-without-token'));
    expect(bridge.submitHumanMessage).toHaveBeenCalledExactlyOnceWith(room, expect.objectContaining({ to: 'coding' }));
  });

  test('default prefix bridge routes the admitted managed identity and rejects foreign fleet mentions', async () => {
    const { bridge } = fixture();
    const fleetId = `hf_${'a'.repeat(32)}`;
    const rep = `@${fleetId}_representative:${side}`;
    const ownMxid = `@${fleetId}_agent_coding:${side}`;
    const foreignMxid = `@hf_${'b'.repeat(32)}_agent_coding:${side}`;
    bridge.actingCredentials.set(side, { ...representativeRow(), kind: 'appservice',
      asToken: 'fixture-as-token', senderLocalpart: `${fleetId}_representative`,
      representative: { mxid: rep }, namespace: `^@${fleetId}_[a-z0-9_]+:borrower\\.test$`,
    });
    bridge.getAgentCredential = () => null;
    const members = [borrower, rep, ownMxid, `@${fleetId}_agent_docs:${side}`];
    vi.stubGlobal('fetch', vi.fn(async (input, options) => {
      expect(options.headers.Authorization).toBe('Bearer fixture-as-token');
      expect(new URL(input).searchParams.get('user_id')).toBe(rep);
      if (new URL(input).pathname.endsWith('/messages')) return json({ chunk: [] });
    if (new URL(input).pathname.endsWith('/state')) return json(memberState(members));
      expect(new URL(input).pathname).toMatch(/\/joined_members$/);
      return json({ joined: Object.fromEntries(members.map(mxid => [mxid, {}])) });
    }));
    expect(bridge.isKnownAgentMxid(ownMxid)).toBe(true);
    expect(bridge.isKnownAgentMxid(foreignMxid)).toBe(false);
    expect(bridge.agentSenderFor('coding', room).agentUserId).toBe(ownMxid);
    const forms = [
      { body: `${ownMxid} please implement this`, 'm.mentions': { user_ids: [ownMxid] } },
      { body: `${ownMxid} please implement this` },
      { body: '@coding please implement this', format: 'org.matrix.custom.html', formatted_body: `<a href="https://matrix.to/#/${ownMxid}">coding</a> please implement this` },
    ];
    for (const [index, content] of forms.entries()) {
      await bridge.onRoomMessage(room, { ...message(`$managed-${index}`), content: { msgtype: 'm.text', ...content } });
      expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(index + 1);
      expect(bridge.submitHumanMessage).toHaveBeenLastCalledWith(room, expect.objectContaining({ to: 'coding', sender_mxid: borrower }));
    }
    const rejected = await bridge.onRoomMessage(room, { ...message('$foreign-fleet'),
      content: { msgtype: 'm.text', body: `${foreignMxid} do this`, 'm.mentions': { user_ids: [foreignMxid] } } });
    expect(rejected).toMatchObject({ ignored: true });
    await bridge.onRoomMessage(room, message('$managed-self-output', 'coding', ownMxid));
    expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(forms.length);
    // The live deployment's bot and project side share a homeserver. That path
    // deliberately has no foreign sideForRoom result and must still derive scope.
    bridge.actingCredentials.set('fleet.test', { ...bridge.actingCredentials.get(side),
      sideId: 'fleet.test', serverName: 'fleet.test',
      namespace: `^@${fleetId}_[a-z0-9_]+:fleet\\.test$`,
      representative: { mxid: `@${fleetId}_representative:fleet.test` },
    });
    expect(bridge.agentSenderFor('coding', '!same-server:fleet.test').agentUserId)
      .toBe(`@${fleetId}_agent_coding:fleet.test`);
    expect(bridge.agentSenderFor('coding').agentUserId).toBe(`@${fleetId}_agent_coding:fleet.test`);
  });

  test('representative intake fails closed on ambiguous owners and foreign structured mentions', async () => {
    const { bridge } = fixture();
    bridge.callBackendApi.mockResolvedValue({ bindings: [...bindings(), { ...bindings()[0], ownerMxid: '@different:borrower.test' }] });
    expect(await bridge.onRoomMessage(room, message('$ambiguous-owner'))).toMatchObject({ ignored: true });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    bridge.callBackendApi.mockResolvedValue({ bindings: bindings() });
    const foreignMention = message('$foreign-target');
    foreignMention.content['m.mentions'].user_ids = ['@ac_coding:foreign.test'];
    expect(await bridge.onRoomMessage(room, foreignMention)).toMatchObject({ ignored: true });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    bridge.callBackendApi.mockRejectedValue(new Error('backend unavailable'));
    await expect(bridge.onRoomMessage(room, message('$retryable-bindings'))).rejects.toThrow('backend unavailable');
    expect(bridge.isDuplicateMatrixEvent('$retryable-bindings')).toBe(false);
  });

  test('representative collectors follow verified credential generations and stop on removal', async () => {
    const { bridge } = fixture();
    const started = [];
    bridge.startRepresentativeCollector = options => {
      const collector = { stop: vi.fn(), loop: Promise.resolve() };
      started.push({ options, collector });
      return collector;
    };
    bridge.refreshRepresentativeCollectors();
    expect(started).toHaveLength(1);
    await started[0].options.writeCursor('durable-cursor');
    bridge.actingCredentials.set(side, { ...representativeRow() });
    bridge.refreshRepresentativeCollectors();
    expect(started).toHaveLength(1);
    bridge.actingCredentials.set(side, representativeRow('borrower.test@rotated'));
    bridge.refreshRepresentativeCollectors();
    expect(started[0].collector.stop).toHaveBeenCalledOnce();
    expect(started).toHaveLength(2);
    expect(started[1].options.readCursor()).toBeNull();
    bridge.actingCredentials.clear();
    bridge.refreshRepresentativeCollectors();
    expect(started[1].collector.stop).toHaveBeenCalledOnce();
    expect(bridge.representativeInboundSnapshot.size).toBe(0);
    bridge.actingCredentials.set(side, { ...representativeRow(), representative: null });
    bridge.refreshRepresentativeCollectors();
    expect(started).toHaveLength(2);
  });

  test('ordinary representative sync joins before reading membership when stripped invite metadata comes first', async () => {
    const { bridge, members } = fixture();
    let polls = 0;
    let joined = false;
    bridge.backfillJoinedRoomOnSide = vi.fn().mockRejectedValueOnce(new Error('temporary history read')).mockResolvedValue(0);
    bridge.onRoomEvent = vi.fn();
    const syncFetch = vi.fn(async (input, options) => {
      const url = new URL(input);
      expect(options.headers.Authorization).toBe('Bearer representative-fixture-token');
      expect(url.searchParams.has('user_id')).toBe(false);
      if (url.pathname.includes('/join/')) { joined = true; return json({ room_id: room }); }
      if (url.pathname.endsWith('/messages')) return json({ chunk: [] });
      if (url.pathname.endsWith('/state')) { expect(joined).toBe(true); return json(memberState(members)); }
      if (url.pathname.endsWith('/joined_members')) {
        if (!joined) return { ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN' }) };
        return json({ joined: Object.fromEntries(members.map(mxid => [mxid, {}])) });
      }
      expect(url.pathname).toBe('/_matrix/client/v3/sync');
      polls += 1;
      if (!url.searchParams.get('since')) return json({ next_batch: 'invite-cursor', rooms: { invite: { [room]: { invite_state: { events: [
        { type: 'm.room.create', state_key: '', sender: borrower, content: { creator: borrower } },
        { type: 'm.room.name', state_key: '', sender: borrower, content: { name: 'Project' } },
        { type: 'm.room.join_rules', state_key: '', sender: borrower, content: { join_rule: 'invite' } },
        { type: 'm.room.member', state_key: '@other:borrower.test', sender: borrower, content: { membership: 'invite' } },
        { type: 'm.room.member', state_key: representative, sender: borrower, content: { membership: 'invite' } },
      ] } } } } });
      return json({ next_batch: 'work-cursor', rooms: { join: { [room]: { timeline: { events: [message('$collector-work')] } } } } });
    });
    vi.stubGlobal('fetch', syncFetch);
    bridge.startRepresentativeCollector = options => startRepresentativeSyncCollector({ ...options,
      fetchImpl: syncFetch, shouldContinue: () => options.readCursor() !== 'work-cursor',
      sleep: async () => {},
    });
    bridge.refreshRepresentativeCollectors();
    const collector = bridge.representativeCollectors.get(side).collector;
    try { await collector.loop; } finally { collector.stop(); }
    expect(joined).toBe(true);
    expect(polls).toBe(3);
    expect(collector.stats.failed).toBe(1);
    expect(bridge.submitHumanMessage).toHaveBeenCalledExactlyOnceWith(room, expect.objectContaining({ to: 'coding', sender_mxid: borrower }));
    expect(bridge.onRoomEvent).toHaveBeenCalledWith(room, expect.objectContaining({ state_key: representative }));
    expect(bridge.onRoomEvent.mock.calls.every(([, event]) => event.type === 'm.room.member' && event.state_key === representative)).toBe(true);
    expect(collector.stats.processed).toBe(2);
  });
});
