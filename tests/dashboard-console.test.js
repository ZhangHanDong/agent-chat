import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';

const configData = {
  agents: [{ name: 'local-worker', framework: 'codex', transport: null, activeNow: false }],
  presets: [], detected: [], provenance: { agents: 'live', presets: 'live' }, refresh: async () => {},
};

describe('Dashboard configuration entry points', () => {
  test('opens the existing preset and onboarding forms through real links', async () => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { data: configData });
    expect(html).toMatch(/href="\/resources\/new"[^>]*>\+ Add preset<\/a>/);
    expect(html).toMatch(/href="\/onboard"[^>]*>\+ New agent<\/a>/);
  });

  test('delegates lifecycle operations to agent detail instead of fake success buttons', async () => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { data: configData });
    expect(html).toMatch(/href="\/agents\/local-worker"[^>]*>Manage agent<\/a>/);
    expect(html).not.toMatch(/<button[^>]*>Stop<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Remove<\/button>/);
  });
});

describe('Dashboard host probe states', () => {
  test('does not invent a scan timestamp when the probe supplied none', async () => {
    const html = await renderDashboard('mockup/app/onboard/page.jsx', { data: {
      detected: [], detectedAt: null, agents: [], presets: [], roleCapacity: { roles: {} }, refresh: async () => {},
    } });
    expect(html).not.toContain('scanned 9s ago');
    expect(html).toContain('Scan time not provided');
  });
  test.each(['en', 'zh'])('names an unusable framework without leaking a dictionary key (%s)', async (locale) => {
    const html = await renderDashboard('mockup/app/onboard/page.jsx', { locale, data: {
      detected: [{ id: 'codex-acp', displayName: 'Codex ACP', state: 'unusable', transport: 'acp', setup: [] }],
      agents: [], presets: [], provenance: {}, roleCapacity: { roles: {} }, refresh: async () => {},
    } });
    expect(html).not.toContain('ob.st.unusable');
    expect(html).not.toContain('badgeundefined');
    expect(html).toContain(locale === 'en' ? 'unusable' : '无法运行');
  });
});
