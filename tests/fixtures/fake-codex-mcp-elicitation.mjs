#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

const config = JSON.parse(readFileSync(process.env.FAKE_MCP_SCENARIO, 'utf8'));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const item = { id: 'mcp-item-1', type: 'mcpToolCall', server: 'hagency', tool: 'get_task',
  arguments: { id: 'task-fixture' }, status: 'inProgress', ...config.item };
const params = { threadId: 'thread-fake', turnId: 'turn-fake', serverName: item.server,
  mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: item.arguments, persist: ['session', 'always'] },
  message: 'Display text is deliberately not a source of tool identity',
  requestedSchema: { type: 'object', properties: {} }, ...config.params };
const request = { id: 0, method: 'mcpServer/elicitation/request', params, ...config.request };
if (config.omitRequestId) delete request.id;
// Permit the already-written response to drain before this fixture exits on termination.
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_MCP_RESPONSES, JSON.stringify(message) + '\n');
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-codex-mcp' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-fake' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-fake', status: 'inProgress' } } });
    if (config.completedBeforeStarted) send({ method: 'item/completed', params: {
      threadId: 'thread-fake', turnId: 'turn-fake', item,
    } });
    for (const candidate of config.items ?? [item]) send({ method: 'item/started', params: {
      threadId: 'thread-fake', turnId: 'turn-fake', item: candidate, ...config.itemContext,
    } });
    if (config.completedBeforeRequest) send({ method: 'item/completed', params: {
      threadId: 'thread-fake', turnId: 'turn-fake', item,
    } });
    send(request);
    if (config.interruptOwner) setTimeout(() => send(config.interruptOwner === 'duplicate'
      ? request : ['completed', 'restarted'].includes(config.interruptOwner)
        ? { method: config.interruptOwner === 'completed' ? 'item/completed' : 'item/started',
          params: { threadId: 'thread-fake', turnId: 'turn-fake', item } }
        : { id: 90, method: 'future/permission/request', params: {} }), 40);
    return;
  }
  if (message.id !== request.id || message.method) return;
  if (config.repeat && !config.repeated) {
    config.repeated = true;
    if (config.restartItem) {
      send({ method: 'item/completed', params: { threadId: 'thread-fake', turnId: 'turn-fake', item } });
      send({ method: 'item/started', params: { threadId: 'thread-fake', turnId: 'turn-fake', item } });
    }
    send({ ...request, id: config.repeat === 'same-id' ? request.id : 1 });
    return;
  }
  if (message.error || message.result?.action === 'cancel') return;
  send({ method: 'item/completed', params: { threadId: 'thread-fake', turnId: 'turn-fake', item } });
  send({ method: 'item/completed', params: { threadId: 'thread-fake', turnId: 'turn-fake',
    item: { type: 'agentMessage', phase: 'final_answer', text: message.result?.action ?? 'unexpected response' } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: 'turn-fake', status: 'completed' } } });
});
