import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouter, operationDigest, runCodexDispatch } from '../router/dist/index.js';
import { codexPermissionRequestNeedsOwnerApproval } from '../lib/codex-permission-hook.js';

const roots = [];
const stores = [];
const executable = fileURLToPath(new URL('./fixtures/fake-codex-mcp-elicitation.mjs', import.meta.url));
function setup(scenario = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-native-mcp-'));
  roots.push(root);
  const router = openRouter({ dbPath: path.join(root, 'router.db') });
  stores.push(router);
  const ingested = router.ingestMessage({ messageId: 'root', roomId: '!room:test', matrixEventId: '$root',
    senderName: 'alex', recipientAgentId: 'agent-id', recipientAgentName: 'agent', normalizedBody: 'read diagnostic' });
  router.registerWorkspace({ resourceId: 'workspace', safeLabel: 'workspace', backendPath: root });
  const queued = router.enqueueDispatch({ sessionId: ingested.session.sessionId, framework: 'codex', localServerId: 'local',
    mayWrite: false, workspaceResourceId: 'workspace', payload: { prompt: 'read diagnostic' } });
  const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8 });
  const scenarioPath = path.join(root, 'scenario.json');
  const responsesPath = path.join(root, 'responses.jsonl');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const owner = vi.fn(async () => ({ decisionEventId: 'owner-event', decision: 'deny' }));
  const options = { router, claim, cwd: root, executable,
    env: { FAKE_MCP_SCENARIO: scenarioPath, FAKE_MCP_RESPONSES: responsesPath },
    acknowledgementTimeoutMs: 1000, executionTimeoutMs: 400, approvalTimeoutMs: 1000, maxParkedRunners: 4,
    mcpServer: { name: 'hafleet', command: process.execPath, args: ['/fixture/mcp.js'], envVars: [] },
    coordinationNeedsOwnerApproval: codexPermissionRequestNeedsOwnerApproval, requestOwnerApproval: owner };
  return { root, router, queued, owner, options, responsesPath };
}
const state = (ctx) => ctx.router.db.prepare('SELECT state FROM dispatches WHERE dispatch_id=?').get(ctx.queued.dispatchId).state;
async function responses(ctx) {
  // A terminated child drains its response pipe before its short fixture-only exit delay.
  for (let i = 0; i < 30; i++) {
    const rows = readFileSync(ctx.responsesPath, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.id !== undefined && !r.method);
    if (rows.length) return rows;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return [];
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Codex native MCP approval adapter', () => {
  test('native HAFleet coordination uses the existing exact predicate and accepts only once', async () => {
    for (const item of [{ tool: 'get_task' }, { tool: 'send_message', arguments: { to: 'alex', summary: 'done', attachments: [] } }]) {
      const ctx = setup({ item });
      expect(await runCodexDispatch(ctx.options)).toMatchObject({ state: 'completed', text: 'accept' });
      expect(ctx.owner).not.toHaveBeenCalled();
      expect(ctx.router.db.prepare('SELECT COUNT(*) count FROM approval_waits').get().count).toBe(0);
      expect((await responses(ctx))[0]).toEqual({ id: 0, result: { action: 'accept', content: null, _meta: null } });
    }
  });

  test('native MCP owner approval binds actual item request and digest before native response', async () => {
    for (const [item, decision] of [
      [{ server: 'other', tool: 'get_task' }, 'allow'],
      [{ tool: 'get_task_extra' }, 'deny'],
      [{ tool: 'send_message', arguments: { attachments: [{ path: '/private/file' }] } }, 'deny'],
    ]) {
      const ctx = setup({ item });
      ctx.options.requestOwnerApproval = vi.fn(async (request) => {
        expect(state(ctx)).toBe('parked');
        expect(request).toMatchObject({ kind: 'mcp_tool_call', upstreamItemId: 'mcp-item-1', upstreamRequestId: '0',
          mcp: { serverName: item.server ?? 'hafleet', toolName: item.tool } });
        expect(request.operationDigest).toMatch(/^[a-f0-9]{64}$/);
        return { decisionEventId: 'owner-event', decision };
      });
      const applied = vi.spyOn(ctx.router, 'recordApprovalDecision');
      const resumed = vi.spyOn(ctx.router, 'resumeAfterApproval');
      expect(await runCodexDispatch(ctx.options)).toMatchObject({ state: 'completed', text: decision === 'allow' ? 'accept' : 'decline' });
      expect(applied).toHaveBeenCalledOnce();
      expect(resumed).toHaveBeenCalledOnce();
      const wait = ctx.router.db.prepare('SELECT * FROM approval_waits').get();
      expect(wait).toMatchObject({ upstream_item_id: 'mcp-item-1', upstream_request_id: '0', decision });
      expect((await responses(ctx))[0].result).toEqual({ action: decision === 'allow' ? 'accept' : 'decline', content: null, _meta: null });
    }
  });

  test('missing injected coordination policy keeps even get_task owner gated', async () => {
    const ctx = setup();
    delete ctx.options.coordinationNeedsOwnerApproval;
    expect(await runCodexDispatch(ctx.options)).toMatchObject({ text: 'decline' });
    expect(ctx.owner).toHaveBeenCalledOnce();
  });

  test('rejects missing ambiguous stale wrong-turn and mismatched-argument MCP candidates', async () => {
    const base = { id: 'item-a', type: 'mcpToolCall', server: 'hafleet', tool: 'get_task', arguments: { id: 'task-fixture' }, status: 'inProgress' };
    for (const scenario of [
      { items: [] }, { completedBeforeRequest: true }, { completedBeforeStarted: true }, { itemContext: { turnId: 'old-turn' } },
      { params: { threadId: 'other-thread' } }, { params: { turnId: 'other-turn' } },
      { params: { serverName: 'other-server' } },
      { params: { _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { id: 'different' } } } },
      { params: { _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: JSON.parse('{"id":"task-fixture","__proto__":{"target":"private"}}') } } },
      { items: [base, { ...base, id: 'item-b', tool: 'delete_project' }] },
    ]) {
      const ctx = setup(scenario);
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/MCP.*correlation|MCP.*identity/i);
      expect(ctx.owner).not.toHaveBeenCalled();
      expect(state(ctx)).toBe('outcome_unknown');
      expect((await responses(ctx))[0]?.result).toMatchObject({ action: 'cancel' });
    }
  });

  test('duplicate elicitation cannot consume the same tool item twice', async () => {
    for (const scenario of [{ repeat: 'same-id' }, { repeat: 'new-id' }, { repeat: 'new-id', restartItem: true }]) {
      const ctx = setup(scenario);
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/duplicate|correlation|consumed/i);
      expect(ctx.owner).not.toHaveBeenCalled();
      expect(state(ctx)).toBe('outcome_unknown');
      const replies = await responses(ctx);
      expect(replies.filter((r) => r.result?.action === 'accept')).toHaveLength(1);
    }
  });

  test('rejects URL input-form malformed and uncorrelated elicitation requests', async () => {
    for (const params of [
      { mode: 'url', url: 'https://auth.invalid', elicitationId: 'url-id' },
      { requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
      { _meta: null }, { turnId: null }, { serverName: null },
      ...['allOf', '$ref', 'additionalProperties'].map((key) => ({
        requestedSchema: { type: 'object', properties: {}, [key]: key === '$ref' ? '#/requires-input' : false },
      })),
    ]) {
      const ctx = setup({ params });
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/MCP/);
      expect(ctx.owner).not.toHaveBeenCalled();
      expect(state(ctx)).toBe('outcome_unknown');
      expect((await responses(ctx))[0]?.result).toMatchObject({ action: 'cancel' });
    }
  });

  test('unknown server RPC receives a protocol error and visible outcome_unknown', async () => {
    const ctx = setup({ request: { method: 'future/permission/request' } });
    await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/unsupported.*future\/permission\/request/i);
    expect(state(ctx)).toBe('outcome_unknown');
    expect((await responses(ctx))[0]?.error).toMatchObject({ code: -32601 });
  });

  test('malformed or absent native request IDs fail visibly without accepting', async () => {
    for (const scenario of [null, true, {}, [], 1.5].map((id) => ({ request: { id } })).concat([{ omitRequestId: true }])) {
      const ctx = setup(scenario);
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/request id/i);
      expect(state(ctx)).toBe('outcome_unknown');
      expect(ctx.owner).not.toHaveBeenCalled();
      expect((await responses(ctx))[0]).toMatchObject({ id: null, error: { code: -32600 } });
    }
  });

  test('owner approval rejection and persistence refusal cancel without accepting', async () => {
    for (const failure of ['owner', 'persistence']) {
      const ctx = setup({ item: { tool: 'unknown_tool' } });
      ctx.options.requestOwnerApproval = async () => {
        if (failure === 'owner') throw new Error('owner delivery unavailable');
        return { decisionEventId: 'owner-event', decision: 'allow' };
      };
      if (failure === 'persistence') vi.spyOn(ctx.router, 'recordApprovalDecision').mockReturnValue({ ok: false, code: 'approval_mismatch', message: 'rejected binding' });
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/owner delivery|approval_mismatch/);
      expect(state(ctx)).toBe('outcome_unknown');
      expect((await responses(ctx)).some((r) => r.result?.action === 'accept')).toBe(false);
    }
  });

  test('a late owner allow after duplicate or unknown RPC cannot resume or accept', async () => {
    for (const interruptOwner of ['duplicate', 'unknown']) {
      const ctx = setup({ item: { tool: 'unknown_tool' }, interruptOwner });
      let deliver;
      ctx.options.requestOwnerApproval = () => new Promise((resolve) => { deliver = resolve; });
      const applied = vi.spyOn(ctx.router, 'recordApprovalDecision');
      const resumed = vi.spyOn(ctx.router, 'resumeAfterApproval');
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/Duplicate|Unsupported/);
      expect(deliver).toBeTypeOf('function');
      deliver({ decisionEventId: 'late-event', decision: 'allow' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(state(ctx)).toBe('outcome_unknown');
      expect(applied).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
      expect((await responses(ctx)).some((r) => r.result?.action === 'accept')).toBe(false);
    }
  });

  test('an item completed or restarted while owner approval waits cannot receive a late allow', async () => {
    for (const interruptOwner of ['completed', 'restarted']) {
      const ctx = setup({ item: { tool: 'unknown_tool' }, interruptOwner });
      ctx.options.requestOwnerApproval = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { decisionEventId: 'late-event', decision: 'allow' };
      };
      const applied = vi.spyOn(ctx.router, 'recordApprovalDecision');
      const resumed = vi.spyOn(ctx.router, 'resumeAfterApproval');
      await expect(runCodexDispatch(ctx.options)).rejects.toThrow(/MCP.*no longer active/);
      expect(state(ctx)).toBe('outcome_unknown');
      expect(applied).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
      expect((await responses(ctx))[0]?.result).toMatchObject({ action: 'cancel' });
    }
  });

  test('operation digest binds all MCP arguments without depending on display order', () => {
    expect(operationDigest('mcpServer/elicitation/request', { _meta: { tool_params: { a: 1, b: 2 } } }))
      .toBe(operationDigest('mcpServer/elicitation/request', { _meta: { tool_params: { b: 2, a: 1 } } }));
    expect(operationDigest('mcpServer/elicitation/request', { _meta: { tool_params: { a: 1 } } }))
      .not.toBe(operationDigest('mcpServer/elicitation/request', { _meta: { tool_params: { a: 2 } } }));
    expect(operationDigest('mcpServer/elicitation/request', JSON.parse('{"arguments":{"__proto__":{"target":"private"},"text":"hi"}}')))
      .not.toBe(operationDigest('mcpServer/elicitation/request', { arguments: { text: 'hi' } }));
  });
});
