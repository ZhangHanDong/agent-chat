// Browser checks use local API fixtures exclusively; no real accounts or Agents are changed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { translate } from '../lib/i18n.js';

const base = new URL(process.env.BASE || 'http://127.0.0.1:13203');
assert.equal(base.hostname, '127.0.0.1');
const output = process.env.SHOTS;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
try {
  for (const locale of ['en', 'zh']) for (const width of [1440, 390]) {
    const t = (key, vars) => translate(locale, key, vars);
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(locale => localStorage.setItem('hagency.locale', locale), locale);
    const page = await context.newPage(), errors = [], unexpected = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    let usageUnavailable = false, agentsUnavailable = false, needsPreset = false;
    const bindings = [];
    const pool = { id: 'preset_internal_1234567890', name: 'Coding resource', framework: 'codex',
      model: 'gpt-5.6-sol', reasoning: 'medium', ceiling: { tokens: 100000 },
      catalogPublished: true, executionPolicy: { yolo: false } };
    const reason = 'opened 158 transcripts, none recorded workspace /private/agent-workdir';
    const side = { id: 'project.test', label: 'My project server', active: true, hasCredential: true,
      credentialKind: 'appservice', connectionMode: 'outbound', accessState: 'accepted',
      outboundEndpoint: 'https://project.test/api/fleet/v2/internal-id', namespace: '^@ac_debug_.*:project.test$',
      senderLocalpart: 'representative', projects: [] };
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === base.origin && req.method() === 'PUT' && url.pathname === '/api/hagency/agents/edison/preset') {
        bindings.push(req.postDataJSON());
        return route.fulfill({ status: 409, json: { error: 'Resource could not be attached' } });
      }
      if (url.origin !== base.origin || req.method() !== 'GET') {
        unexpected.push(`${req.method()} ${url.pathname}`); return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const p = url.pathname.replace('/api/hagency/', '');
      const reply = (json, status = 200) => route.fulfill({ json, status });
      if (p === 'agents') return agentsUnavailable ? reply({ error: 'Agent service offline' }, 503) : reply([
        { name: 'edison', type: 'codex', kind: 'agent', online: true, healthy: true, presetId: needsPreset ? null : pool.id },
      ]);
      if (p === 'framework-presets') return reply([pool]);
      if (p === 'usage') return usageUnavailable ? reply({ error: 'Timed out reading /private/usage-ledger' }, 503) : reply({
        agents: [{ agent: 'edison', framework: 'codex', model: pool.model, tokensUsed: null,
          tokensDrawn: null, tokensReason: reason, tasks: 0, busySec: 0 }],
      });
      if (p === 'project-sides') return reply({ sides: [side] });
      if (p === `project-sides/${side.id}/budget`) return reply({ allocated: 100000, committed: 0, remaining: 100000 });
      if (p === 'frameworks/detect') return reply({ frameworks: [{ id: 'codex', state: 'ready', credentialHome: '/private/provider-home' }] });
      if (p === 'seats') return reply({ keyed: false, seats: [{ seatId: 'seat_internal_1234567890',
        framework: 'codex', authMode: 'subscription', members: [{ agent: 'edison' }],
        declaredTokens: 100000, quotaTokens: null, membersWithoutCeiling: 0 }] });
      if (['frameworks', 'alerts'].includes(p)) return reply([]);
      if (['engagements', 'offers', 'contributions', 'matrix/pending-invites', 'whitelist', 'capability'].includes(p)) return reply({});
      unexpected.push(p); return reply({ error: 'Unexpected fixture read' }, 500);
    });
    const open = async path => {
      await page.goto(new URL(path, base).href);
      await page.getByTestId('prov-live').waitFor();
    };
    const hiddenDetail = async text => {
      const detailText = page.getByText(text, { exact: true });
      // Playwright checks native <details> visibility, not just the presence of HTML.
      assert.equal(await detailText.count(), 1, `Diagnostic must be retained: ${text}`);
      assert.equal(await detailText.isVisible(), false, `Diagnostic starts collapsed: ${text}`);
      const details = detailText.locator('xpath=ancestor::details[1]');
      await details.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await detailText.isVisible(), true, `Keyboard opens diagnostic: ${text}`);
      await details.locator(':scope > summary').click();
    };
    try {
      await open('/resources');
      await hiddenDetail(pool.id);
      await hiddenDetail('seat_internal_1234567890');
      await hiddenDetail(reason);
      assert.equal(await page.locator('.toast').count(), 0, 'No empty error notification');
      assert.equal((await page.locator('main').innerText()).includes('null ·'), false);
      assert.equal(await page.getByText(t('ui.usageUnavailable'), { exact: true }).isVisible(), true);
      assert.equal(await page.getByLabel('YOLO', { exact: true }).isVisible(), false);
      await page.getByText(t('exec.summaryApproval'), { exact: true }).click();
      assert.equal(await page.getByLabel('YOLO', { exact: true }).isVisible(), true);
      assert.equal(await page.getByLabel('YOLO', { exact: true }).isChecked(), false);
      await page.getByText(t('exec.summaryApproval'), { exact: true }).click();
      assert.equal(await page.getByRole('button', { name: t('rs.unpublishCatalog'), exact: true }).isVisible(), true);
      assert.equal(await page.getByText(t('rs.meterGap'), { exact: true }).isVisible(), true);
      if (output) await page.screenshot({ path: `${output}/resources-${locale}-${width}.png`, fullPage: true });

      await open('/engagements');
      await hiddenDetail(side.namespace);
      await hiddenDetail(side.outboundEndpoint);
      assert.equal(await page.getByText(side.label, { exact: true }).isVisible(), true);
      if (output) await page.screenshot({ path: `${output}/engagements-${locale}-${width}.png`, fullPage: true });
      await open('/projects');
      await hiddenDetail(`${t('en.repHead')}: @representative:project.test`);
      await open('/config');
      await hiddenDetail('/private/provider-home');
      await open('/usage');
      // Both usage tables retain the unavailable reason inside closed disclosures.
      const diagnostics = page.getByText(reason, { exact: true });
      assert.ok(await diagnostics.count() > 0);
      for (const item of await diagnostics.all()) assert.equal(await item.isVisible(), false);
      await open('/workforce');
      assert.doesNotMatch(await page.locator('main').innerText(), /ADR-013|PRD 6\.4|R13|R0[’']s/);

      needsPreset = true;
      await open('/resources');
      await page.locator('select').selectOption(pool.id);
      await page.getByRole('status').getByText('Resource could not be attached', { exact: true }).waitFor();
      assert.deepEqual(bindings, [{ presetId: pool.id }]);

      usageUnavailable = true; agentsUnavailable = true;
      await open('/resources');
      const banner = page.getByTestId('provenance');
      await page.getByTestId('prov-absent').waitFor();
      await page.getByTestId('prov-stale').waitFor();
      assert.match(await banner.innerText(), new RegExp(t('prov.slice.usage')));
      assert.match(await banner.innerText(), new RegExp(t('prov.slice.agents')));
      assert.equal((await banner.innerText()).includes('/private/usage-ledger'), false);
      await banner.locator('summary').click();
      assert.ok((await banner.innerText()).includes('/private/usage-ledger'));
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      passed++; console.log(`PASS ${locale} ${width}px: diagnostics, permissions, actions and data failures`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ passed, failed: 0 }));
