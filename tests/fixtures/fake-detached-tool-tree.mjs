import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);

// Three real generations: runtime -> intermediate -> detached tool. The tool
// ignores TERM, closes inherited stdio, and is a new session/process-group leader.
// Finite fixture lifetimes and explicit test-finally cleanup prevent leaked probes.
export async function startDetachedToolTree(base) {
  const child = spawn(process.execPath, [filename, 'intermediate', base], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`tool fixture exited before readiness: ${code}`)));
  });
  child.disconnect();
  child.unref();
}

const [mode, base] = process.argv.slice(2);
if (mode === 'intermediate') {
  const runtimePid = process.ppid;
  const tool = spawn(process.execPath, [filename, 'tool', base], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  tool.once('message', () => {
    writeFileSync(`${base}.json`, JSON.stringify({ runtimePid, intermediatePid: process.pid, toolPid: tool.pid }));
    tool.disconnect(); tool.unref();
    process.send('ready');
    setInterval(() => { if (existsSync(`${base}.orphan`)) process.exit(0); }, 10);
  });
  setTimeout(() => process.exit(0), 15_000);
} else if (mode === 'tool') {
  process.on('SIGTERM', () => { writeFileSync(`${base}.term`, 'still alive'); });
  writeFileSync(`${base}.writing`, String(Date.now()));
  setInterval(() => { writeFileSync(`${base}.writing`, String(Date.now())); }, 20);
  setTimeout(() => { writeFileSync(`${base}.finished`, 'escaped cleanup'); process.exit(0); }, 15_000);
  process.send('ready');
}
