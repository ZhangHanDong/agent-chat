import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let module;
let server;
let base;
let runtime;
let calls;
let failure;
let agentLookups;
let self;
let logs;
const savedEnv = new Map();
const ROOM = '!project:side.test';
const GROUP = 'membership-regression';

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://fixture');
    const raw = Buffer.concat(chunks).toString();
    const call = {
      path: decodeURIComponent(url.pathname),
      actor: url.searchParams.get('user_id'),
      token: req.headers.authorization,
      method: req.method,
      body: raw ? JSON.parse(raw) : null,
    };
    calls.push(call);
    let status = 200;
    let data = {};
    if (call.path.endsWith('/joined_members')) {
      data = { joined: { '@hagency:side.test': {}, '@ac_departing:side.test': {} } };
    } else if (call.path.endsWith('/whoami')) {
      data = { user_id: '@custom_worker:home.test' };
    } else if (call.path.startsWith('/api/agents/')) {
      data = agentLookups.get(call.path.slice('/api/agents/'.length));
      if (!data) {
        status = 404;
        data = { error: 'not found' };
      }
    }
    if (failure && call.path.includes(failure)) {
      status = 403;
      data = { errcode: 'M_FORBIDDEN', error: 'fixture refused membership operation' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  runtime = mkdtempSync(path.join(tmpdir(), 'hagency-group-membership-'));
  for (const [key, value] of Object.entries({
    HAGENCY_RUNTIME_DIR: runtime,
    HAGENCY_API: base,
    MATRIX_HOMESERVER: `${base}/home`,
    MATRIX_SERVER_NAME: 'home.test',
  })) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  module = await import('../bridge-matrix.js');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function appservice(serverName = 'side.test', apiPath = 'side') {
  return {
    kind: 'appservice', serverName, apiBaseUrl: `${base}/${apiPath}`,
    asToken: `${apiPath}-as-token`, senderLocalpart: 'hagency',
    namespace: `@ac_.*:${serverName.replaceAll('.', '\\.')}`,
  };
}

beforeEach(() => {
  calls = [];
  failure = null;
  agentLookups = new Map();
  const state = module.bridgeStateForTest();
  state.groupRoomMap = { [`${GROUP}@side.test`]: ROOM };
  state.roomGroupMap = { [ROOM]: `${GROUP}@side.test` };
  state.agentTokens = {};
  state.humanMxids = {};
  state.botToken = 'home-bot-token'; // A tempting but invalid fallback for a side room.
  self = Object.assign(Object.create(module.MatrixBridge.prototype), {
    botClient: null,
    knownAgents: new Set(['worker', 'departing']),
    knownAgentIndex: new Map([['worker', 'worker'], ['departing', 'departing']]),
    actingCredentials: new Map([['side.test', appservice()]]),
    postWarning: vi.fn(),
  });
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url, init) => {
    if (new URL(url).origin !== base) throw new Error(`test forbids non-fixture HTTP: ${url}`);
    return realFetch(url, init);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const update = (added = [], removed = []) => self.onGroupMembersChanged({ name: GROUP, added, removed });
const writes = () => calls.filter((call) => call.method === 'POST');

function useHomeToken() {
  const state = module.bridgeStateForTest();
  state.groupRoomMap = { [GROUP]: '!project:home.test' };
  state.agentTokens.worker = {
    accessToken: 'worker-token', homeserver: `${base}/home`, serverName: 'home.test',
    mxid: '@custom_worker:home.test',
  };
  self.botClient = { getJoinedRoomMembers: async () => [] };
}

describe('group membership synchronization', () => {
  test('botless group membership invites joins and kicks on its own side', async () => {
    const result = await update(['worker', '@Alice:side.test'], ['departing']);
    expect(writes().map((call) => [call.path, call.actor, call.body?.user_id])).toEqual([
      [`/side/_matrix/client/v3/rooms/${ROOM}/invite`, '@hagency:side.test', '@ac_worker:side.test'],
      [`/side/_matrix/client/v3/join/${ROOM}`, '@ac_worker:side.test', undefined],
      [`/side/_matrix/client/v3/rooms/${ROOM}/invite`, '@hagency:side.test', '@Alice:side.test'],
      [`/side/_matrix/client/v3/rooms/${ROOM}/kick`, '@hagency:side.test', '@ac_departing:side.test'],
    ]);
    expect(calls.filter((call) => call.path.includes('/_matrix/')).every((call) => call.token === 'Bearer side-as-token')).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('group membership uses room side despite an agent token on another side', async () => {
    module.bridgeStateForTest().agentTokens.worker = {
      accessToken: 'other-agent-token', homeserver: `${base}/other`, serverName: 'other.test', mxid: '@ac_worker:other.test',
    };
    expect((await update(['worker'])).ok).toBe(true);
    expect(writes().map((call) => call.actor)).toEqual(['@hagency:side.test', '@ac_worker:side.test']);
    expect(calls.every((call) => call.path.startsWith('/side/'))).toBe(true);
  });

  test('group membership token path invites before joining and preserves discovered MXID', async () => {
    useHomeToken();
    expect((await update(['worker'], ['worker'])).ok).toBe(true);
    expect(writes().map((call) => [call.path.split('/').at(-1), call.token, call.body?.user_id])).toEqual([
      ['invite', 'Bearer home-bot-token', '@custom_worker:home.test'],
      ['!project:home.test', 'Bearer worker-token', undefined],
      ['kick', 'Bearer home-bot-token', '@custom_worker:home.test'],
    ]);
  });

  test('group membership refuses missing side authority before sending requests', async () => {
    for (const row of [null, { ...appservice(), asToken: '' }, { ...appservice(), apiBaseUrl: '' }, { ...appservice(), senderLocalpart: '' }]) {
      self.actingCredentials = new Map(row ? [['side.test', row]] : []);
      await expect(update(['worker'])).rejects.toThrow(/credential|authority|side/i);
      expect(calls).toEqual([]);
    }
  });

  test('group membership refuses ambiguous group rooms before sending requests', async () => {
    module.bridgeStateForTest().groupRoomMap[`${GROUP}@other.test`] = '!other:other.test';
    await expect(update(['worker'])).rejects.toThrow(/ambiguous/i);
    expect(calls).toEqual([]);
  });

  test('group membership refuses unreadable membership without mutations', async () => {
    failure = '/joined_members';
    await expect(update(['worker'], ['departing'])).rejects.toThrow(/membership/i);
    expect(writes()).toEqual([]);
  });

  test('group membership reports HTTP failures without success claims', async () => {
    for (const path of ['side', 'home']) {
      if (path === 'home') useHomeToken();
      for (const operation of ['invite', 'join', 'kick']) {
        calls = [];
        logs.mockClear();
        self.postWarning.mockClear();
        failure = operation === 'join' ? '/join/' : `/${operation}`;
        const result = await update(operation === 'kick' ? [] : ['worker'], operation === 'kick' ? ['worker'] : []);
        expect(result?.ok, `${path} ${operation}`).toBe(false);
        expect(self.postWarning).toHaveBeenCalled();
        const forbiddenClaim = operation === 'invite' ? /^Invited / : operation === 'join' ? /^Joined / : /^Kicked /;
        expect(logs.mock.calls.some(([line]) => forbiddenClaim.test(line))).toBe(false);
        if (operation === 'invite') expect(writes().some((call) => call.path.includes('/join/'))).toBe(false);
      }
    }
  });

  test('group membership refuses unknown bare human identities on a side', async () => {
    expect((await update(['unobserved-human'])).ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  test('group membership refuses agents without namespace and roster authorization', async () => {
    for (const rejection of ['namespace', 'roster']) {
      calls = [];
      self.actingCredentials.set('side.test', appservice());
      if (rejection === 'namespace') self.actingCredentials.get('side.test').namespace = '@another_.*:side\\.test';
      if (rejection === 'roster') self.isKnownAgentMxid = () => false;
      expect((await update(['worker'])).ok).toBe(false);
      expect(writes()).toEqual([]);
    }
  });

  test('group membership recognizes newly registered runtime agents from backend lookup', async () => {
    for (const [name, type, full] of [['new-worker', 'claude', false], ['new-codex', 'codex', true]]) {
      calls = [];
      const mxid = `@ac_${name}:side.test`;
      agentLookups.set(name, { kind: 'agent', type, name });
      // If the backend record is misclassified, this tempting human mapping
      // exposes the wrong invite instead of merely rejecting an unknown name.
      module.bridgeStateForTest().humanMxids[name] = `@${name}:side.test`;
      expect(self.isKnownAgentName(name)).toBe(false);
      const result = await update([full ? mxid : name]);
      expect(writes().map((call) => [call.actor, call.body?.user_id])).toEqual([
        ['@hagency:side.test', mxid], [mxid, undefined],
      ]);
      expect(result.ok).toBe(true);
      expect(self.isKnownAgentName(name)).toBe(true);
      expect(calls.find((call) => call.path.startsWith('/api/agents/'))?.path).toBe(`/api/agents/${name}`);
    }
  });

  test('group membership refuses nonexistent full agent MXIDs without human substitution', async () => {
    const mxid = '@ac_nonexistent:side.test';
    const result = await update([mxid], [mxid]);
    expect(writes()).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.added[0].status).toBe('failed');
    expect(result.removed[0].status).toBe('failed');
    expect(self.isKnownAgentName('nonexistent')).toBe(false);
  });
});
