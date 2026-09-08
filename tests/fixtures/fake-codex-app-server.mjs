#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

if (process.env.FAKE_CODEX_EXIT_IMMEDIATELY === '1') process.exit(17);
if (process.env.FAKE_CODEX_ARGV_LOG) writeFileSync(process.env.FAKE_CODEX_ARGV_LOG, JSON.stringify(process.argv.slice(2)));

if (process.env.FAKE_CODEX_TOOL_TREE) {
  const { startDetachedToolTree } = await import('./fake-detached-tool-tree.mjs');
  await startDetachedToolTree(process.env.FAKE_CODEX_TOOL_TREE);
}

if (process.env.FAKE_CODEX_SHUTDOWN_LOG) {
  process.on('SIGTERM', () => {
    writeFileSync(process.env.FAKE_CODEX_SHUTDOWN_LOG, String(process.pid));
    const poll = setInterval(() => {
      if (!existsSync(process.env.FAKE_CODEX_SHUTDOWN_RELEASE)) return;
      clearInterval(poll);
      appendFileSync(process.env.FAKE_CODEX_SHUTDOWN_LOG, '\nlast write');
      process.exit(0);
    }, 10);
  });
}

// When set, append every sandbox value the runner requests, one JSON line per
// entry, so an effect test can assert what the runtime was actually launched
// with rather than trusting the launch descriptor.
const sandboxLogPath = process.env.FAKE_CODEX_SANDBOX_LOG || null;
function recordSandbox(level, value) {
  if (!sandboxLogPath) return;
  try {
    appendFileSync(sandboxLogPath, `${JSON.stringify({ level, value })}\n`);
  } catch {
    // Best-effort: a logging failure must not change runner behavior.
  }
}

const wrongThread = process.env.FAKE_CODEX_WRONG_THREAD === '1';
if (process.env.FAKE_CODEX_REQUIRE_MCP_CONFIG === '1') {
  const argv = process.argv.slice(2).join('\n');
  const required = [
    'mcp_servers.hafleet.command=',
    'mcp_servers.hafleet.args=',
    'mcp_servers.hafleet.env_vars=',
  ];
  if (required.some((marker) => !argv.includes(marker))
    || !process.env.HAFLEET_DISPATCH_CAPABILITY
    || process.env.HAFLEET_EPHEMERAL_RUNNER !== '1') {
    process.exit(23);
  }
}
let turnRequestId = null;
let approvalRequestId = process.env.FAKE_CODEX_RETRY_DENIED_ELICITATION ? 0 : 91;
let issuedApproval = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'thread/start') {
    if (process.env.FAKE_CODEX_THREAD_START_LOG) writeFileSync(process.env.FAKE_CODEX_THREAD_START_LOG, JSON.stringify(message.params));
    recordSandbox('thread', message.params?.sandbox);
    send({ id: message.id, result: { thread: { id: 'thread-fake' } } });
    return;
  }
  if (message.method === 'turn/start') {
    if (process.env.FAKE_CODEX_TURN_START_LOG) writeFileSync(process.env.FAKE_CODEX_TURN_START_LOG, JSON.stringify(message.params));
    if (process.env.FAKE_CODEX_PROMPT_LOG) writeFileSync(process.env.FAKE_CODEX_PROMPT_LOG, JSON.stringify(message.params?.input));
    recordSandbox('turn', message.params?.sandboxPolicy);
    turnRequestId = message.id;
    if (process.env.FAKE_CODEX_WITHHOLD_TURN_ID !== '1') {
      send({ id: turnRequestId, result: { turn: { id: 'turn-fake', status: 'inProgress' } } });
    }
    if (process.env.FAKE_CODEX_ACTIVITY) {
      send({ method: 'item/started', params: { threadId: 'thread-fake', turnId: 'foreign-turn', item: { id: 'foreign-turn', type: 'commandExecution' } } });
      for (const threadId of ['foreign', 'thread-fake']) send({ method: 'item/started', params: {
        threadId, turnId: 'turn-fake', item: { id: threadId, type: 'commandExecution', command: 'SECRET', cwd: '/secret-path', output: 'raw-output' },
      } });
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId: 'thread-fake', turnId: 'turn-fake', item: { id: 'thread-fake', type: 'commandExecution' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-fake', turnId: 'turn-fake', item: { type: 'agentMessage', phase: 'final_answer', text: 'activity result' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: 'turn-fake', status: 'completed' } } });
      }, 250);
      return;
    }
    issuedApproval = {
      id: approvalRequestId,
      method: process.env.FAKE_CODEX_ELICITATION ? 'mcpServer/elicitation/request' : 'item/commandExecution/requestApproval',
      params: process.env.FAKE_CODEX_ELICITATION ? {
        threadId: wrongThread ? 'thread-wrong' : 'thread-fake',
        ...(process.env.FAKE_CODEX_ELICITATION_NO_TURN ? {} : { turnId: 'turn-fake' }),
        serverName: 'hafleet', mode: 'form', message: 'Allow create_task?',
        requestedSchema: { type: 'object', properties: process.env.FAKE_CODEX_ELICITATION === 'input' ? { secret: { type: 'string' } } : {} },
        _meta: { tool_params: { assignee: 'peer', title: 'delegated work' } },
      } : {
        threadId: wrongThread ? 'thread-wrong' : 'thread-fake',
        turnId: 'turn-fake',
        itemId: 'item-command',
        command: process.env.FAKE_CODEX_APPROVAL_COMMAND || '/bin/echo safe',
        cwd: process.cwd(),
        reason: 'test command',
      },
    };
    send(issuedApproval);
    return;
  }
  if (message.id === approvalRequestId && message.result) {
    if (process.env.FAKE_CODEX_APPROVAL_LOG) writeFileSync(process.env.FAKE_CODEX_APPROVAL_LOG, JSON.stringify(message));
    const accepted = process.env.FAKE_CODEX_ELICITATION ? message.result.action === 'accept' : message.result.decision === 'accept';
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-fake', requestId: approvalRequestId } });
    if (process.env.FAKE_CODEX_RETRY_DENIED_ELICITATION && approvalRequestId === 0 && !accepted) {
      approvalRequestId = 1;
      send({ ...issuedApproval, id: approvalRequestId });
      return;
    }
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-fake', turnId: 'turn-fake',
        item: { type: 'agentMessage', phase: 'final_answer', text: accepted ? 'approved result' : 'denied result' },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread-fake', turn: { id: 'turn-fake', status: 'completed' } },
    });
  }
});
