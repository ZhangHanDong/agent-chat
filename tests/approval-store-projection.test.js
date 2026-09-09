import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { ApprovalStoreError, createApprovalStore } from '../lib/approval-store.js';

const fixtureDirs = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const binding = { agent: 'worker', project: 'p', project_room_id: '!p:test', owner_mxid: '@owner:test', owner_dm_room_id: '!dm:test' };
function setup(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'approval-proj-'));
  fixtureDirs.push(dir);
  const file = path.join(dir, 'store.json');
  const store = createApprovalStore(file, { now: () => 1000, ...options });
  store.upsertBinding(binding);
  return { store, file };
}
function create(store, id = 'up-1', expiresAt) {
  return store.createRequest({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: id, tool_name: 'Bash', input_preview: 'pwd', expires_at: expiresAt }, { routerApprovalId: id });
}
function identity(plan, roomId) {
  return { publisher_mxid: plan.publisher_mxid, room_id: roomId, credential_generation: plan.credential_generation, transaction_id: plan.transaction_id };
}
function deliver(store, row, eventId) {
  const plan = store.prepareProjection(row.cas_token, { publisher_mxid: '@bot:test', homeserver: 'test', credential_kind: 'local_bot', credential_generation: 'g1', payload_version: 1, prepared_event_type: 'm.room.message', prepared_payload: { body: row.channel } }).plan;
  store.beginProjectionSend(plan.cas_token, identity(plan, row.target_room_id));
  store.receiptProjection(plan.cas_token, { ...identity(plan, row.target_room_id), event_id: eventId });
}
function drainRevision(store, revision) {
  store.listDueProjections().filter((row) => row.revision === revision).forEach((row, i) => deliver(store, row, `$event${revision}${i}`));
}

