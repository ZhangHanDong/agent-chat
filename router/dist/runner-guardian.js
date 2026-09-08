import { execFile, spawn } from 'node:child_process';
import { OwnedProcessTree, parseProcessSnapshot } from './owned-process-tree.js';
// The initial group establishes ownership; tools may create different groups.
// Track descendants while ancestry is observable, then retain their birth
// identities after exit/reparenting instead of confusing group exit with cleanup.
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
let ownership = null;
let ownershipPoll = null;
let inspection = null;
let inspectionFailed = false;
let escalating = false;
let runtimePaused = false;
const termSent = new Set();
const killSent = new Set();
function refreshOwnership() {
    if (inspection)
        return inspection;
    inspection = new Promise((resolve, reject) => {
        execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], {
            encoding: 'utf8', timeout: 1_000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, LC_ALL: 'C' },
        }, (error, stdout) => {
            if (error)
                return reject(error);
            try {
                resolve(parseProcessSnapshot(stdout));
            }
            catch (parseError) {
                reject(parseError);
            }
        });
    }).then((snapshot) => {
        ownership?.observe(snapshot);
        return snapshot;
    }).catch(() => {
        // A lost observation can hide a short-lived parent. A later clean process
        // group is insufficient to repair that missing ownership evidence.
        inspectionFailed = true;
        return null;
    }).finally(() => { inspection = null; });
    return inspection;
}
function signalOwned(snapshot, signal) {
    const sent = signal === 'SIGKILL' ? killSent : termSent;
    for (const member of ownership?.liveMembers(snapshot) ?? []) {
        const identity = `${member.pid}:${member.started}`;
        if (sent.has(identity))
            continue;
        try {
            process.kill(member.pid, signal);
            sent.add(identity);
        }
        catch (error) {
            if (error.code !== 'ESRCH') {
                inspectionFailed = true;
                process.stderr.write(`runner guardian could not signal an owned process: ${String(error)}\n`);
            }
        }
    }
    // Before the first observation, only the unreaped direct child is owned.
    if (!ownership?.rootObserved && runtime.exitCode === null && runtime.signalCode === null)
        runtime.kill(signal);
}
async function finishWhenStopped() {
    if (checking)
        return;
    checking = true;
    try {
        // An observation started before Stop is not the post-pause census.
        if (runtimePaused && inspection)
            await inspection;
        const snapshot = await refreshOwnership();
        if (!snapshot) {
            // The unreaped ChildProcess remains authoritative even if process-table
            // inspection failed. Other PIDs cannot be signalled without fresh identity.
            if (runtime.exitCode === null && runtime.signalCode === null) {
                runtime.kill(escalating ? 'SIGKILL' : 'SIGTERM');
                if (runtimePaused)
                    runtime.kill('SIGCONT');
            }
            runtimePaused = false;
            return;
        }
        const members = ownership?.liveMembers(snapshot) ?? [];
        if (members.length)
            signalOwned(snapshot, escalating ? 'SIGKILL' : 'SIGTERM');
        if (runtimePaused) {
            runtime.kill('SIGCONT');
            runtimePaused = false;
        }
        if (!runtimeClosed || members.length || inspectionFailed || !ownership?.rootObserved)
            return;
        if (killTimer)
            clearTimeout(killTimer);
        if (cleanupPoll)
            clearInterval(cleanupPoll);
        if (cleanupDeadline)
            clearTimeout(cleanupDeadline);
        if (ownershipPoll)
            clearInterval(ownershipPoll);
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
    // Keep the direct runtime from disappearing during the first Stop census.
    // This uses its unreaped ChildProcess ownership, never a user-supplied PID.
    if (runtime.exitCode === null && runtime.signalCode === null)
        runtimePaused = runtime.kill('SIGSTOP');
    // Observe before terminating any ancestor, while detached tools still have
    // an attributable parent. Continue discovering children during shutdown.
    void finishWhenStopped();
    killTimer = setTimeout(() => { escalating = true; void finishWhenStopped(); }, 2_000);
    cleanupPoll = setInterval(() => { void finishWhenStopped(); }, 25);
    cleanupDeadline = setTimeout(() => {
        void refreshOwnership().then((snapshot) => {
            if (snapshot)
                signalOwned(snapshot, 'SIGKILL');
            process.stderr.write('runner descendant cleanup could not be confirmed; workspace requires inspection\n');
            // Reserved guardian status: the parent must quarantine, never release on this exit.
            process.exit(125);
        });
    }, 5_000);
}
process.stdin.pipe(runtime.stdin);
runtime.stdout.pipe(process.stdout);
runtime.stderr.pipe(process.stderr);
runtime.once('spawn', () => {
    ownership = new OwnedProcessTree(runtime.pid, process.pid);
    ownershipPoll = setInterval(() => { void refreshOwnership(); }, 100);
    void refreshOwnership().then(() => {
        if (!ownership?.rootObserved) {
            inspectionFailed = true;
            terminate();
            return;
        }
        if (!terminating && typeof process.send === 'function')
            process.send({ type: 'runtime_ready', pid: runtime.pid });
    });
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
