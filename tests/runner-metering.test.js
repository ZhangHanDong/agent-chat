import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { meterAgent } from '../lib/metering/attribute.js';
import { meterFleet, resetMeteringCache } from '../lib/metering/reader.js';

const roots = [];
afterEach(() => { resetMeteringCache(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('discovers runner transcripts by managed workdir and preserves unknown and cache identity', async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-runner-metering-'));
  roots.push(homeDir);
  const agent = { name: 'worker', type: 'codex', workdir: '/managed/workdir', runner: { mode: 'on-demand' } };
  const searches = [];
  const row = await meterAgent({ agent, homeDir, readSessions: async function* (search) { searches.push(search); } });
  expect(searches).toHaveLength(1);
  expect(row).toMatchObject({ available: false, workspace: agent.workdir, reason: 'no transcripts found for this workspace yet' });
  expect((await meterFleet({ agents: [agent], homeDir })).cached).toBe(false);
  expect((await meterFleet({ agents: [agent], homeDir })).cached).toBe(true);
  expect((await meterFleet({ agents: [{ ...agent, workdir: '/managed/other' }], homeDir })).cached).toBe(false);
  const legacy = await meterAgent({ agent: { ...agent, runner: null }, homeDir, readSessions: async function* () { throw new Error('legacy workspace must not be inferred'); } });
  expect(legacy.reason).toContain('no workspace recorded');
});
