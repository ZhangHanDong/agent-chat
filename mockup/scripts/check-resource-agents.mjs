import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:13203';
assert.equal(new URL(base).hostname, '127.0.0.1');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
try {
  for (const locale of ['en', 'zh']) {
    const presets = ['Strong', 'Medium'].map((name, i) => ({ id: name.toLowerCase(), name: `${name} resource`, framework: 'codex',
      model: 'gpt-5.6-sol', reasoning: i ? 'medium' : 'high', ceiling: { tokens: 100000 }, agentDefinitions: [] }));
    const e = { id: 'request-second', project: 'Existing project', projectRoomId: '!project:test', role: 'coding',
      requester: '@owner:test', state: 'pending', agent: null, requestContext: { agentDefinition: { name: 'fast-two', resourceId: 'resource_aaaaaaaaaaaaaaaaaaaaaaaa' } }, requestedTokens: 1000, ratePerDay: 100, ownerBindingRequired: false };
    const verdicts = [], errors = [], unexpected = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(locale => localStorage.setItem('hagency.locale', locale), locale);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const p = url.pathname.replace('/api/hagency/', '');
      const reply = data => route.fulfill({ json: data });
      if (req.method() === 'PUT' && p === 'framework-presets/medium/catalog') {
        presets[1].catalogPublished = req.postDataJSON().published; return reply({ ok: true });
      }
      if (req.method() === 'POST' && p === `engagements/${e.id}/verdict`) {
        verdicts.push(req.postDataJSON()); e.state = 'active'; e.agent = 'project-fast-two';
        return reply({ ok: true, engagement: e });
      }
      if (req.method() !== 'GET') { unexpected.push(`${req.method()} ${p}`); return route.abort(); }
      if (p === 'framework-presets') return reply(presets);
      if (p === 'agents') return reply([{ name: 'original', kind: 'agent', type: 'codex', presetId: 'strong', runtimeProfile: { primary: { framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } } }]);
      if (p === 'engagements') return reply({ engagements: [e] });
      if (p === `engagements/${e.id}/candidates`) return reply({ locked: false, allocation: { kind: 'project-definition' }, candidates: [{
        choice: { kind: 'project-definition' }, name: 'fast-two', resource: 'Medium resource', model: 'gpt-5.6-sol', reasoning: 'medium', provision: true,
        remainingTokens: 100000, budget: { scope: 'resource', reserved: 0, pool: { ceiling: 100000, committed: 0, remaining: 100000 }, seat: { status: 'undeclared', quota: null, remaining: null } },
      }] });
      if (p === 'capability') return reply({ roles: [{ role: 'coding', displayName: 'Coding', defaultTier: 'medium', crossFamilyOk: true, able: [],
        resources: presets.map(p => ({ presetId: p.id, name: p.name, framework: p.framework, model: p.model, reasoning: p.reasoning })) }] });
      if (['frameworks', 'alerts'].includes(p)) return reply([]);
      if (p === 'project-sides') return reply({ sides: [] });
      if (['offers', 'contributions', 'matrix/pending-invites', 'whitelist', 'frameworks/detect', 'usage', 'seats'].includes(p)) return reply({});
      unexpected.push(p); return route.fulfill({ status: 500, json: { error: 'unexpected route' } });
    });
    try {
      await page.goto(base + '/resources'); await page.getByTestId('prov-live').waitFor();
      const medium = page.getByTestId('resource-agents-medium');
      assert.equal(await page.getByRole('button', { name: locale === 'zh' ? '定义 Agent' : 'Define Agent', exact: true }).count(), 0);
      assert.equal(await page.getByTestId('resource-agents-strong').count(), 1);
      await medium.getByRole('button', { name: locale === 'zh' ? '发布资源到 Palpo' : 'Publish resource in Palpo', exact: true }).click();
      await medium.getByRole('button', { name: locale === 'zh' ? '从目录撤下资源' : 'Withdraw resource from catalog', exact: true }).waitFor();
      assert.equal(presets[1].catalogPublished, true);
      await page.goto(base + '/engagements'); await page.getByTestId('prov-live').waitFor();
      await page.getByRole('button', { name: locale === 'zh' ? '批准' : 'Approve', exact: true }).click();
      const definition = page.getByTestId('project-agent-definition');
      await definition.getByText(/Medium resource.*medium/).waitFor();
      assert.match(await definition.innerText(), /fast-two/);
      assert.match(await page.getByTestId('selected-pool-budget').innerText(), /100k/);
      await definition.getByText(locale === 'zh' ? '本 Agent 使用所选 pool 的额度，不占用旧的项目方总限额。'
        : 'This Agent draws from the selected pool. It does not consume the legacy project-side allocation.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel(locale === 'zh' ? '分配哪个 Agent' : 'Agent to allocate', { exact: true }).count(), 0);
      const form = definition.locator('xpath=ancestor::form');
      await form.locator('button[type=submit]').click();
      await definition.waitFor({ state: 'hidden' });
      assert.equal(verdicts.length, 1); assert.deepEqual(verdicts[0].allocation, { kind: 'project-definition' });
      assert.equal(verdicts[0].allocatedTokens, 1000);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      passed++; console.log(`PASS ${locale}: provider resource publication and approval of the Palpo-defined Agent, no local definition form`);
    } catch (error) { console.error((await page.locator('body').innerText()).slice(-5000)); console.error({ errors, unexpected }); throw error; } finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ passed, failed: 0 }));
