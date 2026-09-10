import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { createLoopbackTestServer } from './helpers/loopback-test-server.js';

test('backend context exposes an awaited IPv4 server that reaches its own handler', async () => {
  const context = await createBackendTestContext('backend-loopback-', {
    agents: { loopback_owned_agent: { name: 'loopback_owned_agent', kind: 'agent', type: 'agent' } },
  });
  let pending;
  try {
    pending = request(context.app).get('/api/agents').query({ view: 'names' });
    // Check before sending: a wildcard listener could route the request to an
    // unrelated local service on macOS, which the regression must never probe.
    expect(pending.app.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(pending.app).toBe(context.app);
    let ownedRequests = 0;
    context.app.once('request', () => { ownedRequests++; });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toContain('loopback_owned_agent');
    expect(ownedRequests).toBe(1);
    expect(context.app.listening).toBe(true);
    expect(context.expressApp).toBe(context.backendModule.app);
    expect(typeof context.expressApp).toBe('function');
  } finally {
    if (pending?._server?.listening) await new Promise(resolve => pending._server.close(resolve));
    await context.cleanup();
  }
});

test('loopback fixture refuses an occupied IPv4 port without reaching another handler', async () => {
  let unrelatedRequests = 0;
  let intendedRequests = 0;
  const occupied = await createLoopbackTestServer((_req, res) => {
    unrelatedRequests++;
    res.statusCode = 404;
    res.end('unrelated owned fixture');
  });
  try {
    await expect(createLoopbackTestServer((_req, res) => {
      intendedRequests++;
      res.statusCode = 403;
      res.end('intended owned fixture');
    }, { port: occupied.server.address().port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(unrelatedRequests).toBe(0);
    expect(intendedRequests).toBe(0);
  } finally {
    await occupied.close();
  }
});

test('backend context cleanup closes the owned listener and remains awaitable', async () => {
  const context = await createBackendTestContext('backend-loopback-cleanup-');
  try {
    expect(context.app.listening).toBe(true);
    let closed = false;
    context.app.once('close', () => { closed = true; });
    const closing = context.cleanup();
    expect(context.app.listening).toBe(false);
    await closing;
    expect(closed).toBe(true);
    expect(context.app.address()).toBe(null);
    expect(existsSync(context.runtimeDir)).toBe(false);
    await context.cleanup();
  } finally {
    await context.cleanup();
  }
});
