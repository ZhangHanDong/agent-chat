import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, test } from 'vitest';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');
const HAGENCY_BIN = path.join(REPO_ROOT, 'bin', 'hagency');
const execFileAsync = promisify(execFile);

async function runCli(args, env = {}) {
  const { stdout } = await execFileAsync(HAGENCY_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
  return stdout;
}

describe('hagency status cli', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('shows unknown when backend runtime activity is unavailable', async () => {
    context = await createBackendTestContext('hagency-cli-status-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'codex',
          kind: 'agent',
          server: 'relay-west',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
      },
      agentRuntime: {
        alpha: {
          activeNow: null,
          activeDurationSec: 0,
          idleDurationSec: 0,
        },
      },
      groups: {},
    });
    const listener = await context.listen();

    try {
      const output = await runCli(['cli', 'status', 'alpha'], {
        HAGENCY_API: listener.baseUrl,
      });

      expect(output).toContain('state:       unknown');
      expect(output).toContain('active:      -');
      expect(output).toContain('idle:        -');
    } finally {
      await listener.close();
    }
  });
});
