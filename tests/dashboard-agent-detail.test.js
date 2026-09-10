import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';
import { translate } from '../mockup/lib/i18n.js';
import { hasLivePane, runtimeLabel, transportLabel } from '../mockup/lib/agent-detail.js';

const t = (key) => translate('en', key);
const data = (source = 'live') => ({
  provenance: { agents: source, presets: source, engagements: source },
  presetOf: () => null, tierOf: () => null, familyOf: () => null,
  remaining: () => null, committed: () => null,
  engagements: [], roleCapacity: { roles: {} },
});
const agent = {
  name: 'e2e-codex', framework: 'codex', environment: 'local', tmux: null,
  transport: null, workdir: '/real/agent/workdir', activeNow: false, online: false,
  runner: { mode: 'on-demand', availability: 'ready', activity: 'idle', model: null, modelSource: 'provider-default' },
};
const render = (exportName, a = agent, source = 'live') => renderDashboard(
  exportName === 'Header' ? 'mockup/components/AgentHeader.jsx' : 'mockup/components/AgentTabs.jsx',
  { exportName: exportName === 'Header' ? 'default' : exportName, props: { agent: a }, data: data(source) },
);

describe('Dashboard agent detail evidence', () => {
  test('renders hybrid dispatch activity without hiding the terminal', async () => {
    for (const [activity, key] of [['running', 'ag.runnerRunning'], ['parked', 'ag.runnerParked'],
      ['queued', 'ag.runnerQueued'], ['unknown', 'ag.runnerActivityUnknown']]) {
      const hybrid = { ...agent, name: 'hybrid', framework: 'claude', runner: null, online: true,
        tmux: 'hybrid:0.0', transport: 'tmux', idleDurationSec: 119745,
        dispatchActivity: { source: 'router-ledger', activity } };
      const header = await render('Header', hybrid);
      const runtime = await render('Runtime', hybrid);
      expect(header).toContain(t(key));
      expect(header).not.toContain('IDLE 1d9h');
      expect(header).toContain('TMUX · hybrid:0.0');
      expect(runtime).toContain(t(key));
      expect(runtime).toContain(t('ag.livePaneLoading'));
      expect(runtime).not.toContain(t('ag.headlessPaneNote'));
      expect(runtime).not.toContain(t('ag.runnerReady'));
      expect(hasLivePane(hybrid, 'live')).toBe(true);
    }
  });

  test('falls back to observed legacy state when hybrid dispatches are idle', () => {
    for (const dispatchActivity of [null, { source: 'router-ledger', activity: 'idle' }]) {
      const hybrid = { ...agent, runner: null, online: true, tmux: 'hybrid:0.0', transport: 'tmux',
        idleDurationSec: 119745, dispatchActivity };
      expect(runtimeLabel(hybrid, t)).toBe('IDLE 1d9h');
      expect(runtimeLabel({ ...hybrid, activeNow: true, activeDurationSec: 42 }, t)).toBe('ACTIVE 42s');
      expect(runtimeLabel({ ...hybrid, online: false, healthy: false }, t)).toBe('OFFLINE');
      expect(hasLivePane(hybrid, 'live')).toBe(true);
      expect(transportLabel(hybrid, t)).toBe('TMUX · hybrid:0.0');
    }
  });

  test('renders an explicit ready on-demand runner without a fabricated terminal', async () => {
    const html = await render('Header');
    expect(html).toContain(t('ag.onDemand'));
    expect(html).toContain(t('ag.runnerReady'));
    expect(html).not.toContain('TMUX · null');
    expect(html).not.toContain('<button');
    expect(html).not.toContain(t('ag.why.noPreset'));
  });

  test.each([
    ['running', 'ready', 'ag.runnerRunning'],
    ['queued', 'ready', 'ag.runnerQueued'],
    ['parked', 'ready', 'ag.runnerParked'],
    ['unknown', 'ready', 'ag.runnerActivityUnknown'],
    ['idle', 'unavailable', 'ag.runnerUnavailable'],
    ['idle', 'unknown', 'ag.runnerUnknown'],
  ])('renders runner activity and unknown runtime without guessing a process: %s %s', async (activity, availability, key) => {
    const html = await render('Header', { ...agent, runner: { ...agent.runner, activity, availability } });
    expect(html).toContain(t(key));
    expect(html).not.toContain('OFFLINE');
  });

  test('renders missing runtime mode as unknown', async () => {
    const html = await render('Header', { ...agent, runner: undefined, online: undefined });
    expect(html).toContain(t('ag.transportUnknown'));
    expect(html).toContain(t('ag.runtimeUnknown'));
    expect(html).not.toContain('TMUX');
  });

  test('renders a read-only profile without fabricated dates guidance or save controls', async () => {
    const html = await render('Profile');
    expect(html).toContain(t('ag.profileReadOnly'));
    expect(html).toContain(t('ag.notProvided'));
    expect(html).not.toContain('2026-08-02');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<button');
    expect(html).not.toContain(t('ag.guidanceText'));
  });

  test('retains a genuinely supplied profile creation value', async () => {
    const html = await render('Profile', { ...agent, createdAt: '2026-09-05T12:00:00Z' });
    expect(html).toContain('2026-09-05T12:00:00Z');
  });

  test('excludes sample activity for a live agent with the same fixture name', async () => {
    const html = await render('Activity', { ...agent, name: 'octos-agent' });
    expect(html).toContain(t('ag.activityUnavailable'));
    expect(html).not.toContain('check_inbox [completed]');
    expect(html).not.toContain('hagency acp-up');
  });

  test('labels offline activity samples at their point of use', async () => {
    const html = await render('Activity', { ...agent, name: 'octos-agent' }, 'fixture');
    expect(html).toContain(t('ag.fixtureActivity'));
    expect(html).toContain('check_inbox [completed]');
  });

  test('excludes fabricated live oversight assessments and decisions', async () => {
    const html = await render('Oversight', { ...agent, activeNow: true });
    expect(html).toContain(t('ag.oversightUnavailable'));
    expect(html).not.toContain(t('ag.healthy'));
    expect(html).not.toContain(t('ag.progressLine'));
    expect(html).not.toContain('42s');
    expect(html).not.toContain('<table');
  });

  test('labels offline oversight samples at their point of use', async () => {
    const html = await render('Oversight', agent, 'fixture');
    expect(html).toContain(t('ag.fixtureOversight'));
  });

  test('renders headless runtime with provider-default model and no pane polling panel', async () => {
    const html = await render('Runtime');
    expect(html).toContain(agent.workdir);
    expect(html).toContain(t('ag.providerDefault'));
    expect(html).toContain(t('ag.headlessPaneNote'));
    expect(html).not.toContain(t('ag.livePaneLoading'));
    expect(html).not.toContain(t('ag.noPaneAcp'));
    expect(html).not.toContain(t('ag.every15m'));
  });

  test('omits ineffective pause controls for a terminal agent', async () => {
    const terminal = { ...agent, runner: undefined, tmux: 'actual:0.1', transport: 'tmux' };
    const header = await render('Header', terminal);
    const runtime = await render('Runtime', terminal);
    expect(header).toContain('TMUX · actual:0.1');
    expect(header).not.toContain('<button');
    expect(runtime).toContain(t('ag.livePaneLoading'));
  });

  test('does not read a live pane for a fixture agent or unknown source', async () => {
    const terminal = { ...agent, runner: undefined, tmux: 'actual:0.1', transport: 'tmux' };
    for (const source of ['fixture', 'absent']) {
      const html = await render('Runtime', terminal, source);
      expect(html).not.toContain(t('ag.livePaneLoading'));
      expect(hasLivePane(terminal, source)).toBe(false);
    }
    expect(hasLivePane(terminal, 'live')).toBe(true);
    expect(hasLivePane(agent, 'live')).toBe(false);
    expect(hasLivePane({ ...terminal, tmux: '  ' }, 'live')).toBe(false);
  });

  test('does not replace an observed provider-default runtime with a later preset model', async () => {
    const html = await renderDashboard('mockup/components/AgentTabs.jsx', {
      exportName: 'Runtime',
      props: { agent: { ...agent, runner: undefined, runtimeProfile: { framework: 'codex', model: null } } },
      data: { ...data(), presetOf: () => ({ name: 'edited later', model: 'different-later-model' }) },
    });
    expect(html).toContain(t('ag.providerDefault'));
    expect(html).not.toContain('different-later-model');
  });

  test('does not replace on-demand model metadata with an unrelated preset model', async () => {
    const html = await renderDashboard('mockup/components/AgentTabs.jsx', {
      exportName: 'Runtime', props: { agent: { ...agent, runner: { ...agent.runner, model: 'declared-model' } } },
      data: { ...data(), presetOf: () => ({ name: 'other preset', model: 'other-model' }) },
    });
    expect(html).toContain('declared-model');
    expect(html).not.toContain('other-model');
  });

  test('keeps idle dispatch observation separate from runner readiness', async () => {
    const html = await render('Runtime');
    expect(html).toContain(t('ag.runnerReady'));
    expect(html).toContain(t('ag.runnerIdle'));
  });

  test('preserves explicit terminal and ACP observations without inventing elapsed time', () => {
    expect(transportLabel({ tmux: 'actual:0.1' }, t)).toBe('TMUX · actual:0.1');
    expect(transportLabel({ transport: 'acp' }, t)).toBe(t('ag.noPane'));
    expect(transportLabel({ transport: 'tmux', tmux: null }, t)).toBe(t('ag.transportUnknown'));
    expect(runtimeLabel({ online: false }, t)).toBe('OFFLINE');
    expect(runtimeLabel({ activeNow: true, online: true }, t)).toBe('ACTIVE');
    expect(runtimeLabel({ activeNow: false, online: true }, t)).toBe('IDLE');
    expect(runtimeLabel({ activeNow: false }, t)).toBe(t('ag.runtimeUnknown'));
    expect(runtimeLabel(null, t)).toBe(t('ag.runtimeUnknown'));
  });
});
