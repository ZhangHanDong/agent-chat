import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const repo = path.resolve('.');
let root, home, source;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'hagency-project-docs-'));
  home = path.join(root, 'homes');
  source = path.join(root, 'source with spaces');
  mkdirSync(source);
  writeFileSync(path.join(source, 'README.md'), 'original project');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script, args) {
  return execFileSync(process.execPath, [path.join(repo, 'scripts', script), ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HAGENCY_HOMEDIR: home },
  });
}
function provision(extra = [], name = 'docs-agent') {
  return JSON.parse(run('provision-v1-agent-home.js', ['--name', name, '--type', 'codex', '--home', home, ...extra]));
}
function document(payload) {
  return readFileSync(path.join(payload.paths.docsDir, 'projects.md'), 'utf8');
}
function mappings(payload) {
  const content = document(payload);
  const block = content.match(/```json\n([\s\S]*?)\n```/);
  expect(block, content).not.toBeNull();
  return JSON.parse(block[1]);
}

describe('provisioned project bootstrap documentation', () => {
  test('provisioned projects document copy and symlink edit paths', () => {
    for (const mode of ['copy', 'symlink']) {
      const payload = provision(['--project', source, '--project-mode', mode], `docs-${mode}`);
      const editPath = path.join(payload.paths.workdir, 'projects', path.basename(source));
      expect(mappings(payload)).toEqual([{ name: path.basename(source), workdirPath: `projects/${path.basename(source)}`,
        path: editPath, source: mode, originPath: source }]);
      expect(document(payload)).toContain('relative to `workdir/`');
      expect(document(payload)).toContain('symlink');
      expect(document(payload)).toContain('copy');
      expect(lstatSync(editPath).isSymbolicLink()).toBe(mode === 'symlink');
      writeFileSync(path.join(editPath, 'README.md'), mode);
      expect(readFileSync(path.join(source, 'README.md'), 'utf8')).toBe(mode === 'symlink' ? 'symlink' : 'original project');
    }
  });

  test('refreshes the legacy projects placeholder and reports no bound project', () => {
    const payload = provision();
    expect(mappings(payload)).toEqual([]);
    const file = path.join(payload.paths.docsDir, 'projects.md');
    writeFileSync(file, '# Projects\n\nTrack agent-owned project material under `../projects/`.\n');
    provision();
    expect(mappings(payload)).toEqual([]);
    expect(document(payload)).toContain('No managed project is bound');
    expect(document(payload)).not.toContain('../projects/');
  });

  test('preserves manual project notes while refreshing one managed block', () => {
    const payload = provision();
    const file = path.join(payload.paths.docsDir, 'projects.md');
    const manual = '# Project notes\n\nKeep the review checklist and deployment notes.\n';
    writeFileSync(file, manual);
    provision(['--project', source, '--project-mode', 'symlink']);
    provision();
    const after = document(payload);
    provision();
    expect(document(payload)).toBe(after);
    expect(after.startsWith(manual)).toBe(true);
    expect(after.match(/<!-- hagency-managed-projects:start -->/g)).toHaveLength(1);
    expect(mappings(payload)).toHaveLength(1);
    expect(mappings(payload)[0].originPath).toBe(source);
  });

  test('project add and remove keep bootstrap mappings current', () => {
    const payload = provision();
    run('hagency-project.js', ['add', 'docs-agent', source, '--mode', 'symlink']);
    expect(mappings(payload)).toHaveLength(1);
    run('hagency-project.js', ['remove', 'docs-agent', path.basename(source)]);
    expect(mappings(payload)).toEqual([]);
    expect(document(payload)).toContain('No managed project is bound');
    expect(existsSync(path.join(payload.paths.projectsDir, path.basename(source)))).toBe(false);
    expect(readFileSync(path.join(source, 'README.md'), 'utf8')).toBe('original project');
  });

  test('refuses incomplete mapping markers without overwriting manual content', () => {
    const payload = provision();
    const file = path.join(payload.paths.docsDir, 'projects.md');
    const content = '# My project notes\n<!-- hagency-managed-projects:start -->\nUnfinished edit\n';
    writeFileSync(file, content);
    expect(() => provision()).toThrow(/marker/);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });
});