describe('approval projection store', () => {
  test('creation and transitions enqueue increasing canonical revisions privately', () => {
    const { store } = setup();
    const request = create(store);
    expect(request).not.toHaveProperty('projection_revision');
    expect(store.getRequest(request.id, { matrix: true })).not.toHaveProperty('projection_revision');
    expect(store.listDueProjections().map((row) => row.channel)).toEqual(['private_request', 'public_notice']);
    drainRevision(store, 1);
    const matrix = store.getRequest(request.id, { matrix: true });
    store.submitMatrixVerdict(request.id, { action: 'approve_once', sender_mxid: matrix.owner_mxid, room_id: matrix.owner_dm_room_id, agent: matrix.agent, project: matrix.project, project_room_id: matrix.project_room_id, input_digest: matrix.input_digest });
    expect(store.listDueProjections()).toEqual([expect.objectContaining({ revision: 2, channel: 'private_status', state: 'approved' })]);
    drainRevision(store, 2);
    store.consumeDecision(request.id, 'worker', matrix.input_digest);
    expect(store.listDueProjections()).toEqual([expect.objectContaining({ revision: 3, state: 'consumed' })]);
  });

  test('uncertain retry observes deadline and becomes receiptable with the same plan', () => {
    let now = 1000;
    const { store } = setup({ now: () => now });
    create(store);
    const row = store.listDueProjections()[0];
    const plan = store.prepareProjection(row.cas_token, { publisher_mxid: '@bot:test', homeserver: 'test', credential_kind: 'local_bot', credential_generation: 'g1', prepared_event_type: 'm.room.message', prepared_payload: { body: 'x' } }).plan;
    store.beginProjectionSend(plan.cas_token, identity(plan, row.target_room_id));
    store.retryProjection(plan.cas_token, { ...identity(plan, row.target_room_id), retry_at: 2000, error_code: 'timeout' });
    expect(store.listDueProjections().some((item) => item.channel === row.channel)).toBe(false);
    now = 2000;
    const due = store.listDueProjections().find((item) => item.channel === row.channel);
    expect(due.plan.attempt_state).toBe('uncertain');
    expect(store.beginProjectionSend(plan.cas_token, identity(plan, row.target_room_id)).plan.attempt_state).toBe('attempted');
    expect(store.receiptProjection(plan.cas_token, { ...identity(plan, row.target_room_id), event_id: '$same' })).toEqual({ event_id: '$same' });
    expect(store.receiptProjection(plan.cas_token, { ...identity(plan, row.target_room_id), event_id: '$same' })).toEqual({ event_id: '$same' });
  });

  test('full prepared-plan identity is required and immutable', () => {
    const { store } = setup();
    create(store);
    const row = store.listDueProjections()[0];
    const input = { publisher_mxid: '@bot:test', homeserver: 'test', credential_kind: 'local_bot', credential_generation: 'g1', prepared_event_type: 'm.room.message', prepared_payload: { body: 'x' } };
    const winner = store.prepareProjection(row.cas_token, input).plan;
    expect(store.prepareProjection(row.cas_token, { ...input, prepared_payload: { body: 'loser' } }).plan).toEqual(winner);
    store.beginProjectionSend(winner.cas_token, identity(winner, row.target_room_id));
    for (const mismatch of [{ room_id: '!wrong:test' }, { credential_generation: 'wrong' }, { transaction_id: 'wrong' }]) {
      expect(() => store.receiptProjection(winner.cas_token, { ...identity(winner, row.target_room_id), ...mismatch, event_id: '$wrong' })).toThrowError(/identity mismatch/);
    }
    expect(() => store.receiptProjection(winner.cas_token, { ...identity(winner, row.target_room_id), event_id: 'not-event' })).toThrowError(/Matrix event id/);
  });

  test('invalid verdict event id cannot mutate memory before validation', () => {
    const { store, file } = setup();
    const request = create(store);
    const matrix = store.getRequest(request.id, { matrix: true });
    expect(() => store.submitMatrixVerdict(request.id, { action: 'approve_once', sender_mxid: matrix.owner_mxid, room_id: matrix.owner_dm_room_id, agent: matrix.agent, project: matrix.project, project_room_id: matrix.project_room_id, input_digest: matrix.input_digest, event_id: 'x'.repeat(256) })).toThrow(ApprovalStoreError);
    expect(store.getRequest(request.id).status).toBe('pending');
    expect(JSON.parse(readFileSync(file)).requests[request.id].status).toBe('pending');
  });

  test('retry validation failure restores attempted state in memory and on disk', () => {
    const { store, file } = setup();
    create(store);
    const row = store.listDueProjections()[0];
    const plan = store.prepareProjection(row.cas_token, { publisher_mxid: '@bot:test', homeserver: 'test', credential_kind: 'local_bot', credential_generation: 'g1', prepared_event_type: 'm.room.message', prepared_payload: { body: 'x' } }).plan;
    store.beginProjectionSend(plan.cas_token, identity(plan, row.target_room_id));
    expect(() => store.retryProjection(plan.cas_token, { ...identity(plan, row.target_room_id), retry_at: 2000, error_code: 'x'.repeat(129) })).toThrowError(/exceeds 128/);
    expect(store.listDueProjections().find((item) => item.plan?.cas_token === plan.cas_token).plan.attempt_state).toBe('attempted');
    const diskRow = JSON.parse(readFileSync(file)).projectionOutbox.find((item) => item.planCasToken === plan.cas_token);
    expect(diskRow).toMatchObject({ attemptState: 'attempted', nextAttemptAt: 0 });
  });

  test('create conflict rolls back incidental expiry in memory and on disk', () => {
    let now = 1000;
    const { store, file } = setup({ now: () => now });
    const expiring = create(store, 'early', 1100);
    create(store, 'same');
    now = 1200;
    expect(() => store.createRequest({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'same', tool_name: 'Bash' })).toThrowError(/different approval origin/);
    expect(store.state.requests[expiring.id].status).toBe('pending');
    const disk = JSON.parse(readFileSync(file));
    expect(disk.requests[expiring.id].status).toBe('pending');
  });

  test('pre-rename rolls back and post-rename degradation blocks later writes until reload', () => {
    let phase = '';
    const { store, file } = setup({ fsFault: (name) => { if (phase === name) throw new Error(name); } });
    phase = 'beforeRename';
    expect(() => create(store)).toThrowError(/failed to persist/);
    expect(store.listRequests()).toHaveLength(0);
    phase = 'afterRename';
    expect(() => create(store, 'committed')).not.toThrow();
    expect(store.persistenceHealth().degraded).toBe(true);
    expect(() => create(store, 'blocked')).toThrowError(/requires reload/);
    expect(store.listRequests()).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(file)).requests)).toHaveLength(1);
    expect(createApprovalStore(file).listRequests()).toHaveLength(1);
  });

  test('expiry sweep reaches expired rows behind a long-lived prefix', () => {
    let now = 1000;
    const { store } = setup({ now: () => now, ttlMs: 10000 });
    create(store, 'long-1', 9000); create(store, 'long-2', 9000); create(store, 'expired', 1100);
    now = 1200;
    expect(store.sweepExpired({ limit: 1 })).toEqual({ scanned: 1, expired: 1 });
    expect(store.listRequests().find((r) => r.upstream_request_id === 'expired').status).toBe('expired');
  });

  test('legacy migration is bounded, resumable, and emits no actionable or null-target work', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'approval-v1-'));
    fixtureDirs.push(dir);
    const file = path.join(dir, 'store.json');
    const request = (id, status, expiresAt, room = '!dm:test') => ({ id, agent: 'worker', runtime: 'codex', project: 'p', projectRoomId: '!p:test', ownerMxid: '@owner:test', ownerDmRoomId: room, upstreamRequestId: id, inputDigest: `d-${id}`, status, decision: status === 'consumed' ? 'allow' : null, createdAt: 1, expiresAt });
    writeFileSync(file, JSON.stringify({ version: 1, bindings: {}, requests: { a: request('a', 'pending', 500), b: request('b', 'consumed', 5000), c: request('c', 'pending', 5000, null) }, audit: [] }));
    let store = createApprovalStore(file, { now: () => 1000, migrationBatchSize: 1 });
    expect(store.listDueProjections()).toEqual([expect.objectContaining({ request_id: 'a', state: 'expired', migration_kind: 'legacy_v1' })]);
    store = createApprovalStore(file, { now: () => 1000, migrationBatchSize: 1 });
    store.migrateLegacyBatch();
    store = createApprovalStore(file, { now: () => 1000, migrationBatchSize: 1 });
    store.migrateLegacyBatch();
    const due = store.listDueProjections({ limit: 20 });
    expect(due.every((row) => row.channel === 'private_status' && row.target_room_id)).toBe(true);
    expect(due.some((row) => row.state === 'pending' && row.request_id === 'a')).toBe(false);
  });

  test('denied request without binding cannot enqueue a null-target status on consume', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'approval-unbound-'));
    fixtureDirs.push(dir);
    const store = createApprovalStore(path.join(dir, 'store.json'), { now: () => 1000 });
    const denied = store.createRequest({ agent: 'worker', runtime: 'codex', upstream_request_id: 'u', tool_name: 'Bash' });
    store.consumeDecision(denied.id, 'worker');
    expect(store.listDueProjections()).toEqual([]);
  });
});
