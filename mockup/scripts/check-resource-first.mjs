#!/usr/bin/env node
// Controlled browser fixtures: no real resource, Agent or approval is mutated.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.BASE ?? 'http://127.0.0.1:13203');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const resource = { id: 'resource-codex', name: 'Coding resource', framework: 'codex',
  model: 'gpt-5.6-sol', reasoning: 'high', ceiling: { tokens: 200000, period: 'monthly' } };
const agent = { name: 'allocated-coder', type: 'codex', kind: 'agent', online: true, presetId: resource.id };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
async function check(locale, mode, route = '/resources') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(locale => localStorage.setItem('hafleet.locale', locale), locale);
  const page = await context.newPage(), unexpected = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base.origin || req.method() !== 'GET') {
      unexpected.push(`${req.method()} ${url.pathname}`); return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const p = url.pathname.replace('/api/hafleet/', '');
    const reply = body => route.fulfill({ json: body });
    if (p === 'agents') return reply(mode === 'allocated' ? [agent] : []);
    if (p === 'framework-presets') return reply(mode === 'empty' ? [] : [resource]);
    if (['frameworks', 'alerts'].includes(p)) return reply([]);
    if (p === 'project-sides') return reply({ sides: [] });
    if (['engagements', 'offers', 'contributions', 'matrix/pending-invites', 'whitelist',
      'frameworks/detect', 'usage', 'seats', 'capability'].includes(p)) return reply({});
    unexpected.push(p); return route.fulfill({ status: 500, json: { error: 'unexpected fixture route' } });
  });
  try {
    await page.goto(new URL(route, base).href);
    await page.getByTestId('prov-live').waitFor();
    assert.equal(new URL(page.url()).pathname, '/resources');
    assert.equal(await page.locator('a[href="/onboard"]').count(), 0);
    assert.equal(await page.getByRole('link', { name: /Onboard|Add an agent|Create agent|接入 Agent|添加 Agent/i }).count(), 0);
    const section = page.locator('section[aria-labelledby="resource-configurations"]');
    await section.waitFor();
    assert.ok(await section.evaluate(node => {
      const roster = [...document.querySelectorAll('h2')].find(h => /^(Agent instances|Agent 实例)/.test(h.textContent));
      return roster && Boolean(node.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'Resource configuration precedes the Agent roster');
    const resourcesNav = page.locator('.rail a[href="/resources"]');
    assert.match(await resourcesNav.innerText(), new RegExp(`${mode === 'empty' ? 0 : 1} `));
    const configure = locale === 'zh' ? '配置 Resource' : 'Configure Resource';
    if (mode === 'empty') {
      await section.getByText(locale === 'zh' ? '还没有配置 Resource。' : 'No Resource configured yet.', { exact: true }).waitFor();
      await page.locator('main').getByRole('link', { name: configure, exact: true }).first().click();
      await page.waitForURL('**/resources/new');
      await page.getByRole('heading', { name: configure, exact: true }).waitFor();
    } else {
      assert.ok((await section.innerText()).includes(resource.name));
      if (mode === 'configured') {
        await section.getByText(locale === 'zh' ? '尚未分配 Agent' : 'No Agent allocated yet', { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: locale === 'zh' ? '查看申请 →' : 'Review requests →', exact: true }).getAttribute('href'), '/engagements');
        assert.equal(await page.locator('.rail .agent-row').count(), 0);
      } else {
        assert.equal(await page.locator('.rail .agent-row').getAttribute('href'), `/agents/${agent.name}`);
        assert.equal(await section.getByRole('link', { name: agent.name, exact: true }).getAttribute('href'), `/agents/${agent.name}`);
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    passed++; console.log(`PASS ${locale} ${mode} ${route}`);
  } finally { await context.close(); }
}
try {
  for (const locale of ['en', 'zh']) {
    for (const mode of ['empty', 'configured', 'allocated']) await check(locale, mode);
    await check(locale, 'configured', '/onboard');
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ suite: 'resource-first console', passed, failed: 0 }));
