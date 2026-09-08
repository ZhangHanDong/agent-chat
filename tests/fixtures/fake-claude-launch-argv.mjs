#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const workdir = process.cwd();
writeFileSync(path.join(workdir, 'claude-launch-record.json'), JSON.stringify({
  argv: process.argv.slice(2),
  settings: JSON.parse(readFileSync(path.join(workdir, '.claude/settings.json'), 'utf8')),
  mcp: JSON.parse(readFileSync(path.join(workdir, '.mcp.json'), 'utf8')),
}), { mode: 0o600 });
await import('./fake-claude-runner.mjs');
