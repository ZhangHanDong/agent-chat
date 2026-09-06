import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('active spec selectors resolve to registered tests', () => {
  const raw = execFileSync(process.execPath, ['scripts/check-spec-bindings.js'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  const result = JSON.parse(raw);
  expect(result.count).toBeGreaterThan(150);
  expect(result.missing).toEqual([]);
}, 180_000);
