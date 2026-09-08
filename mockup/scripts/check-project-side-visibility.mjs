#!/usr/bin/env node
// All API reads are controlled fixtures; this suite makes no live backend writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.BASE ?? 'http://127.0.0.1:13203');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const connected = { id: 'visibility.test', serverName: 'visibility.test', label: 'Connected without agent access',
  active: true, hasCredential: true, credentialKind: 'appservice', accessState: 'accepted',
  representative: { mxid: '@fleet_representative:visibility.test' }, projects: [] };
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
  : { channel: 'chrome', headless: true });
let passed = 0;
async function check(name, sides, checkPage, { failure = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), unexpected = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin || request.method() !== 'GET') { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/hafleet/', '');
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === 'project-sides') return failure ? reply({ error: 'fixture side service unavailable' }, 503) : reply({ sides });
    if (/^project-sides\/[^/]+\/budget$/.test(path)) return reply({ allocated: null, committed: 0, remaining: null });
    if (['agents', 'framework-presets', 'frameworks', 'alerts'].includes(path)) return reply([]);
    if (['engagements', 'offers', 'contributions', 'matrix/pending-invites', 'whitelist', 'frameworks/detect', 'usage', 'seats', 'capability'].includes(path)) return reply({});
    unexpected.push(path); return reply({ error: 'unexpected fixture route' }, 500);
  });
  try {
    await page.goto(new URL('/projects', base).href);
    await page.getByTestId('prov-live').waitFor();
    const section = page.locator('section[aria-labelledby="project-side-connections"]');
    await checkPage(page, section);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    passed += 1; console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
try {
  await check('accepted side is visible without invitations or agent bindings in both languages', [connected], async (page, section) => {
    await section.getByText(connected.label, { exact: true }).waitFor();
    await section.getByText('Credentials verified', { exact: true }).waitFor();
    const row = await section.locator('li').boundingBox();
    const content = await section.locator('li > div').boundingBox();
    assert.ok(content.width > row.width * 0.8, 'The connection must span the row, not the narrow step-number column');
    assert.ok((await section.innerText()).includes(connected.representative.mxid));
    assert.equal(await section.getByRole('link', { name: 'Manage connection and allocation' }).getAttribute('href'), '/engagements');
    await page.getByText('No invitation is waiting.', { exact: true }).waitFor();
    await page.getByText('No project holds access to one of my agents.', { exact: true }).waitFor();
    assert.ok((await section.innerText()).includes('Event delivery is verified by the server separately'));
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await section.getByText('凭据已验证', { exact: true }).waitFor();
    await section.getByRole('heading', { name: '已登记的项目方' }).waitFor();
  });
  await check('missing and inactive credentials cannot appear verified', [
    { ...connected, hasCredential: false },
    { ...connected, id: 'archived.test', label: 'Archived side', active: false },
  ], async (_page, section) => {
    await section.getByText('Credentials needed', { exact: true }).waitFor();
    await section.getByText('Inactive', { exact: true }).waitFor();
    assert.equal(await section.getByText('Credentials verified', { exact: true }).count(), 0);
  });
  await check('an empty registration list offers onboarding', [], async (_page, section) => {
    await section.getByText('No project side is registered yet. Start with “Take on a project side”.', { exact: true }).waitFor();
    assert.equal(await section.locator('li').count(), 0);
  });
  await check('a failed registration read stays unavailable rather than empty', [], async (_page, section) => {
    await section.getByText('The project-side record did not answer. This is not "registered with nobody" — it is unknown.', { exact: true }).waitFor();
    assert.equal(await section.getByText('No project side is registered yet. Start with “Take on a project side”.', { exact: true }).count(), 0);
  }, { failure: true });
} finally { await browser.close(); }
console.log(JSON.stringify({ suite: 'project-side visibility', passed, failed: 0 }));
