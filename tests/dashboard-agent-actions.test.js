import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from './helpers/dashboard-render.js';

const mockup = fileURLToPath(new URL('../mockup/', import.meta.url));
const requireDashboard = createRequire(new URL('../mockup/package.json', import.meta.url));
const hookKey = '__hafleetAgentActionsTest';
const agent = { name: 'claude-agent' };
let AgentActions;
let harness;

beforeAll(async () => {
  // Execute the actual component handlers with observable state, request and
  // navigation boundaries. No copy of deletion policy lives in this harness.
  const built = await build({
    entryPoints: [`${mockup}components/AgentActions.jsx`],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    alias: { '@': mockup }, external: ['react/*'],
    plugins: [{ name: 'agent-action-boundaries', setup(b) {
      b.onResolve({ filter: /^(react|next\/navigation|@\/components\/(Prefs|Data|Toast)|@\/lib\/api)$/ }, ({ path }) => ({ path, namespace: 'action-input' }));
      b.onLoad({ filter: /.*/, namespace: 'action-input' }, ({ path }) => ({
        contents: `const h = () => globalThis[${JSON.stringify(hookKey)}];\n` + (
          path === 'react' ? `
            export const useState = initial => {
              const index = h().cursor++;
              if (!(index in h().states)) h().states[index] = initial;
              return [h().states[index], value => { h().states[index] = typeof value === 'function' ? value(h().states[index]) : value; }];
            };
            export const useRef = initial => {
              const index = h().refCursor++;
              return h().refs[index] ??= {current: initial};
            };
          ` : path === 'next/navigation' ? 'export const useRouter = () => ({push: h().push});'
            : path.endsWith('/Data') ? 'export const useData = () => h().data;'
              : path.endsWith('/Prefs') ? 'export const useT = () => key => key;'
                : path.endsWith('/Toast') ? 'export const useToast = () => [null, (...args) => h().notices.push(args)]; export const Toast = () => null;'
                  : 'export const send = (...args) => h().send(...args);'
        ),
      }));
    } }],
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireDashboard, compiled, compiled.exports);
  AgentActions = compiled.exports.default;
});

beforeEach(() => {
  harness = {
    cursor: 0, refCursor: 0, states: ['remove', agent.name, false], refs: [], notices: [],
    data: { provenance: { agents: 'live' }, refresh: vi.fn().mockResolvedValue(undefined) },
    send: vi.fn().mockResolvedValue({ ok: true, body: { deleted: true } }), push: vi.fn(),
  };
  globalThis[hookKey] = harness;
});
afterEach(() => { delete globalThis[hookKey]; });

function render() {
  harness.cursor = 0;
  harness.refCursor = 0;
  return AgentActions({ agent });
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const remove = tree => find(tree, node => node.type === 'button' && node.props.children === 'ag.removePermanently');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('Dashboard agent deletion provenance and concurrency', () => {
  test('disables agent action entry points without a live record', async () => {
    for (const source of ['fixture', 'absent', undefined]) {
      const html = await renderDashboard('mockup/components/AgentActions.jsx', {
        props: { agent }, data: { provenance: { agents: source }, refresh: async () => {} },
      });
      const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
      expect(buttons).toHaveLength(2);
      expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
    }
  });

  test.each(['fixture', 'absent', undefined])('refuses deletion callbacks without live provenance: %s', async source => {
    harness.data.provenance.agents = source;
    const button = remove(render());
    await button.props.onClick();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
    expect(button.props.disabled).toBe(true);
  });

  test('refuses a previously captured callback after live provenance is lost', async () => {
    const callback = remove(render()).props.onClick;
    harness.data.provenance.agents = 'fixture';
    render();
    await callback();
    expect(harness.send).not.toHaveBeenCalled();
  });

  test('refuses deletion callbacks without the exact typed name', async () => {
    harness.states[1] = 'another-agent';
    await remove(render()).props.onClick();
    expect(harness.send).not.toHaveBeenCalled();
  });

  test('prevents duplicate submission until deletion and refresh finish', async () => {
    const request = deferred();
    const refresh = deferred();
    harness.send.mockReturnValue(request.promise);
    harness.data.refresh.mockReturnValue(refresh.promise);
    const callback = remove(render()).props.onClick;
    const first = callback();
    const duplicate = callback();
    const duringRequest = render();
    const disabledWhilePending = remove(duringRequest).props.disabled;
    request.resolve({ ok: true, body: { deleted: true } });
    await Promise.resolve();
    const duringRefresh = callback();
    refresh.resolve();
    await Promise.all([first, duplicate, duringRefresh]);
    expect(disabledWhilePending).toBe(true);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('agents/claude-agent?force=true', { method: 'DELETE' });
    expect(harness.data.refresh).toHaveBeenCalledTimes(1);
    expect(harness.push).toHaveBeenCalledTimes(1);
  });

  test('permits a fresh retry after a rejected delete without reporting success', async () => {
    harness.send.mockResolvedValueOnce({ ok: false, error: 'rejected' });
    await remove(render()).props.onClick();
    expect(harness.notices).toEqual([['fail', 'rejected']]);
    expect(harness.push).not.toHaveBeenCalled();
    const retry = remove(render());
    expect(retry.props.disabled).toBe(false);
    await retry.props.onClick();
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.push).toHaveBeenCalledTimes(1);
  });
});
