---
kind: decision
id: ADR-029
title: Establish native process scope before execution and report its actual guarantee
status: Accepted
---

Implements the early platform proof required by REQ-RUST-MIGRATION-EXECUTION and
the M1/M4 migration gates. The initial platform crate remains separate from actual
Agent dispatch; it does not establish sandbox or full runtime parity.

Windows uses a non-inheritable, unnamed Job Object with kill-on-close and no
breakaway permission. `PROC_THREAD_ATTRIBUTE_JOB_LIST` associates the job during
`CreateProcessW`, before child code executes. This avoids the suspended-but-not-yet-
assigned crash window in the traditional three-call approach. See Microsoft's
[process-in-job explanation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)
and [Job Object documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
Only retained handles authorize cancellation. Whole-tree stop requires the job's
active process count to reach zero and its retained leader handle to signal exit.

POSIX uses Rust's [process_group](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#method.process_group)
before exec. The host exclusively owns the child reaper; it must not install an
automatic SIGCHLD reaper or let another waitpid consumer reap this child. Keep the
leader unreaped until the final group/child signals, then reap it without sending
more signals by its numeric ID. This protects the group's identity from reuse.
Group cancellation alone never reports full descendant cleanup. Detached children
and owner-death guardians remain mandatory work before real POSIX Agent execution.
Requests requiring crash containment currently fail before POSIX spawn.

Launch configuration is host-only, explicit and bounded: absolute executable/cwd,
argument array, allowlisted environment, null/inactive console IO. There is no
runtime PID-to-authority conversion, shell wrapper or implicit environment copy.
The Windows FFI boundary owns buffers and handles, and retains the job handle array
until process creation finishes. Windows argv uses standard CRT quote/backslash
encoding; raw command-line parsing is not an Agent-facing API.

A Job Object is not filesystem/network sandboxing. Neither successful process
creation nor a leader exit completes a canonical task. Future runner integration
must separately prove current dispatch permission, actual sandbox policy, full
descendant handling, bounded stdio and recovery ownership.

Child signal identity is a separate primitive. `OwnedChildIdentity::capture`
requires a host-owned `Child`, and there is no public numeric-PID constructor.
Read-only `(pid, birth)` metadata can narrow an existing handle's target but cannot
construct or retarget authority. The host must continue to exclusively own reaping.

Linux uses [pidfd signalling](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)
through a retained descriptor. Windows duplicates the Child's existing process
handle; [process handles remain valid until closed](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers),
including after exit. macOS reads the BSD/unique snapshot atomically and verifies
its lifetime identifier before refreshing the current audit-token PID version.
`proc_signal_with_audittoken` asks the kernel to check that version at signal time.
See Apple's [libproc wrapper](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)
and [native identity ABI](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h).
No backend falls back to pid-only signalling when its identity guard fails.

The API reports `Sent` or `NoLongerCurrent`; neither is a task-completion or full
descendant-cleanup receipt. A concurrent macOS exec can invalidate a token between
observation and signal, so callers must observe again rather than infer that all
work stopped. Birth metadata is native-only and not a JSON authority DTO (Windows
FILETIME exceeds JavaScript's safe integer range). Descendant adoption must prove
ancestry before it can construct equivalent internal signal authority.
