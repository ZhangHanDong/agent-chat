// UI contract test. Run against this checkout's Next production build; APIs are isolated fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../mockup/node_modules/playwright-core/index.mjs';

const origin = process.env.HAFLEET_TEST_CONSOLE ?? 'http://127.0.0.1:13212';
const fleetId = `hf_${'d'.repeat(32)}`, serverName = 'outbound.test';
const config = { fleetId, serverName, credentialVersion: 1, registration: {
  id: fleetId, sender_localpart: `${fleetId}_representative`, url: `http://relay:8090/api/relay/v2/${fleetId}`,
  as_token: 'private-browser-fixture-as', hs_token: 'private-browser-fixture-hs',
  namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:outbound\\.test$` }], rooms: [], aliases: [] },
}, transport: { mode: 'outbound', url: `https://outbound.test/api/fleet/v2/${fleetId}`, token: 'private-browser-fixture-machine', generation: 1 } };
const side = { id: serverName, serverName, label: 'Outbound browser fixture', active: true, apiBaseUrl: 'https://outbound.test',
  hasCredential: false, credentialKind: null, accessState: 'unverified', projects: [] };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [], writes = [], callbacks = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => globalThis.localStorage.setItem('hafleet.locale', 'zh'));
await page.route('**/api/hafleet/**', async route => {
  const request = route.request(), endpoint = new URL(request.url()).pathname.split('/api/hafleet/')[1];
  let body = { ok: true };
  if (endpoint === 'matrix/reach') body = { homeservers: [{ serverName, url: side.apiBaseUrl, source: 'fixture',
    alreadyASide: true, hasCredential: false, probe: { reachable: true, versions: ['v1.12'] } }],
  appservice: { listening: false, reason: 'No inbound port configured' } };
  else if (endpoint === 'matrix/callback-check') callbacks.push(endpoint);
  else if (endpoint === 'project-sides') body = { sides: [side] };
  else if (endpoint.endsWith('/budget')) body = { allocated: 1000, committed: 0, remaining: 1000 };
  else if (endpoint.endsWith('/credential') && request.method() === 'PUT') {
    const input = request.postDataJSON(); writes.push(input);
    Object.assign(side, { hasCredential: true, credentialKind: 'appservice', connectionMode: 'outbound',
      outboundEndpoint: config.transport.url, senderLocalpart: config.registration.sender_localpart });
    body = { side };
  } else if (endpoint.endsWith('/verify')) { side.accessState = 'accepted'; body = { side }; }
  else if (endpoint === 'agents') body = { agents: [] };
  else if (endpoint === 'engagements') body = { engagements: [], ceilings: {} };
  else if (endpoint === 'presets') body = { presets: [] };
  else if (endpoint === 'offers') body = { offers: [] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
const upload = { name: 'outbound.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) };
try {
  await page.goto(`${origin}/projects/new`);
  await page.locator('input[name=hs]').check();
  await page.getByRole('button', { name: '接着做（已建立，配置凭据）', exact: true }).click();
  await page.locator('input[name=ck]').nth(1).check();
  await page.locator('#palpo-registration').setInputFiles(upload);
  await page.getByText('纯出站 · HAFleet 主动连接 Palpo', { exact: true }).waitFor();
  assert.equal(await page.getByText('没有任何东西会接收入站事务。', { exact: true }).count(), 0);
  assert.equal(callbacks.length, 0, 'Import must not initiate a reverse callback check');
  await page.getByRole('button', { name: '保存并验证', exact: true }).click();
  await page.getByText('Palpo 授权配置已保存。', { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].credential.transport, config.transport);
  let visible = await page.locator('body').innerText();
  for (const token of [config.transport.token, config.registration.as_token, config.registration.hs_token]) assert.ok(!visible.includes(token));
  // The existing engagement import entry must keep the transport object intact,
  // never stringify it into a text input, and show its persisted connection mode.
  await page.goto(`${origin}/engagements`);
  await page.getByRole('button', { name: '替换', exact: true }).click();
  await page.locator('.cred-form input[type=file]').setInputFiles(upload);
  await page.locator('.cred-form').getByText(/纯出站连接/).waitFor();
  assert.equal(await page.locator('.cred-form input').evaluateAll(inputs => inputs.some(input => input.value === '[object Object]')), false);
  await page.locator('.cred-form').getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.cred-form').waitFor({ state: 'detached' });
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].credential.transport, config.transport);
  visible = await page.locator('body').innerText(); assert.ok(visible.includes('纯出站 · HAFleet 主动连接 Palpo'));
  for (const token of [config.transport.token, config.registration.as_token, config.registration.hs_token]) assert.ok(!visible.includes(token));
  assert.deepEqual(errors, []);
  const directory = process.env.HAFLEET_TEST_EVIDENCE ?? '/tmp/hafleet-outbound-ui'; await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/outbound-import.png`, fullPage: true });
  const result = { passed: true, realBackend: false, browser: 'headless Chromium', imports: writes.length,
    reverseCallbackChecks: callbacks.length, pageErrors: errors };
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
