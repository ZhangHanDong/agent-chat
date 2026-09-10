import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';
import { translate } from '../mockup/lib/i18n.js';
import * as fixture from '../mockup/lib/mock-data.js';
import { makeDerive } from '../mockup/lib/derive.js';

describe.each(['en', 'zh'])('Console presentation (%s)', locale => {
  const t = (key, values) => translate(locale, key, values);

  test('data status keeps partial failures visible and diagnostics collapsed', async () => {
    const html = await renderDashboard('mockup/components/DataStatus.jsx', { locale, props: {
      slices: ['presets', 'usage', 'agents', 'capability', 'alerts'],
      provenance: { presets: 'live', usage: 'absent', agents: 'fixture', capability: 'derived', alerts: 'contract' },
      errors: { usage: 'Failed reading /private/transcripts: timeout' },
    } });
    const summary = html.slice(0, html.indexOf('<details'));
    expect(summary).toContain(t('ui.liveData'));
    expect(summary).toContain(t('prov.absent', { list: t('prov.slice.usage') }));
    expect(summary).toContain(t('prov.fixture', { list: t('prov.slice.agents') }));
    expect(summary).toContain(t('prov.derived', { list: t('prov.slice.capability') }));
    expect(summary).toContain(t('prov.contract', { list: t('prov.slice.alerts') }));
    expect(summary).not.toContain('/private/transcripts');
    expect(html).toContain('Failed reading /private/transcripts: timeout');
    expect(html).toContain(t('prov.live', { list: t('prov.slice.presets') }));
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  test('unavailable usage has a concise label and retains its diagnostic', async () => {
    const html = await renderDashboard('mockup/components/TechnicalDetails.jsx', {
      locale, exportName: 'UnavailableUsage', props: { reason: 'opened 158 transcripts, no matching workspace' },
    });
    expect(html).toContain(t('ui.usageUnavailable'));
    expect(html).not.toContain('class="amount"');
    expect(html.slice(0, html.indexOf('<details'))).not.toContain('158');
    expect(html).toContain('opened 158 transcripts, no matching workspace');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    const missing = await renderDashboard('mockup/components/TechnicalDetails.jsx', {
      locale, exportName: 'UnavailableUsage',
    });
    expect(missing).toContain(t('ui.usageUnavailable'));
    expect(missing).not.toContain('<details');
  });

  test('resource permissions remain explicit before opening the editor', async () => {
    for (const yolo of [true, false]) {
      const html = await renderDashboard('mockup/components/ExecutionPermissions.jsx', {
        locale, exportName: 'ResourceExecutionPermissions', props: {
          preset: { id: 'pool-exact-id', framework: 'codex', executionPolicy: { yolo } }, live: true,
        },
      });
      expect(html).toContain(`<summary>${t(yolo ? 'exec.summaryYolo' : 'exec.summaryApproval')}</summary>`);
      expect(html).toContain(t(yolo ? 'exec.yoloHelp' : 'exec.sandboxHelp'));
      expect(html).toContain(t('exec.futureAgents'));
      expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
      expect(html.includes('checked=""')).toBe(yolo);
    }
  });

  test('resource presentation has no empty error or null provider label', async () => {
    const data = { ...fixture, presets: fixture.presets.map(p => ({ ...p, provider: null })) };
    const html = await renderDashboard('mockup/app/resources/page.jsx', { locale, data: {
      ...data, ...makeDerive(data), provenance: { agents: 'live', presets: 'live' },
    } });
    expect(html).not.toContain('class="toast fail"');
    expect(html).not.toContain('null ·');
    expect(html).toContain(t('rs.meterGap'));
  });
});
