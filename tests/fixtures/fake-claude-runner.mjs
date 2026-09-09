#!/usr/bin/env node

if (process.env.FAKE_CLAUDE_PID_FILE) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
}

if (process.env.FAKE_CLAUDE_HANG === '1') {
  setInterval(() => undefined, 1_000);
} else

if (process.env.FAKE_CLAUDE_CLOSE_STDIN === '1') {
  process.stdin.destroy();
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    if (process.env.FAKE_CLAUDE_FAIL === '1') process.exit(17);
    if (process.env.FAKE_CLAUDE_RESULT_ERROR === '1') {
      process.stderr.write('SessionEnd hook failed: sentinel-hook-detail\n');
      process.stdout.write(`${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue. sentinel-result-secret",
      })}\n`);
      process.exit(Number(process.env.FAKE_CLAUDE_RESULT_ERROR_EXIT ?? '0'));
    }
    const sensitiveKeys = [
      'API_TOKEN', 'MATRIX_BRIDGE_SECRET', 'HAFLEET_DASHBOARD_TOKEN',
      'HAFLEET_SUBCONSCIOUS_EVENT_TOKEN', 'MATRIX_BOT_PASSWORD',
    ].filter((key) => process.env[key]);
    const result = process.env.FAKE_CLAUDE_REPORT_ENV === '1'
      ? `env:${sensitiveKeys.length === 0 ? 'clean' : sensitiveKeys.join(',')}`
      : `received:${input.includes('session-scoped context')}`;
    process.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`);
  });
}
