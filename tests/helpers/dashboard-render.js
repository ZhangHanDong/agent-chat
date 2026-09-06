import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mockup = path.join(root, 'mockup');
const requireDashboard = createRequire(path.join(mockup, 'package.json'));

/** Render real Dashboard JSX against bounded API data, without a browser or live server. */
export async function renderDashboard(componentPath, { data = {}, props = {}, locale = 'en', exportName = 'default' } = {}) {
  const key = `dashboard-test-${randomUUID()}`;
  const result = await build({
    entryPoints: [path.resolve(root, componentPath)], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'dashboard-test-context', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path: name }) => ({ path: requireDashboard.resolve(name), external: true }));
      b.onResolve({ filter: /^next\/(link|navigation)$/ }, ({ path: name }) => ({ path: name, namespace: 'test-context' }));
      b.onResolve({ filter: /^@\/components\/(Data|Prefs)$/ }, ({ path: name }) => ({ path: name, namespace: 'test-context' }));
      b.onResolve({ filter: /^@\// }, ({ path: name }) => {
        const base = path.join(mockup, name.slice(2));
        return { path: [base, `${base}.js`, `${base}.jsx`].find(existsSync) ?? base };
      });
      b.onResolve({ filter: /^\//, namespace: 'test-context' }, ({ path: name }) => ({ path: name, namespace: 'file' }));
      b.onLoad({ filter: /.*/, namespace: 'test-context' }, ({ path: name }) => ({ loader: 'jsx', contents:
        name === 'next/link' ? 'export default function Link({children, ...props}) { return <a {...props}>{children}</a>; }'
        : name === 'next/navigation' ? 'export function useRouter(){return {push(){},replace(){},refresh(){}};}'
        : name.endsWith('/Data') ? `export function useData(){return globalThis[${JSON.stringify(key)}]}; export function Provenance(){return null;}`
        : `import {translate} from ${JSON.stringify(path.join(mockup, 'lib/i18n.js'))}; export function useT(){return (key,values)=>translate(${JSON.stringify(locale)},key,values)};`,
      }));
    }}],
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(requireDashboard, compiled, compiled.exports);
  globalThis[key] = data;
  try {
    const React = requireDashboard('react');
    const { renderToStaticMarkup } = requireDashboard('react-dom/server');
    return renderToStaticMarkup(React.createElement(compiled.exports[exportName], props));
  } finally {
    delete globalThis[key];
  }
}
