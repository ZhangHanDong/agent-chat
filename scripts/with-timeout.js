#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [duration, command, ...args] = process.argv.slice(2);
const seconds = Number(duration);
if (!Number.isSafeInteger(seconds) || seconds <= 0 || !command) {
  console.error('usage: with-timeout.js <positive seconds> <command> [args]');
  process.exit(2);
}
const child = spawn(command, args, { stdio: 'inherit', detached: true });
let timedOut = false;
let escalation;
const signalGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const timeout = setTimeout(() => {
  timedOut = true;
  signalGroup('SIGTERM');
  escalation = setTimeout(() => signalGroup('SIGKILL'), 5000);
}, seconds * 1000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => signalGroup(signal));
child.once('error', (error) => { clearTimeout(timeout); console.error(error.message); process.exitCode = 127; });
child.once('exit', (code) => {
  clearTimeout(timeout);
  // The shell can exit before a descendant; preserve the timeout escalation.
  if (!timedOut) clearTimeout(escalation);
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
