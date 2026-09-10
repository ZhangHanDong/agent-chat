import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatrixDirectChats } from '../lib/matrix-direct-chat.js';
import { matrixActivityContent, ACTIVITY_KEY } from '../lib/matrix-activity.js';
import { snapshotEnv, restoreEnv } from './helpers/env.js';

let MatrixBridge, env, directory;
beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'hagency-matrix-activity-'));
  env = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
  process.env.HAGENCY_RUNTIME_DIR = directory;
  process.env.MATRIX_AGENT_PREFIX = 'ac_'; process.env.MATRIX_SERVER_NAME = 'test';
  ({ MatrixBridge } = await import('../bridge-matrix.js'));
});
afterAll(() => { restoreEnv(env); rmSync(directory, { recursive: true, force: true }); });

test('activity edits preserve threads and encrypted DM routing without becoming model input', async () => {
  const command = { commandId: 'notice-one', dispatchId: 'dispatch', senderAgentName: 'edison', roomId: '!room:test',
    threadRootEventId: '$thread', transactionId: 'txn1', claimToken: 'claim', body: '正在运行命令', activity: { replaceEventId: '$status' } };
  const bridge = new MatrixBridge(); bridge.addKnownAgent('edison');
  bridge.getAgentToken = () => 'token';
  bridge.agentSenderFor = () => ({ kind: 'appservice', agentUserId: '@ac_edison:test' });
  bridge.sendAsAgentContent = vi.fn(async () => '$edit');
  bridge.callBackendApi = vi.fn(async () => ({}));
  await bridge.deliverRouterCommand('reply', command);
  const content = bridge.sendAsAgentContent.mock.calls[0][2];
  expect(content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$status' });
  expect(content['m.new_content']['m.relates_to']).toMatchObject({ rel_type: 'm.thread', event_id: '$thread' });
  expect(content.msgtype).toBe('m.notice');
  const event = { event_id: '$edit', sender: '@ac_edison:test', content };
  expect(await bridge._onRoomMessageClaimed('!room:test', event, '$edit')).toMatchObject({ reason: 'agent_activity' });
  expect(await bridge.onInvitedAgentRoomMessage('!room:test', event)).toMatchObject({ reason: 'agent_activity' });
  expect(bridge.isAgentActivity({ ...event, sender: '@human:test' }, '!room:test')).toBe(false);
  expect(bridge.isAgentActivity({ ...event, sender: '@ac_edison:foreign' }, '!room:test')).toBe(false);

  const manager = new MatrixDirectChats({ directory, onMessage: vi.fn(), backend: vi.fn(), warning: vi.fn() });
  const encrypt = vi.fn(async (_room, _type, value) => { expect(value[ACTIVITY_KEY]).toBeDefined(); return { ciphertext: 'encrypted' }; });
  const entry = { sender: { agentName: 'edison', agentUserId: '@ac_edison:test' }, rooms: { '!room:test': { mode: 'direct' } },
    client: { getRoomState: vi.fn(async () => [{ type: 'm.room.encryption', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]),
      crypto: { encryptRoomEvent: encrypt }, doRequest: vi.fn(async () => ({ event_id: '$encrypted' })) } };
  manager.clients.set('@ac_edison:test', entry); manager.verify = vi.fn(async () => ({}));
  await manager.send('!room:test', content, 'txn2', 'edison');
  const encryptedContent = encrypt.mock.calls[0][2];
  expect(encryptedContent['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$status' });
  expect(encryptedContent['m.new_content']['m.relates_to']).toBeUndefined();
  expect(entry.client.doRequest.mock.calls[0][1]).toContain('/send/m.room.encrypted/txn2');
  entry.rooms['!room:test'] = { mode: 'group', privateRootEventId: '$thread' };
  await expect(manager.send('!room:test', content, 'blocked', 'edison')).rejects.toThrow('private reply');
  expect(encrypt).toHaveBeenCalledTimes(1);
  const initial = matrixActivityContent({ ...command, activity: { replaceEventId: null } });
  expect(initial['m.new_content']).toBeUndefined();
});
