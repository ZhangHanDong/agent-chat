import { execFile, spawn } from 'node:child_process';
// This guardian relies on POSIX process-group ownership. Refuse an unsupported
// host instead of treating direct-child termination as whole-tree cleanup.
if (process.platform === 'win32')
    throw new Error('runner guardian requires POSIX process-group support');
const executable = process.env.HAFLEET_GUARDIAN_EXECUTABLE?.trim() ?? '';
if (!executable)
    throw new Error('runner guardian executable is missing');
let parsedArgs;
try {
    parsedArgs = JSON.parse(process.env.HAFLEET_GUARDIAN_ARGS_JSON ?? '[]');
}
catch {
    throw new Error('runner guardian argv is invalid');
}
if (!Array.isArray(parsedArgs) || parsedArgs.some((value) => typeof value !== 'string')) {
    throw new Error('runner guardian argv must be a string array');
}
const args = parsedArgs;
const childEnv = { ...process.env };
delete childEnv.HAFLEET_GUARDIAN_EXECUTABLE;
delete childEnv.HAFLEET_GUARDIAN_ARGS_JSON;
delete childEnv.NODE_CHANNEL_FD;
delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
const runtime = spawn(executable, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
});
let terminating = false;
let killTimer = null;
let cleanupPoll = null;
let cleanupDeadline = null;
let checking = false;
let runtimeClosed = false;
let runtimeExitCode = 1;
function signalRuntime(signal) {
    if (!runtime.pid)
        return;
    try {
        // The group outlives its leader. In particular, signal it after a normal
        // runtime exit so background tools cannot keep writing after settlement.
        process.kill(-runtime.pid, signal);
    }
    catch (error) {
        if (error.code !== 'ESRCH') {
            process.stderr.write(`runner guardian could not signal runtime group: ${String(error)}\n`);
        }
    }
}
async function hasLiveGroupMembers() {
    if (!runtime.pid)
        return false;
    try {
        process.kill(-runtime.pid, 0);
    }
    catch (error) {
        if (error.code === 'ESRCH')
            return false;
        return true; // An unreadable group is not evidence of termination.
    }
    // An orphaned zombie may remain until the host's reaper runs. It cannot
    // execute or write, and must not hold a completed dispatch forever.
    return new Promise((resolve) => {
        execFile('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1_000 }, (error, stdout) => {
            if (error)
                return resolve(true);
            resolve(stdout.split('\n').some((line) => {
                const [group, state] = line.trim().split(/\s+/u);
                return Number(group) === runtime.pid && !state?.startsWith('Z');
            }));
        });
    });
}
async function finishWhenStopped() {
    if (checking || !runtimeClosed)
        return;
    checking = true;
    try {
        if (await hasLiveGroupMembers())
            return;
        if (killTimer)
            clearTimeout(killTimer);
        if (cleanupPoll)
            clearInterval(cleanupPoll);
        if (cleanupDeadline)
            clearTimeout(cleanupDeadline);
        const finish = () => {
            if (process.connected)
                process.disconnect?.();
            process.exit(runtimeExitCode);
        };
        if (process.connected && process.send)
            process.send({ type: 'cleanup_complete' }, finish);
        else
            finish();
    }
    finally {
        checking = false;
    }
}
function terminate() {
    if (terminating)
        return;
    terminating = true;
    signalRuntime('SIGTERM');
    killTimer = setTimeout(() => signalRuntime('SIGKILL'), 2_000);
    cleanupPoll = setInterval(() => { void finishWhenStopped(); }, 25);
    cleanupDeadline = setTimeout(() => {
        signalRuntime('SIGKILL');
        process.stderr.write(`runner cleanup could not be confirmed for process group ${runtime.pid}; workspace requires inspection\n`);
        // Reserved guardian status: the parent must quarantine, never release on this exit.
        process.exit(125);
    }, 5_000);
}
process.stdin.pipe(runtime.stdin);
runtime.stdout.pipe(process.stdout);
runtime.stderr.pipe(process.stderr);
runtime.once('spawn', () => {
    if (typeof process.send === 'function')
        process.send({ type: 'runtime_ready', pid: runtime.pid });
});
runtime.once('error', (error) => {
    process.stderr.write(`runner guardian failed to launch runtime: ${error.message}\n`);
});
runtime.stdin.on('error', () => { });
runtime.once('exit', (code) => {
    runtimeExitCode = code ?? 143;
    // Use exit, not close: descendants can inherit stdout and keep close pending.
    terminate();
});
runtime.once('close', (code) => {
    runtimeExitCode = code ?? (terminating ? 143 : 1);
    runtimeClosed = true;
    terminate();
    void finishWhenStopped();
});
process.on('disconnect', terminate);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
// IPC disconnect is authoritative, while the parent-pid check covers runtimes
// launched by a host that closes IPC incorrectly during a hard crash.
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
    if (process.ppid !== parentPid || process.ppid === 1)
        terminate();
}, 1_000);
parentCheck.unref?.();
