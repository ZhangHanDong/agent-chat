import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotEnv, restoreEnv } from './helpers/env.js';

let directory, env;
afterEach(() => { if (env) restoreEnv(env); if (directory) rmSync(directory, { recursive: true, force: true }); });

test('invited group routing wakes only mentioned humans targets and never loops agent output', async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'invited-routing-'));
  env = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
  process.env.HAFLEET_RUNTIME_DIR = directory; process.env.MATRIX_AGENT_PREFIX = 'ac_'; process.env.MATRIX_SERVER_NAME = 'test';
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
