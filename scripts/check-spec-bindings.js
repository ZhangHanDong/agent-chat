#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function checkSpecBindings(inventory) {
  const names = inventory.map((entry) => entry.name);
  const missing = [];
  let count = 0;
  for (const file of readdirSync(path.join(root, 'specs')).filter((name) => name.endsWith('.spec.md'))) {
    const lines = readFileSync(path.join(root, 'specs', file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const selector = line.match(/^\s*(?:Test|Filter):\s*(\S.*?)\s*$/)?.[1];
      if (!selector) continue;
      count += 1;
      if (!names.some((name) => name.includes(selector))) missing.push({ file, line: index + 1, selector });
    }
  }
  return { count, missing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventoryFile = process.argv[2];
  const raw = inventoryFile ? readFileSync(inventoryFile, 'utf8') : execFileSync(process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--json'], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const result = checkSpecBindings(JSON.parse(raw));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.missing.length ? 1 : 0;
}
