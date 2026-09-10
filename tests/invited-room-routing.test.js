import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotEnv, restoreEnv } from './helpers/env.js';
import BotCommands from '../lib/bot-commands.js';
import { MatrixDirectChats } from '../lib/matrix-direct-chat.js';

let directory, env;
afterEach(() => { if (env) restoreEnv(env); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function directFixture() {
  directory = mkdtempSync(path.join(os.tmpdir(), 'direct-command-'));
  env = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
  process.env.HAGENCY_RUNTIME_DIR = directory; process.env.MATRIX_AGENT_PREFIX = 'ac_'; process.env.MATRIX_SERVER_NAME = 'test';
  const { MatrixBridge } = await import('../bridge-matrix.js?direct-command-review');
  const bridge = new MatrixBridge();
  bridge.addKnownAgent('one'); bridge.addKnownAgent('two');
  const room = '!private:test', binding = { roomId: room, humanMxid: '@alice:test', agent: 'one', mode: 'direct', sinceTs: 1 };
  const state = [{ type: 'm.room.join_rules', content: { join_rule: 'invite' } },
    ...['@alice:test', '@ac_one:test'].map(state_key => ({ type: 'm.room.member', state_key, content: { membership: 'join' } }))];
  const client = { getRoomState: vi.fn(async () => state), doRequest: vi.fn(async () => ({ event_id: '$answer' })) };
  const manager = new MatrixDirectChats({ directory, backend: vi.fn(async () => ({ binding })),
    onBinding: vi.fn(), warning: vi.fn(), onMessage: (roomId, event) => bridge.onRoomMessage(roomId, event) });
  const entry = { sender: { agentName: 'one', agentUserId: '@ac_one:test' }, rooms: { [room]: binding },
    client, file: path.join(directory, 'rooms.json') };
  manager.clients.set('@ac_one:test', entry); bridge.directChats = manager;
  bridge.commands = new BotCommands({ bridge });
  bridge.archiveConversationEvent = vi.fn(async () => ({ ok: true }));
  bridge.postWarning = vi.fn(); bridge.beginAgentWork = vi.fn();
  bridge.submitHumanMessage = vi.fn(async () => ({ id: 'accepted' }));
  const event = (id, body) => ({ event_id: id, type: 'm.room.message', sender: '@alice:test', origin_server_ts: 500,
    content: { msgtype: 'm.text', body } });
  return { bridge, manager, entry, room, binding, state, client, event };
}

test('direct room commands reply through the admitted Agent and reply failure does not wedge sync', async () => {
  const f = await directFixture();
  // Exercise the real command handler and device send without a bot or representative.
  await f.bridge.onInvitedAgentRoomMessage(f.room, f.event('$help', '!help'));
  expect(f.client.doRequest).toHaveBeenCalledWith('PUT', expect.stringContaining('/send/m.room.message/command_'), null,
    expect.objectContaining({ body: expect.stringContaining('Agent Bridge Bot Commands') }));
  expect(f.bridge.isDuplicateMatrixEvent('$help')).toBe(true);
  f.client.doRequest.mockRejectedValueOnce(new Error('temporary send failure'));
  await expect(f.bridge.onInvitedAgentRoomMessage(f.room, f.event('$failed-help', '!help'))).resolves.toBeUndefined();
  expect(f.bridge.isDuplicateMatrixEvent('$failed-help')).toBe(true);
  expect(f.bridge.postWarning).toHaveBeenCalledWith(expect.stringContaining('will not be repeated'));
  await f.bridge.onInvitedAgentRoomMessage(f.room, f.event('$next', 'hello'));
  expect(f.bridge.submitHumanMessage).toHaveBeenCalledOnce();
});

test('a joined Agent without a starting device cannot wedge another direct device', async () => {
  const f = await directFixture(); f.binding.mode = 'group';
  f.state.push({ type: 'm.room.member', state_key: '@ac_two:test', content: { membership: 'join' } });
  const event = f.event('$both-with-retired', 'summarize');
  event.content['m.mentions'] = { user_ids: ['@ac_one:test', '@ac_two:test'] };
  await f.bridge.onInvitedAgentRoomMessage(f.room, event);
  expect(f.bridge.submitHumanMessage).toHaveBeenCalledWith(f.room, expect.objectContaining({ room_agent_targets: ['one'] }));
  f.manager.starting.set('@ac_two:test', Promise.resolve());
  await expect(f.bridge.onInvitedAgentRoomMessage(f.room, { ...event, event_id: '$starting' })).rejects.toThrow('still being admitted');
});

test('invited group routing wakes only mentioned humans targets and never loops agent output', async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'invited-routing-'));
  env = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
  process.env.HAGENCY_RUNTIME_DIR = directory; process.env.MATRIX_AGENT_PREFIX = 'ac_'; process.env.MATRIX_SERVER_NAME = 'test';
  const { MatrixBridge } = await import('../bridge-matrix.js?invited-routing');
  const bridge = new MatrixBridge();
  bridge.addKnownAgent('one'); bridge.addKnownAgent('two');
  const entries = ['one', 'two'].map(agentName => ({ sender: { agentName, agentUserId: `@ac_${agentName}:test` }, rooms: { '!room:test': {} } }));
  bridge.directChats = { entriesForRoom: () => entries, verify: vi.fn(async () => ({ mode: 'group', members: ['@alice:test', '@ac_one:test', '@ac_two:test'] })) };
  bridge.callBackendApi = vi.fn(async () => ({ ok: true }));
  bridge.submitHumanMessage = vi.fn(async () => ({ id: 'accepted' }));
  bridge.checkpointMatrixEvent = vi.fn(); bridge.beginAgentWork = vi.fn();
  const event = (id, sender, names = []) => ({ type: 'm.room.message', event_id: id, sender, origin_server_ts: 500,
    content: { msgtype: 'm.text', body: 'summarize the conversation', 'm.mentions': { user_ids: names.map(name => `@ac_${name}:test`) } } });
  await bridge.onInvitedAgentRoomMessage('!room:test', event('$background', '@alice:test'));
  expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  await bridge.onInvitedAgentRoomMessage('!room:test', event('$one', '@alice:test', ['one']));
  expect(bridge.submitHumanMessage).toHaveBeenLastCalledWith('!room:test', expect.objectContaining({ to: 'one', room_agent_targets: ['one'] }));
  await bridge.onInvitedAgentRoomMessage('!room:test', event('$both', '@alice:test', ['one', 'two']));
  expect(bridge.submitHumanMessage).toHaveBeenLastCalledWith('!room:test', expect.objectContaining({ room_agent_targets: ['one', 'two'] }));
  await bridge.onInvitedAgentRoomMessage('!room:test', event('$agent-output', '@ac_one:test', ['two']));
  expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(2);
  bridge.commands = { handle: vi.fn() }; bridge.rememberMatrixEvent = vi.fn();
  const command = event('$command', '@alice:test', ['one']); command.content.body = '!status';
  await bridge.onInvitedAgentRoomMessage('!room:test', command);
  expect(bridge.commands.handle).toHaveBeenCalledWith('!room:test', '@alice:test', '!status', expect.objectContaining({ targetAgent: 'one' }));
  expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(2);
  bridge.archiveConversationEvent = vi.fn(async () => ({ ok: true }));
  const media = event('$media', '@alice:test', ['two']); media.content.msgtype = 'm.image'; media.content.url = 'mxc://test/image';
  await bridge.onInvitedAgentRoomMessage('!room:test', media);
  expect(bridge.submitHumanMessage).toHaveBeenLastCalledWith('!room:test', expect.objectContaining({ summary: expect.stringContaining('Attachment event: $media') }));
  bridge.directChats.verify.mockImplementation(async entry => {
    if (entry.sender.agentName === 'one') throw new Error('room member is not joined');
    return { mode: 'group', members: ['@alice:test', '@ac_two:test'] };
  });
  await bridge.onInvitedAgentRoomMessage('!room:test', event('$remaining', '@alice:test', ['two']));
  expect(bridge.submitHumanMessage).toHaveBeenLastCalledWith('!room:test', expect.objectContaining({ room_agent_targets: ['two'] }));
});
