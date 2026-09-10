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
