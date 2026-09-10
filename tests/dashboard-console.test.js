import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';
import { translate } from '../mockup/lib/i18n.js';

const configData = {
  agents: [{ name: 'local-worker', framework: 'codex', transport: null, activeNow: false }],
  presets: [], detected: [], provenance: { agents: 'live', presets: 'live' }, refresh: async () => {},
};

describe('Dashboard configuration entry points', () => {
  test('opens resource configuration and project request review through real links', async () => {
    const html = await renderDashboard('mockup/app/config/page.jsx', { data: configData });
    expect(html).toMatch(/href="\/resources\/new"/);
    expect(html).toContain(translate('en', 'cf.addPreset'));
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
    expect(html).toContain(translate(locale, 'cf.unusable'));
  });
});

describe('Dashboard offer publication wording', () => {
  test.each(['en', 'zh'])('does not describe a withheld offer as published (%s)', async (locale) => {
    const card = {
      key: 'implementer', role: { displayName: 'Implementer', defaultTier: 'medium' },
      able: [], unable: [], overTier: [], excluded: [], families: [], crossFamilyOk: true,
    };
    const data = {
      capability: () => [card], roleCapacity: { roles: {}, tiers: [], families: [] }, agents: [],
      offers: [{ role: 'implementer', published: false, count: null, budgetCapPerEngagement: null, rateCap: null }],
      provenance: { offers: 'live' }, refresh: async () => {},
    };
    const withheld = await renderDashboard('mockup/app/capability/page.jsx', { locale, data });
    expect(withheld).toContain(locale === 'en'
      ? 'not published; contribution limits are not set'
      : '尚未发布；贡献额度尚未设置');
    expect(withheld).not.toContain(locale === 'en'
      ? 'published with no limits set'
      : '已发布但未设任何上限');
    data.offers[0].published = true;
    const published = await renderDashboard('mockup/app/capability/page.jsx', { locale, data });
    expect(published).toContain(locale === 'en'
      ? 'published with no limits set'
      : '已发布但未设任何上限');
  });
});
