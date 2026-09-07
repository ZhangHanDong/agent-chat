import { describe, expect, test } from 'vitest';
import { renderDashboard } from './helpers/dashboard-render.js';

// Execute the actual page, charts and dictionary through the shared renderer;
// there are no backend requests, chart stubs or copied aggregation functions.
const renderUsage = (data) => renderDashboard('mockup/app/usage/page.jsx', { data });

function agentUsage(agent, tasks, done) {
  return { agent, framework: 'codex', model: 'test-model', tasks, tasksByStatus: { done }, busySec: 0, ceilingTokens: null, tokensUsed: null };
}

function data(overrides = {}) {
  return {
    usage: [],
    usageLive: [agentUsage('e2e-claude', 2, 1), agentUsage('e2e-codex', 1, 1)],
    engagements: [],
    agents: [],
    roleCapacity: { roles: {} },
    presetOf: () => null,
    committed: () => 0,
    remaining: () => null,
    overBy: () => 0,
    ...overrides,
  };
}

function textOnly(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

function taskRows(html) {
  return [...html.matchAll(/<div class="tb-row">([\s\S]*?)(?=<div class="tb-row">|<\/div><\/div><div class="panel">)/g)]
    .map((match) => {
      const label = match[1].match(/<span class="cb-label">([^<]*)<\/span>/)?.[1];
      const counts = [...match[1].matchAll(/<b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
      return { label, done: counts[0], open: counts[1] };
    });
}

function cardValue(html, label) {
  return html.match(new RegExp(`<div class="cap">${label}</div><div class="val">([^<]*)</div>`))?.[1];
}

function projectSection(html) {
  return html.split('<h2 class="sec">By project')[1]?.split('<h2 class="sec">By agent')[0] ?? '';
}

describe('dashboard usage consistency', () => {
  test('renders live agent task counts in the chart and summary', async () => {
    const html = await renderUsage(data());
    expect(textOnly(html)).toContain('1 done · 1 open');
    expect(textOnly(html)).toContain('1 done · 0 open');
    expect(cardValue(html, 'Tasks done')).toBe('2');
    expect(taskRows(html)).toEqual([
      { label: 'e2e-claude', done: 1, open: 1 },
      { label: 'e2e-codex', done: 1, open: 0 },
    ]);
    expect(html).not.toContain('No task activity yet.');
  });

  test('does not duplicate live tasks across projects or legacy usage rows', async () => {
    const html = await renderUsage(data({
      usageLive: [agentUsage('e2e-claude', 2, 1)],
      engagements: [
        { id: 'one', agent: 'e2e-claude', project: 'project-one', state: 'active', allocatedTokens: 1000 },
        { id: 'two', agent: 'e2e-claude', project: 'project-two', state: 'active', allocatedTokens: 1000 },
      ],
      usage: [
        { engagementId: 'one', agent: 'e2e-claude', project: 'project-one', tasksDone: 99, tasksOpen: 99, tokensUsed: null },
        { engagementId: 'two', agent: 'e2e-claude', project: 'project-two', tasksDone: 99, tasksOpen: 99, tokensUsed: null },
      ],
    }));
    expect(taskRows(html)).toEqual([{ label: 'e2e-claude', done: 1, open: 1 }]);
    expect(cardValue(html, 'Tasks done')).toBe('1');
  });

  test('explains missing project attribution without inventing rows', async () => {
    const html = await renderUsage(data({ engagements: [
      { id: 'one', agent: 'e2e-claude', project: 'project-one', state: 'active', allocatedTokens: 1000 },
    ] }));
    const section = projectSection(html);
    expect(textOnly(section)).toContain('Task counts are available per agent. Usage is not attributed to projects, so project task and token totals are unknown.');
    expect(section).not.toContain('<table');
    expect(section).not.toContain('project-one');
  });

  test('excludes ended and pending engagements from the allocation donut', async () => {
    const html = await renderUsage(data({ engagements: [
      { id: 'active', project: 'project-current', state: 'active', allocatedTokens: 1000 },
      { id: 'ended', project: 'project-ended', state: 'ended', allocatedTokens: 50000 },
      { id: 'pending', project: 'project-pending', state: 'pending', allocatedTokens: 9000 },
    ] }));
    expect(cardValue(html, 'Committed to projects')).toBe('1k');
    expect(html).toContain('class="donut-total">1k</text>');
    expect(html).toContain('project-current');
    expect(html).not.toContain('project-ended');
    expect(html).not.toContain('project-pending');
  });

  test('renders no allocation when only ended engagements remain', async () => {
    const html = await renderUsage(data({ engagements: [
      { id: 'ended', project: 'project-ended', state: 'ended', allocatedTokens: 50000 },
    ] }));
    expect(cardValue(html, 'Committed to projects')).toBe('0');
    expect(html).toContain('Nothing allocated yet.');
    expect(html).not.toContain('class="donut-total"');
  });

  test('renders zero task counts for an observed agent without activity', async () => {
    const html = await renderUsage(data({ usageLive: [agentUsage('idle-agent', 0, 0)] }));
    expect(taskRows(html)).toEqual([{ label: 'idle-agent', done: 0, open: 0 }]);
    expect(cardValue(html, 'Tasks done')).toBe('0');
  });
});
