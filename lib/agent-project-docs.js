import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const START = '<!-- hafleet-managed-projects:start -->';
const END = '<!-- hafleet-managed-projects:end -->';
const LEGACY = '# Projects\n\nTrack agent-owned project material under `../projects/`.';

/** Project bindings remain in agent.json; this is the bootstrap-readable projection. */
export function writeAgentProjectDocs(manifest) {
  const file = path.join(manifest.workdir, 'docs', 'projects.md');
  const projects = (manifest.managedProjects || []).map((project) => ({
    name: project.name,
    workdirPath: path.relative(manifest.workdir, project.path),
    path: project.path,
    source: project.source,
    originPath: project.originPath,
  }));
  const block = [
    START,
    '## Provisioned project mappings',
    '',
    'Project directories are under `projects/` relative to `workdir/`.',
    '`workdirPath` uses that base; `path` is the absolute directory to edit.',
    'For `source: "symlink"`, edits also change the repository at `originPath`.',
    'For `source: "copy"`, edits stay in the managed copy and do not propagate to `originPath`.',
    'These mappings are generated from the agent home manifest (`agent.json`). Keep manual notes outside this block.',
    ...(projects.length ? [] : ['', 'No managed project is bound.']),
    '',
    '```json',
    JSON.stringify(projects, null, 2),
    '```',
    END,
  ].join('\n');
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const start = previous.indexOf(START);
  const end = previous.indexOf(END);
  let content;
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start || previous.indexOf(START, start + START.length) !== -1
      || previous.indexOf(END, end + END.length) !== -1) {
      throw new Error(`invalid managed project markers in ${file}`);
    }
    content = previous.slice(0, start) + block + previous.slice(end + END.length);
  } else if (!previous.trim() || previous.trim() === LEGACY) {
    content = '# Projects\n\n' + block + '\n';
  } else {
    content = previous + (previous.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
  }
  if (content === previous) return 'unchanged';
  writeFileSync(file, content, 'utf8');
  return 'written';
}
