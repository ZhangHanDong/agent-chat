#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const args = process.argv.slice(2);
const reportersOnly = args.every(arg => /^--(?:reporter|outputFile)(?:[.=])/.test(arg));
const run = (options) => {
  const result = spawnSync(process.execPath, [vitest, ...options], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Vitest terminated by ${result.signal}`);
  return result.status ?? 1;
};

if (!reportersOnly) {
  // Preserve existing focused CLI selectors, flags and reporter behavior.
  process.exitCode = run(['run', '--no-file-parallelism', '--maxWorkers=1', ...args]);
} else {
  // Cache-busting backend fixtures retain module graphs for the lifetime of the
  // process (docs/TESTING.md). Recycle that process between deterministic shards
  // without increasing the 4 GiB ceiling, skipping tests, or retrying failures.
  const reports = mkdtempSync(path.join(os.tmpdir(), 'hagency-suite-reports-'));
  let failed = false;
  try {
    for (let shard = 1; shard <= 4; shard += 1) {
      const blob = path.join(reports, `shard-${shard}.json`);
      console.log(`Hagency full suite: shard ${shard}/4`);
      const status = run(['run', '--no-file-parallelism', '--maxWorkers=1', `--shard=${shard}/4`,
        '--reporter=default', '--reporter=blob', `--outputFile.blob=${blob}`]);
      if (status !== 0 || !existsSync(blob)) failed = true;
    }
    // Use Vitest's own merge so durations, failures, skips and unhandled errors
    // retain their original verdicts. A missing/crashed shard still fails above.
    const merged = run([`--merge-reports=${reports}`, ...args]);
    process.exitCode = failed || merged !== 0 ? 1 : 0;
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}
