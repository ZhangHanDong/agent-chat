#!/usr/bin/env node
// Run against a built local console: BASE=http://127.0.0.1:13203 node scripts/check-palpo-onboarding.mjs
// All API calls are intercepted; no credentials or writes reach a real backend.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.BASE ?? 'http://127.0.0.1:13203');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local console');
const fleetId = `hf_${'d'.repeat(32)}`, serverName = 'wizard.test';
const registration = {
  fleetId, serverName, credentialVersion: 1,
  registration: { id: fleetId, sender_localpart: `${fleetId}_representative`,
    url: 'http://callback.test:19094', as_token: 'browser-fixture-as', hs_token: 'browser-fixture-hs',
    namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:wizard\\.test$` }], rooms: [], aliases: [] } },
};
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
  : { channel: 'chrome', headless: true });
const results = [];

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const state = { writes: [], created: false, saveFails: false, verifyFails: false, accessState: 'accepted', unexpected: [] };
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin) { state.unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/hagency/', '');
    const method = request.method();
    if (method !== 'GET') state.writes.push({ path, method, body: request.postDataJSON() });
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === 'matrix/reach') return reply({ homeservers: state.created ? [{ serverName, url: 'http://matrix.test',
      alreadyASide: true, hasCredential: false, probe: { reachable: true, versions: ['v1.12'] } }] : [],
    appservice: { listening: true, inboundVia: 'socket', callbackCandidates: [] } });
    if (path === 'matrix/probe') return reply({ origin: 'http://matrix.test', via: 'manual', probe: { reachable: true, versions: ['v1.12'] } });
    if (path === 'matrix/callback-check') return reply({ applicable: false, reason: 'Remote test server' });
    if (path === 'project-sides' && method === 'POST') { state.created = true; return reply({ ok: true, side: { id: serverName } }); }
    if (path === `project-sides/${serverName}/credential`) return state.saveFails
      ? reply({ error: 'fixture save refused' }, 409) : reply({ ok: true });
    if (path === `project-sides/${serverName}/verify`) return state.verifyFails
      ? reply({ error: 'fixture verification unavailable' }, 503)
      : reply({ ok: true, side: { accessState: state.accessState } });
    // The shared navigation reads these independent slices even inside onboarding.
    if (method === 'GET' && ['agents', 'framework-presets', 'frameworks', 'alerts'].includes(path)) return reply([]);
    if (method === 'GET' && ['engagements', 'offers', 'project-sides', 'contributions', 'matrix/pending-invites',
      'whitelist', 'frameworks/detect', 'usage', 'seats', 'capability'].includes(path)) return reply({});
    state.unexpected.push(`${method} ${path}`); return reply({ error: 'unexpected test API' }, 500);
  });
  try {
    await page.goto(new URL('/projects/new', base).href);
    await page.locator('p.empty').waitFor();
    await page.locator('#draft-name').fill(serverName); await page.locator('#draft-url').fill('http://matrix.test');
    await page.getByRole('button', { name: '探测并加入', exact: true }).click();
    await page.locator('input[name=hs]:checked').waitFor();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.locator('#side-label').fill('Browser wizard fixture');
    await page.getByRole('button', { name: '建立', exact: true }).click();
    await page.locator('input[name=ck]').nth(1).check();
    await page.locator('#palpo-registration').waitFor();
    const upload = (value = registration) => page.locator('#palpo-registration').setInputFiles({
      name: 'registration.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    });
    await run({ page, state, upload });
    assert.deepEqual(errors, []); assert.deepEqual(state.unexpected, []);
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } finally { await context.close(); }
}

try {
  await scenario('four-step onboarding imports and verifies without leaving the wizard', async ({ page, state, upload }) => {
    assert.equal(await page.locator('#as-method').inputValue(), 'import');
    assert.equal(await page.locator('#callback-url').count(), 0);
    const writes = state.writes.length;
    await upload(); await page.getByLabel('授权配置预览').waitFor();
    assert.ok((await page.locator('body').innerText()).includes('已读取：registration.json'));
    assert.equal(state.writes.length, writes);
    assert.equal(await page.locator('#palpo-registration').inputValue(), '');
    const preview = await page.getByLabel('授权配置预览').innerText();
    assert.ok(preview.includes(`${fleetId}_representative`)); assert.ok(preview.includes('http://callback.test:19094'));
    for (const token of ['browser-fixture-as', 'browser-fixture-hs']) assert.ok(!preview.includes(token));
    await page.getByRole('button', { name: '保存并验证', exact: true }).click();
    await page.getByText('凭据验证通过', { exact: true }).waitFor();
    assert.equal(page.url(), new URL('/projects/new', base).href);
    assert.equal(await page.locator('#palpo-registration').count(), 0);
    assert.deepEqual(state.writes.slice(writes).map(r => [r.method, r.path]), [
      ['PUT', `project-sides/${serverName}/credential`], ['POST', `project-sides/${serverName}/verify`],
    ]);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    const body = await page.locator('body').innerText();
    for (const token of ['browser-fixture-as', 'browser-fixture-hs']) { assert.ok(!stored.includes(token)); assert.ok(!body.includes(token)); }
    assert.ok(body.includes('事件投递状态需要单独验证'));
  });
  await scenario('foreign and invalid replacement files cannot save stale authorization', async ({ page, state, upload }) => {
    const writes = state.writes.length;
    await upload({ ...registration, serverName: 'foreign.test' }); await page.locator('p[role=alert]').waitFor();
    assert.equal(await page.getByRole('button', { name: '保存并验证', exact: true }).isDisabled(), true);
    await upload(); await page.getByLabel('授权配置预览').waitFor();
    await upload('not-json'); await page.locator('p[role=alert]').waitFor();
    assert.equal(await page.getByLabel('授权配置预览').count(), 0);
    assert.equal(await page.getByRole('button', { name: '保存并验证', exact: true }).isDisabled(), true);
    assert.equal(state.writes.length, writes);
  });
  await scenario('failed saves stay editable and failed verification retries without another save', async ({ page, state, upload }) => {
    state.saveFails = true; await upload(); await page.getByLabel('授权配置预览').waitFor();
    await page.getByRole('button', { name: '保存并验证', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'fixture save refused' }).waitFor();
    assert.equal(state.writes.filter(r => r.path.endsWith('/verify')).length, 0);
    state.saveFails = false; state.verifyFails = true;
    await page.getByRole('button', { name: '保存并验证', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'fixture verification unavailable' }).waitFor();
    assert.equal(await page.getByText('凭据验证通过', { exact: true }).count(), 0);
    const saves = state.writes.filter(r => r.path.endsWith('/credential')).length;
    state.verifyFails = false;
    await page.getByRole('button', { name: '验证凭据', exact: true }).click();
    await page.getByText('凭据验证通过', { exact: true }).waitFor();
    assert.equal(state.writes.filter(r => r.path.endsWith('/credential')).length, saves);
  });
  await scenario('method changes discard imported secrets and preserve manual and token onboarding', async ({ page, state, upload }) => {
    await upload(); await page.getByLabel('授权配置预览').waitFor();
    await page.locator('#as-method').selectOption('generate');
    await page.locator('#callback-url').fill('http://manual.test:8095');
    assert.equal(await page.getByRole('button', { name: '生成', exact: true }).isEnabled(), true);
    await page.locator('#as-method').selectOption('import');
    assert.equal(await page.getByLabel('授权配置预览').count(), 0);
    assert.equal(await page.getByRole('button', { name: '保存并验证', exact: true }).isDisabled(), true);
    await page.locator('input[name=ck]').nth(0).check();
    await page.locator('#reg-token').fill('ordinary-registration-fixture');
    await page.getByRole('button', { name: '保存凭据', exact: true }).click();
    await page.getByText('凭据已保存。没有文件要装，homeserver 也不用重启。', { exact: true }).waitFor();
    assert.deepEqual(state.writes.at(-1).body, { credential: { kind: 'registrationToken', registrationToken: 'ordinary-registration-fixture' } });
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ suite: 'controlled Palpo onboarding browser checks', passed: results.length, failed: 0 }));
