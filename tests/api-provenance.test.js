import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLoopbackTestServer } from './helpers/loopback-test-server.js';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('provenance metadata (5.8.3 Layer 1)', () => {
  const bridgeSecret = 'provenance-bridge-secret';
  let runtimeDir;
  let app;
  let backendModule;
  let listener;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-provenance-'));
    const dataDir = path.join(runtimeDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeJson(path.join(dataDir, 'agents.json'), {
      alice: { name: 'alice', type: 'agent', kind: 'agent', online: false },
    });
    writeJson(path.join(dataDir, 'groups.json'), { project: { name: 'project', members: ['alice'] } });
    writeJson(path.join(dataDir, 'messages.json'), []);
    writeJson(path.join(dataDir, 'cursors.json'), {});
    writeJson(path.join(dataDir, 'servers.json'), {});
    writeJson(path.join(dataDir, 'agent_runtime.json'), {});
    writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });

    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.SUPERVISOR_ENABLED = 'false';
    process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
    process.env.MATRIX_OPERATOR_MXIDS = '@ops:matrix.test';
    process.env.MATRIX_BRIDGE_SECRET = bridgeSecret;

    const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    backendModule = await import(`${backendUrl}?provenance-test=${cacheBust}`);
    listener = await createLoopbackTestServer(backendModule.app);
    app = listener.server;
  });

  afterAll(async () => {
    await listener?.close();
    await backendModule?.stopServer();
    rmSync(runtimeDir, { recursive: true, force: true });
    delete process.env.MATRIX_BRIDGE_SECRET;
  });

  test('Matrix message carries senderMxid through to inbox summary', async () => {
    // Post a message with sender_mxid (as bridge would)
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'hello from matrix',
        full: 'hello from matrix',
        source: 'matrix',
        source_room: '!room1:matrix.test',
        sender_mxid: '@human:matrix.test',
        source_event_id: '$provenance-human',
      });
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);

    // Read inbox and verify provenance fields
    const inboxRes = await request(app).get('/api/inbox/alice');
    expect(inboxRes.status).toBe(200);
    const msg = inboxRes.body.dm.find(m => m.summary === 'hello from matrix');
    expect(msg).toBeDefined();
    expect(msg.source).toBe('matrix');
    expect(msg.sourceRoom).toBe('!room1:matrix.test');
    expect(msg.senderMxid).toBe('@human:matrix.test');
  });

  test('API-origin message has senderMxid=null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'api origin message',
        full: 'body',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    expect(inboxRes.status).toBe(200);
    const msg = inboxRes.body.dm.find(m => m.summary === 'api origin message');
    expect(msg).toBeDefined();
    expect(msg.source).toBe('api');
    expect(msg.sourceRoom).toBeNull();
    expect(msg.senderMxid).toBeNull();
  });

  test('an agent group reply inherits backend-owned Matrix room and event context', async () => {
    const inbound = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'alex', group: 'project', type: 'human', summary: 'question', full: 'question',
        source: 'matrix', source_room: '!project:matrix.test', source_event_id: '$question',
        sender_mxid: '@alex:matrix.test',
    });
    expect(inbound.status).toBe(200);
    const persistedAfterInbound = JSON.parse(readFileSync(path.join(runtimeDir, 'data', 'messages.json'), 'utf8'));
    expect(persistedAfterInbound.find((msg) => msg.id === inbound.body.id)).toMatchObject({
      group: 'project', source: 'matrix',
      matrixContext: { roomId: '!project:matrix.test', eventId: '$question' },
    });

    const reply = await request(app).post('/api/messages').send({
      from: 'alice', group: 'project', type: 'reply', summary: 'answer', reply_to: inbound.body.id,
    });
    expect(reply.status).toBe(200);
    const persisted = JSON.parse(readFileSync(path.join(runtimeDir, 'data', 'messages.json'), 'utf8'));
    expect(persisted.find((msg) => msg.id === reply.body.id)?.replyContext).toEqual({
      roomId: '!project:matrix.test', eventId: '$question', threadRootEventId: null,
    });
  });

  test('sender_mxid is truncated at 255 chars for matrix source', async () => {
    const longMxid = '@' + 'a'.repeat(300) + ':matrix.test';
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'truncation test',
        full: 'body',
        source: 'matrix',
        sender_mxid: longMxid,
        source_event_id: '$provenance-long-mxid',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'truncation test');
    expect(msg.senderMxid).toBeDefined();
    expect(msg.senderMxid.length).toBeLessThanOrEqual(255);
  });

  test('API-origin message with forged sender_mxid is stored as null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'forged mxid attempt',
        full: 'body',
        sender_mxid: '@operator:matrix.test',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'forged mxid attempt');
    expect(msg).toBeDefined();
    expect(msg.senderMxid).toBeNull();
  });

  test('invalid MXID format is rejected even from matrix source', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'bad mxid format',
        full: 'body',
        source: 'matrix',
        sender_mxid: 'not-a-valid-mxid',
        source_event_id: '$provenance-invalid-mxid',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'bad mxid format');
    expect(msg).toBeDefined();
    expect(msg.senderMxid).toBeNull();
  });

  test('Matrix message from operator MXID gets trustLevel=operator (derived server-side)', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'operator trust test',
        full: 'operator trust test',
        source: 'matrix',
        sender_mxid: '@ops:matrix.test',
        source_event_id: '$provenance-operator',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'operator trust test');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBe('operator');
  });

  test('Matrix message from non-operator gets trustLevel=external (derived server-side)', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'external trust test',
        full: 'external trust test',
        source: 'matrix',
        sender_mxid: '@rando:evil.test',
        source_event_id: '$provenance-external',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'external trust test');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBe('external');
  });

  test('forged trust_level=operator with non-operator MXID is overridden to external', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'forged trust level',
        full: 'forged trust level',
        source: 'matrix',
        sender_mxid: '@hacker:evil.test',
        trust_level: 'operator',
        source_event_id: '$provenance-forged-trust',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'forged trust level');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBe('external');
  });

  test('Matrix source with no senderMxid has trustLevel=null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .set('X-Bridge-Secret', bridgeSecret)
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'matrix no mxid',
        full: 'body',
        source: 'matrix',
        trust_level: 'operator',
        source_event_id: '$provenance-no-mxid',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'matrix no mxid');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBeNull();
  });

  test('non-Matrix message has trustLevel=null even with forged trust_level', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'api forged trust',
        full: 'body',
        trust_level: 'operator',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'api forged trust');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBeNull();
  });

  test('correct bridge secret allows senderMxid + trustLevel', async () => {
    process.env.MATRIX_BRIDGE_SECRET = 'test-secret-abc';
    try {
      const postRes = await request(app)
        .post('/api/messages')
        .set('X-Bridge-Secret', 'test-secret-abc')
        .send({
          from: 'system',
          to: 'alice',
          type: 'human',
          summary: 'bridge secret ok',
          full: 'bridge secret ok',
          source: 'matrix',
          sender_mxid: '@ops:matrix.test',
          source_event_id: '$provenance-secret-ok',
        });
      expect(postRes.status).toBe(200);

      const inboxRes = await request(app).get('/api/inbox/alice');
      const msg = inboxRes.body.dm.find(m => m.summary === 'bridge secret ok');
      expect(msg).toBeDefined();
      expect(msg.senderMxid).toBe('@ops:matrix.test');
      expect(msg.trustLevel).toBe('operator');
    } finally {
      process.env.MATRIX_BRIDGE_SECRET = bridgeSecret;
    }
  });

  test('wrong bridge secret rejects senderMxid + trustLevel', async () => {
    process.env.MATRIX_BRIDGE_SECRET = 'test-secret-abc';
    try {
      const postRes = await request(app)
        .post('/api/messages')
        .set('X-Bridge-Secret', 'wrong-secret')
        .send({
          from: 'system',
          to: 'alice',
          type: 'human',
          summary: 'bridge secret bad',
          full: 'bridge secret bad',
          source: 'matrix',
          sender_mxid: '@ops:matrix.test',
          source_event_id: '$provenance-secret-wrong',
        });
      expect(postRes.status).toBe(401);

      const inboxRes = await request(app).get('/api/inbox/alice');
      const msg = inboxRes.body.dm.find(m => m.summary === 'bridge secret bad');
      expect(msg).toBeUndefined();
    } finally {
      process.env.MATRIX_BRIDGE_SECRET = bridgeSecret;
    }
  });

  test('missing bridge secret header rejects when MATRIX_BRIDGE_SECRET is set', async () => {
    process.env.MATRIX_BRIDGE_SECRET = 'test-secret-abc';
    try {
      const postRes = await request(app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alice',
          type: 'human',
          summary: 'bridge secret missing',
          full: 'bridge secret missing',
          source: 'matrix',
          sender_mxid: '@ops:matrix.test',
          source_event_id: '$provenance-secret-missing',
        });
      expect(postRes.status).toBe(401);

      const inboxRes = await request(app).get('/api/inbox/alice');
      const msg = inboxRes.body.dm.find(m => m.summary === 'bridge secret missing');
      expect(msg).toBeUndefined();
    } finally {
      process.env.MATRIX_BRIDGE_SECRET = bridgeSecret;
    }
  });
});
