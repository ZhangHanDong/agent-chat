import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from './helpers/dashboard-render.js';

const mockup = fileURLToPath(new URL('../mockup/', import.meta.url));
const requireDashboard = createRequire(new URL('../mockup/package.json', import.meta.url));
const hookKey = '__hafleetDataRefreshTest';
let components;
let harness;
let cleanups;

beforeAll(async () => {
  // Run the real provider's load/effect closures. Hooks expose state and effect
  // cleanup to the test; timers, browser events and request completion stay real
  // observable inputs, with no copied refresh or generation implementation.
  const built = await build({
    stdin: {
      contents: `export {DataProvider} from './components/Data.jsx'; export {default as ConfigPage} from './app/config/page.jsx';`,
      resolveDir: mockup,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    alias: { '@': mockup }, external: ['react/*', 'next/link'],
    plugins: [{ name: 'provider-test-inputs', setup(b) {
      b.onResolve({ filter: /^(react|@\/components\/(Prefs|Data|Toast)|@\/lib\/api)$/ }, ({ path }) => ({ path, namespace: 'provider-input' }));
      b.onLoad({ filter: /.*/, namespace: 'provider-input' }, ({ path }) => ({
        contents: `const h = () => globalThis[${JSON.stringify(hookKey)}];\n` + (
          path === 'react' ? `
            export const createContext = value => ({Provider: 'provider', value});
            export const useContext = context => context.value;
            export const useRef = current => ({current});
            export const useState = initial => {
              h().state = typeof initial === 'function' ? initial() : initial;
              return [h().state, value => { h().state = typeof value === 'function' ? value(h().state) : value; h().updates += 1; }];
            };
            export const useEffect = effect => { h().effects.push(effect); };
          ` : path.endsWith('/Data') ? 'export const useData = () => h().configData; export const Provenance = () => null;'
            : path.endsWith('/Prefs') ? 'export const useT = () => key => key;'
              : path.endsWith('/Toast') ? 'export const useToast = () => [null, (...args) => h().notices.push(args)]; export const Toast = () => null;'
                : 'export const CONTRACT_SLICES = []; export const fetchLive = () => h().fetchLive(); export const send = (...args) => h().send(...args);'
        ),
      }));
    } }],
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireDashboard, compiled, compiled.exports);
  components = compiled.exports;
});

const payload = marker => ({ data: { marker }, provenance: { agents: 'live' }, errors: {} });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  const windowTarget = new EventTarget();
  windowTarget.location = { search: '' };
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'visible';
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  harness = {
    state: null, updates: 0, effects: [], notices: [],
    fetchLive: vi.fn().mockResolvedValue(payload('initial')),
    send: vi.fn().mockResolvedValue({ ok: true }),
    configData: { agents: [], detected: [], presets: [{ id: 'sample', name: 'sample preset' }], provenance: { presets: 'fixture' }, refresh: vi.fn() },
  };
  globalThis[hookKey] = harness;
  cleanups = [];
});

afterEach(() => {
  cleanups.forEach(cleanup => cleanup?.());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis[hookKey];
});

function mount() {
  components.DataProvider({ children: null });
  const cleanup = harness.effects[0]();
  cleanups.push(cleanup);
  return cleanup;
}

function visibility(state) {
  globalThis.document.visibilityState = state;
  globalThis.document.dispatchEvent(new Event('visibilitychange'));
}

describe('Dashboard refresh scheduling', () => {
  test('refreshes the visible provider every fifteen seconds', async () => {
    mount();
    await settle();
    expect(harness.fetchLive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14999);
    expect(harness.fetchLive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(harness.fetchLive).toHaveBeenCalledTimes(3);
  });

  test('skips hidden polling and refreshes immediately on visibility and focus', async () => {
    mount();
    await settle();
    visibility('hidden');
    globalThis.window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.fetchLive).toHaveBeenCalledTimes(1);
    visibility('visible');
    await settle();
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
    globalThis.window.dispatchEvent(new Event('focus'));
    await settle();
    expect(harness.fetchLive).toHaveBeenCalledTimes(3);
  });

  test('skips automatic refresh while a load is pending', async () => {
    const pending = deferred();
    harness.fetchLive.mockReturnValueOnce(pending.promise);
    mount();
    await vi.advanceTimersByTimeAsync(45000);
    globalThis.window.dispatchEvent(new Event('focus'));
    visibility('hidden');
    visibility('visible');
    expect(harness.fetchLive).toHaveBeenCalledTimes(1);
    pending.resolve(payload('finished'));
    await settle();
    await vi.advanceTimersByTimeAsync(15000);
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
  });

  test('explicit refresh supersedes a pending load without accepting its stale result', async () => {
    mount();
    await settle();
    const old = deferred();
    harness.fetchLive.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(15000);
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
    harness.fetchLive.mockResolvedValueOnce(payload('explicit'));
    await harness.state.refresh();
    expect(harness.fetchLive).toHaveBeenCalledTimes(3);
    expect(harness.state.marker).toBe('explicit');
    globalThis.window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(harness.fetchLive).toHaveBeenCalledTimes(3);
    old.resolve(payload('stale'));
    await settle();
    expect(harness.state.marker).toBe('explicit');
  });

  test('cleanup removes timers listeners and pending response updates', async () => {
    mount();
    await settle();
    const pending = deferred();
    harness.fetchLive.mockReturnValueOnce(pending.promise);
    globalThis.window.dispatchEvent(new Event('focus'));
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
    const updates = harness.updates;
    cleanups.pop()();
    pending.resolve(payload('late'));
    await vi.advanceTimersByTimeAsync(45000);
    globalThis.window.dispatchEvent(new Event('focus'));
    visibility('hidden');
    visibility('visible');
    await settle();
    expect(harness.fetchLive).toHaveBeenCalledTimes(2);
    expect(harness.updates).toBe(updates);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('preserves the fixture query across automatic refresh triggers', async () => {
    globalThis.window.location.search = '?data=fixture';
    mount();
    await vi.advanceTimersByTimeAsync(30000);
    globalThis.window.dispatchEvent(new Event('focus'));
    visibility('hidden');
    visibility('visible');
    await settle();
    expect(harness.fetchLive).not.toHaveBeenCalled();
    expect(harness.state.provenance.agents).toBe('fixture');
  });
});

describe('Dashboard unavailable preset deletion', () => {
  test('disables preset deletion without live provenance', async () => {
    for (const source of ['fixture', 'absent']) {
      const html = await renderDashboard('mockup/app/config/page.jsx', {
        data: { ...harness.configData, provenance: { presets: source } },
      });
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
    }
  });

  test('refuses unavailable preset delete callbacks without a request or success toast', async () => {
    function findDelete(node) {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'button' && node.props.children === 'act.delete') return node;
      for (const child of [node.props?.children].flat(Infinity)) {
        const found = findDelete(child);
        if (found) return found;
      }
      return null;
    }
    await findDelete(components.ConfigPage()).props.onClick();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  });
});
