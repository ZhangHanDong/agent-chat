import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

let context;
let competing;
afterEach(async () => {
  context?.cleanup(); context = null;
  if (competing?.listening) await new Promise((resolve) => competing.close(resolve));
  competing = null;
});

test('backend fixtures bind the exact IPv4 loopback address used by Supertest', async () => {
  context = await createBackendTestContext('fixture-loopback-', {
    agents: { owned: { name: 'owned', kind: 'agent', type: 'codex', online: true } },
  });
  const address = context.app.address();
  expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  let competingRequests = 0;
  competing = http.createServer((_req, res) => { competingRequests += 1; res.end('wrong listener'); });
  const bind = await new Promise((resolve) => {
    competing.once('error', (error) => resolve(error.code));
    competing.listen(address.port, '::', () => resolve('bound'));
  });
  // Darwin permits overlapping wildcard-v6 and explicit-v4 listeners; platforms
  // that exclude the overlap are already protected at bind time.
  expect(['bound', 'EADDRINUSE', 'EAFNOSUPPORT']).toContain(bind);
  for (let index = 0; index < 3; index += 1) {
    const result = await request(context.app).get('/api/agents/owned').expect(200);
    expect(result.body.name).toBe('owned');
    expect(context.app.address()).toEqual(address);
  }
  expect(competingRequests).toBe(0);
});

test('backend fixture cleanup closes its shared target and auxiliary listeners', async () => {
  context = await createBackendTestContext('fixture-listeners-');
  const target = context.app;
  const auxiliary = await context.listen();
  expect(target.listening).toBe(true);
  expect(auxiliary.server.listening).toBe(true);
  expect(auxiliary.server.address().port).not.toBe(target.address().port);
  context.cleanup(); context = null;
  expect(target.listening).toBe(false);
  expect(auxiliary.server.listening).toBe(false);
});
