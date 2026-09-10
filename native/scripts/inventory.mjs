// Reproducible M0 source inventory. This records candidates, not parity completion.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const baseline = '5dbef22dc5ad4e0bb1a886538406ec91a5893f9b';
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline], {encoding:'utf8'}).trim().split('\n');
const roots = new Set(['backend-v2.js','bridge-matrix.js','server.js','mcp-server.js','push-relay.js','remote/mcp-server.js','remote/push-relay.js']);
const candidates = paths.filter(p => roots.has(p) || /^(?:remote\/)?bin\//.test(p) || /^(?:services|src|scripts)\/.*\.(?:m?js|sh)$/.test(p));
const owner = p => /bridge|appservice/.test(p) ? 'matrix-transport' : /mcp-server|task-maintenance|task-writer|progress/.test(p) ? 'native-helpers' : /backend|server\.js/.test(p) ? 'salvo-api' : p.startsWith('scripts/') ? 'build-or-runtime-audit' : 'native-cli-platform';
const entries = candidates.map(path => {
  const content = execFileSync('git', ['show', `${baseline}:${path}`], {encoding:'utf8',maxBuffer:8*1024*1024});
  return {path, sha256:createHash('sha256').update(content).digest('hex'), owner:owner(path), disposition: path.startsWith('scripts/') ? 'classify-build-vs-runtime' : 'replace-native',
    shell_dependencies:[...new Set(content.match(/\b(?:node|python3|tmux|curl|chmod|bash|zsh|powershell)\b/g) ?? [])].sort()};
});
const endpoints=[];
for (const path of paths.filter(p => /^(?:backend-v2\.js|server\.js|bridge-matrix\.js|lib\/.*\.js)$/.test(p))) {
  const source = execFileSync('git', ['show', `${baseline}:${path}`], {encoding:'utf8',maxBuffer:8*1024*1024});
  const pattern = /\b(?:app|router)\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`\n]+)\2/g;
  for (const match of source.matchAll(pattern)) endpoints.push({source:path,line:source.slice(0,match.index).split('\n').length,method:match[1].toUpperCase(),path:match[3],disposition:'port-with-current-authority',status:'not-ported'});
}
const manifest={baseline, status:'candidate inventory; dynamic dispatch and build/runtime helper classification still require review', entries, literal_http_routes:endpoints};
writeFileSync(new URL('../fixtures/legacy-inventory.json',import.meta.url), JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({baseline, candidates:entries.length,literal_routes:endpoints.length}));
