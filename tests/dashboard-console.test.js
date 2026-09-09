import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';

const configData = {
  agents: [{ name: 'local-worker', framework: 'codex', transport: null, activeNow: false }],
  presets: [], detected: [], provenance: { agents: 'live', presets: 'live' }, refresh: async () => {},
};

describe('Dashboard configuration entry points', () => {
  test('opens resource configuration and project request review through real links', async () => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { data: configData });
    expect(html).toMatch(/href="\/resources\/new"[^>]*>\+ Add preset<\/a>/);
    expect(html).toMatch(/href="\/engagements"[^>]*>Review requests →<\/a>/);
  });

  test('delegates lifecycle operations to agent detail instead of fake success buttons', async () => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { data: configData });
    expect(html).toMatch(/href="\/agents\/local-worker"[^>]*>Manage agent<\/a>/);
    expect(html).not.toMatch(/<button[^>]*>Stop<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Remove<\/button>/);
  });
});

describe('Dashboard host probe states', () => {
  test('routes legacy onboarding to resource allocation', async () => {
    await expect(renderDashboard('mockup/app/onboard/page.jsx')).rejects.toMatchObject({
      digest: 'NEXT_REDIRECT;replace;/resources;307;',
    });
  });
  test.each(['en', 'zh'])('names an unusable framework without leaking a dictionary key (%s)', async (locale) => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { locale, data: {
      ...configData,
      detected: [{ id: 'codex-acp', displayName: 'Codex ACP', state: 'unusable', transport: 'acp', setup: [] }],
      agents: [{ name: 'local-worker', framework: 'codex-acp', transport: 'acp' }],
    } });
    expect(html).not.toContain('ob.st.unusable');
    expect(html).not.toContain('badgeundefined');
    expect(html).toContain(locale === 'en' ? 'on PATH but not answering' : '在 PATH 上但无响应');
  });
});
