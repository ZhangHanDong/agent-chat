import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';
import * as fixture from '../mockup/lib/mock-data.js';
import { makeDerive } from '../mockup/lib/derive.js';
import { fetchLive } from '../mockup/lib/api.js';

const agent = {
  name: 'local-runner', framework: 'codex', tmux: null, transport: null,
  activeNow: false, idleDurationSec: 0, online: false, healthy: false, alive: false,
  offlineReason: 'tmux-missing:auto', state: 'offline',
  runner: { mode: 'on-demand', availability: 'ready', activity: 'idle', framework: 'codex' },
};
function data() {
  const values = { ...fixture, agents: [agent], presets: [], engagements: [], seats: [], contributions: [], usageLive: [] };
  return { ...values, ...makeDerive(values), provenance: { agents: 'live', presets: 'live', contributions: 'live', engagements: 'live' }, refresh: async () => {} };
}
describe('Dashboard on-demand roster', () => {
  test('resources show measured token consumption from the same live usage slice', async () => {
    const values = data();
    values.usageLive = [{ agent: agent.name, tokensDrawn: 984016, tokensUsed: 26900000 }];
    const html = await renderDashboard('mockup/app/resources/page.jsx', { data: values });
    expect(html).toContain('984k');
    expect(html).not.toContain('26.9M');
  });
  test.each(['resources', 'workforce', 'config'])('%s distinguishes ready runners from offline tmux sessions', async (route) => {
    const html = await renderDashboard(`mockup/app/${route}/page.jsx`, { data: data() });
    expect(html).toContain('Ready on demand');
    expect(html).toContain('On-demand runner');
    expect(html).not.toContain('codex · null');
    expect(html).not.toContain('tmux-missing:auto');
    expect(html).not.toContain('>offline<');
  });
});

afterEach(() => vi.unstubAllGlobals());
test('carries only the public runner projection through the API adapter', async () => {
  vi.stubGlobal('fetch', async (url) => ({ ok: true, text: async () => JSON.stringify(
    url === '/api/hafleet/agents' ? [{ name: 'local-runner', type: 'codex', runner: { ...agent.runner, privateToken: 'do-not-project' } }]
      : url === '/api/hafleet/framework-presets' || url === '/api/hafleet/frameworks' ? [] : {},
  ) }));
  const result = await fetchLive();
  expect(result.data.agents[0].runner).toEqual(expect.objectContaining(agent.runner));
  expect(JSON.stringify(result.data.agents[0])).not.toContain('do-not-project');
});
