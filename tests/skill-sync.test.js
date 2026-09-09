import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let temp;
let checkout;
let testHome;
let fakeBin;
const source = path.resolve('bin/hafleet-sync-skills');
const clients = ['.claude', '.codex'];
const skillAt = (client) => path.join(testHome, client, 'skills', 'hafleet-inner-loop');

beforeEach(() => {
  temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'hafleet-skill-sync-')));
  checkout = path.join(temp, 'checkout with spaces');
  testHome = path.join(temp, 'test home');
  fakeBin = path.join(temp, 'fake-bin');
  for (const dir of ['bin', 'skills/hafleet', 'skills/hafleet-inner-loop/scripts']) mkdirSync(path.join(checkout, dir), { recursive: true });
  mkdirSync(fakeBin);
  copyFileSync(source, path.join(checkout, 'bin/hafleet-sync-skills'));
  writeFileSync(path.join(checkout, 'skills/hafleet/SKILL.md'), 'legacy template');
  writeFileSync(path.join(checkout, 'skills/hafleet-inner-loop/SKILL.md'), 'node scripts/monitor.mjs');
  writeFileSync(path.join(checkout, 'skills/hafleet-inner-loop/scripts/monitor.mjs'), 'console.log("resource available")');
  writeFileSync(path.join(fakeBin, 'date'), '#!/usr/bin/env bash\necho fixed\n', { mode: 0o755 });
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function sync(...args) {
  return execFileSync('bash', [path.join(checkout, 'bin/hafleet-sync-skills'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: testHome, PATH: `${fakeBin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('skill directory synchronization', () => {
  test('skill sync links complete inner-loop resources for Claude and Codex', () => {
    sync();
    for (const client of clients) {
      const skill = skillAt(client);
      expect(existsSync(path.join(skill, 'scripts/monitor.mjs'))).toBe(true);
      expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toContain('scripts/monitor.mjs');
      expect(realpathSync(skill)).toBe(path.join(checkout, 'skills/hafleet-inner-loop'));
      expect(realpathSync(path.join(testHome, client, 'skills/hafleet/SKILL.md'))).toBe(path.join(checkout, 'skills/hafleet/SKILL.md'));
      const output = execFileSync(process.execPath, [path.join(skill, 'scripts/monitor.mjs')], { encoding: 'utf8' });
      expect(output.trim()).toBe('resource available');
    }
    const before = clients.map((client) => lstatSync(skillAt(client)).mtimeMs);
    expect(sync('--check')).toContain('check passed');
    expect(clients.map((client) => lstatSync(skillAt(client)).mtimeMs)).toEqual(before);
  });

  test('skill sync preserves local content and existing backups', () => {
    for (const client of clients) {
      mkdirSync(skillAt(client), { recursive: true });
      writeFileSync(path.join(skillAt(client), 'local.txt'), 'first local skill');
      writeFileSync(`${skillAt(client)}.bak.fixed`, 'older backup');
    }
    sync();
    for (const client of clients) {
      expect(lstatSync(skillAt(client)).isSymbolicLink()).toBe(true);
      unlinkSync(skillAt(client));
      mkdirSync(skillAt(client));
      writeFileSync(path.join(skillAt(client), 'local.txt'), 'second local skill');
    }
    sync();
    for (const client of clients) {
      const parent = path.dirname(skillAt(client));
      const backups = readdirSync(parent).filter((name) => name.startsWith('hafleet-inner-loop.bak.'));
      expect(backups).toHaveLength(3);
      const contents = backups.map((name) => {
        const file = path.join(parent, name);
        return readFileSync(lstatSync(file).isDirectory() ? path.join(file, 'local.txt') : file, 'utf8');
      });
      expect(contents.sort()).toEqual(['first local skill', 'older backup', 'second local skill']);
    }
  });

  test('skill check refuses missing resources and wrong links without mutation', () => {
    // Existing legacy links alone must not pass the expanded check.
    for (const client of clients) {
      const legacy = path.join(testHome, client, 'skills/hafleet');
      mkdirSync(legacy, { recursive: true });
      symlinkSync(path.join(checkout, 'skills/hafleet/SKILL.md'), path.join(legacy, 'SKILL.md'));
    }
    expect(() => sync('--check')).toThrow();
    for (const client of clients) expect(existsSync(skillAt(client))).toBe(false);
    sync();
    unlinkSync(skillAt('.claude'));
    symlinkSync(path.join(checkout, 'skills/hafleet'), skillAt('.claude'));
    const wrong = readlinkSync(skillAt('.claude'));
    expect(() => sync('--check')).toThrow();
    expect(readlinkSync(skillAt('.claude'))).toBe(wrong);
    sync();
    rmSync(path.join(checkout, 'skills/hafleet-inner-loop/scripts/monitor.mjs'));
    const before = clients.map((client) => lstatSync(skillAt(client)).mtimeMs);
    expect(() => sync('--check')).toThrow();
    expect(clients.map((client) => lstatSync(skillAt(client)).mtimeMs)).toEqual(before);
  });
});
