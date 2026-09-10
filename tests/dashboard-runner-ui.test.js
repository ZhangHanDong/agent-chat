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
function data(current = agent) {
  const values = { ...fixture, agents: [current], presets: [], engagements: [], seats: [], contributions: [], usageLive: [] };
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

test('carries only public hybrid dispatch activity through the API adapter', async () => {
  const dispatchActivity = { source: 'router-ledger', activity: 'running', activeDispatchCount: 1,
    queuedDispatchCount: 0, parkedDispatchCount: 0 };
  vi.stubGlobal('fetch', async (url) => ({ ok: true, text: async () => JSON.stringify(
    url === '/api/hagency/agents' ? [{ name: 'hybrid', type: 'claude', transport: 'tmux', tmux: 'hybrid:0.0',
      runner: null, dispatchActivity: { ...dispatchActivity, privatePayload: 'do-not-project' } }]
      : url === '/api/hagency/framework-presets' || url === '/api/hagency/frameworks' ? [] : {},
  ) }));
  const result = await fetchLive();
  expect(result.data.agents[0]).toMatchObject({ runner: null, transport: 'tmux', tmux: 'hybrid:0.0', dispatchActivity });
  expect(JSON.stringify(result.data.agents[0])).not.toContain('do-not-project');
});

test.each(['resources', 'workforce', 'config'])('renders hybrid dispatch activity without hiding the terminal: %s', async (route) => {
  for (const [activity, label] of [['running', 'Active dispatch'], ['parked', 'Awaiting approval'],
    ['queued', 'Queued'], ['unknown', 'Dispatch activity unknown']]) {
    const hybrid = { ...agent, name: 'hybrid', framework: 'claude', runner: null, online: true,
      alive: true, healthy: true, state: 'online', tmux: 'hybrid:0.0', transport: 'tmux', idleDurationSec: 119745,
      dispatchActivity: { source: 'router-ledger', activity } };
    const html = await renderDashboard(`mockup/app/${route}/page.jsx`, { data: data(hybrid) });
    expect(html).toContain(label);
    expect(html).toContain('TMUX · hybrid:0.0');
    expect(html).not.toContain('IDLE 1d9h');
    expect(html).not.toContain('Ready on demand');
  }
});

afterEach(() => vi.unstubAllGlobals());
test('carries only the public runner projection through the API adapter', async () => {
  vi.stubGlobal('fetch', async (url) => ({ ok: true, text: async () => JSON.stringify(
    url === '/api/hagency/agents' ? [{ name: 'local-runner', type: 'codex', runner: { ...agent.runner, privateToken: 'do-not-project' } }]
      : url === '/api/hagency/framework-presets' || url === '/api/hagency/frameworks' ? [] : {},
  ) }));
  const result = await fetchLive();
  expect(result.data.agents[0].runner).toEqual(expect.objectContaining(agent.runner));
  expect(JSON.stringify(result.data.agents[0])).not.toContain('do-not-project');
});
