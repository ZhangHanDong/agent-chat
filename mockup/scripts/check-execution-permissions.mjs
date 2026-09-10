import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:13203';
assert.equal(new URL(base).hostname, '127.0.0.1');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const locale of ['en', 'zh']) {
    const presets = [{ id: 'pool', name: 'Test resource', framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', ceiling: { tokens: 100000 } }];
    const agent = { name: 'edison', kind: 'agent', type: 'codex', presetId: 'pool', executionPolicy: { yolo: false } };
    const grant = { id: `grant_${'a'.repeat(32)}`, active: true, scope: 'always', project: 'Physics', ownerMxid: '@owner:test',
      description: 'Network host: aapt.org\nProtocol: https' };
    const writes = [], errors = [], unexpected = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(locale => localStorage.setItem('hagency.locale', locale), locale);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await context.route('**/api/**', route => {
      const req = route.request(), p = new URL(req.url()).pathname.replace('/api/hagency/', '');
      const reply = json => route.fulfill({ json });
      if (req.method() !== 'GET') {
        writes.push({ method: req.method(), path: p, body: req.postDataJSON() });
        if (p === 'framework-presets/pool') { Object.assign(presets[0], req.postDataJSON()); return reply({ ok: true }); }
        if (p === 'agents/edison/execution-policy') { agent.executionPolicy = req.postDataJSON().executionPolicy; return reply({ ok: true }); }
        if (p === `agents/edison/execution-grants/${grant.id}` && req.method() === 'DELETE') { grant.active = false; return reply({ ok: true }); }
        if (p === 'framework-presets' && req.method() === 'POST') {
          const preset = { ...req.postDataJSON(), id: 'created' }; presets.push(preset); return reply({ ok: true, preset });
        }
        unexpected.push(`${req.method()} ${p}`); return route.abort();
      }
      if (p === 'framework-presets') return reply(presets);
      if (p === 'agents') return reply([agent, { name: 'claude-worker', kind: 'agent', type: 'claude' }]);
      if (p === 'agents/edison/execution-policy') return reply({ executionPolicy: agent.executionPolicy, grants: [grant] });
      if (p === 'agents/edison/pane') return reply({ lines: [] });
      if (p === 'agents/edison/tasks') return reply([]);
      if (p === 'agents/claude-worker/pane') return reply({ lines: [] });
      if (p === 'agents/claude-worker/tasks') return reply([]);
      if (p === 'engagements') return reply({ engagements: [] });
      if (p === 'project-sides') return reply({ sides: [] });
      if (['frameworks', 'alerts'].includes(p)) return reply([]);
      if (['capability', 'offers', 'contributions', 'matrix/pending-invites', 'whitelist', 'frameworks/detect', 'usage', 'seats'].includes(p)) return reply({});
      unexpected.push(p); return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
    });
    try {
      await page.goto(base + '/resources'); await page.getByTestId('prov-live').waitFor();
      await page.getByText(locale === 'zh' ? '新 Agent：保留沙箱 · 额外权限需审批' : 'New Agents: sandbox · approval for extra permissions', { exact: true }).click();
      const saveLabel = locale === 'zh' ? '保存执行权限' : 'Save execution permissions';
      assert.equal(await page.getByLabel('YOLO', { exact: true }).isChecked(), false);
      await page.getByLabel('YOLO', { exact: true }).check(); await page.getByRole('button', { name: saveLabel, exact: true }).click();
      await page.getByRole('status').filter({ hasText: locale === 'zh' ? '执行权限已保存' : 'Execution permissions saved' }).waitFor();
      assert.equal(presets[0].executionPolicy.yolo, true); assert.equal(agent.executionPolicy.yolo, false);
      await page.goto(base + '/agents/edison#runtime');
      const section = page.getByRole('region', { name: locale === 'zh' ? '执行权限' : 'Execution permissions', exact: true });
      await section.getByText(/Network host: aapt.org/).waitFor();
      for (const yolo of [true, false]) {
        await section.getByLabel('YOLO', { exact: true }).setChecked(yolo);
        await section.getByRole('button', { name: saveLabel, exact: true }).click();
        await section.getByRole('status').waitFor();
        await page.reload(); await section.getByText(/Network host: aapt.org/).waitFor();
        assert.equal(await section.getByLabel('YOLO', { exact: true }).isChecked(), yolo);
      }
      await section.getByRole('button', { name: locale === 'zh' ? '撤销规则' : 'Revoke rule', exact: true }).click();
      await section.getByText(locale === 'zh' ? /暂无有效规则/ : /No active saved rules/).waitFor();
      assert.equal(grant.active, false);
      await page.goto(base + '/resources/new');
      await page.locator('button.fw').filter({ has: page.locator('b', { hasText: /^codex$/ }) }).click();
      const next = () => page.getByRole('button', { name: locale === 'zh' ? '下一步' : 'Next', exact: true });
      await next().click();
      await page.locator('tbody tr').filter({ hasText: 'gpt-5.6-sol' }).first().getByRole('button').click();
      await next().click(); await next().click();
      assert.equal(await page.getByLabel('YOLO', { exact: true }).isChecked(), false);
      await page.getByLabel('YOLO', { exact: true }).check();
      await page.locator('.btn.primary').click();
      await page.waitForURL('**/resources');
      assert.equal(presets.find(p => p.id === 'created').executionPolicy.yolo, true);
      await page.goto(base + '/agents/claude-worker#runtime');
      await page.getByTestId('prov-live').waitFor();
      assert.equal(await page.getByRole('region', { name: locale === 'zh' ? '执行权限' : 'Execution permissions', exact: true }).count(), 0);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      assert.equal(writes.length, 5);
      console.log(`PASS ${locale}: new resource YOLO, existing resource future default, Agent save/reload, scoped rule revocation`);
    } catch (e) { console.error({ errors, unexpected, body: (await page.locator('body').innerText()).slice(-5000) }); throw e; }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
