---
kind: decision
id: ADR-048
title: Qualify Linux guardian loss recovery through protected host cgroup capabilities
status: Accepted
requirements: [REQ-RUST-MIGRATION-EXECUTION, REQ-THREAD-SCOPED-SESSIONS, REQ-THREE-LAYER-COMPLETION]
---

## Exact guarantee

This implements an optional host-only recovery path when a Linux guardian dies
but its owning host remains alive. The existing POSIX launcher still refuses
`require_crash_containment=true`. A cgroup is not a Windows kill-on-close Job:
closing its descriptors does not stop processes. Simultaneous backend/guardian
loss still needs a separately qualified external service manager or keeper.
Same-UID workspace code can signal both processes; nondumpability does not block
those signals. No server, actual runtime or sandbox capability is enabled here.

## Provisioning and admission

`CgroupRecovery::from_host_files` consumes an already-open directory and exact
write-only `cgroup.procs`/`cgroup.kill` descriptors. The trusted provisioner must
reserve a fresh empty domain subtree and keep its exclusive lease until cleanup
is inspected. It opens migration capabilities with sufficient privileges before
dropping privileges or handing them to the host. The native library never mounts,
creates, delegates, chmods or removes a cgroup, and never receives a runtime path
or PID as recovery authority.

Admission verifies cgroup2 filesystem magic, regular control files, matching
device/inode relative to the retained directory, write access mode, CLOEXEC,
root ownership, domain type and empty recursive population. A procfs-verified,
bounded mountinfo observation plus descriptor-based statx requires its exact mount ID
and a full `/` filesystem root, rejecting bind-mounted subtrees hiding ancestors.
Up to 64 ancestors and their `cgroup.procs`/`cgroup.threads` files must be root
owned with no group/other write bits. Workspace-created child groups remain
within that protected boundary.

The calling host must already have equal nonzero real/effective/saved/fs UIDs,
zero effective/permitted/inheritable/bounding/ambient capabilities, NNP=1 and
dumpability disabled. `/proc/thread-self/status` is bounded and required fields
must be present exactly once. SIGCHLD must be default without SA_NOCLDWAIT, and
the host exclusively owns reaping of its Child. The disposable guardian disables
dumpability again after exec, checks the same privilege conditions, and only then
acknowledges Prepare. Workspace exec inherits NNP and the empty capability sets.
The backend does not silently change its process-wide security configuration.

Checks cannot prove what a trusted privileged provisioner will do later. It must
not duplicate control capabilities to workspace code, modify protected permissions,
move processes across the boundary, insert unrelated work, remove/reuse the group,
or change host privilege/reaping policy during custody. Those are explicit host
preconditions, not boolean claims derived from a runner or model. Full production
qualification must validate this provisioning boundary and actual escape attempts.

## Launch and recovery

The existing launcher starts the trusted guardian waiting on its anonymous
control socket. Before sending Prepare, the host moves that retained unreaped
Child into the protected cgroup. Its PID is used solely to migrate this owned,
not-yet-started guardian; no numeric PID supplies kill authority. All later
workspace forks inherit the guardian's membership, avoiding the race where a
guardian dies before an uncontained child performs a pre-exec self-migration.
The existing descriptor seal and exact-three stdio transfer remain in use.

The optional path retains independent kill/events descriptors in the backend.
Stop or guardian-channel failure writes `1` to the retained kill capability and
observes recursive `populated=0` within the caller's absolute Instant deadline.
No PID census or PID kill fallback exists. A successful guardian reply alone is
not this independent proof. Empty population means no live execution in the
subtree, not that every adopted zombie has been reaped. The host reaps only its
retained guardian; host init/service management remains responsible for orphans.
No result completes a canonical task or releases any domain lease.
The host must actively call `wait` or `stop`; this primitive creates no background
monitor. The actual service/OwnedSession host integration remains open. A
`GuardianLost` cause means its trusted channel failed, including protocol errors;
it does not itself assert process death. Known failed guardian cancellation
signals remain recorded even if the independent cgroup later becomes empty.

Unknown writes, read errors and timeout keep cleanup unresolved. Explicit stop
retains the capability for inspection/retry; Drop makes bounded best-effort
attempts without claiming completion. Supervisor Drop shares a three-second
observation deadline; a still-armed capability's final Drop may add two seconds.
This synchronous five-second upper observation budget can block a worker and is
not nonblocking service orchestration. Kernel syscalls are not hard-real-time
operations; deadlines bound retry/poll behavior after syscalls return.

## Pinned kernel contract and remaining qualification

Linux v6.12 documents inherited cgroup membership, ancestor migration permission
checks, recursive population and fork/migration-safe `cgroup.kill`; threaded
groups are unsuitable. See the versioned
[cgroup-v2 documentation](https://www.kernel.org/doc/html/v6.12/admin-guide/cgroup-v2.html).
The inspected v6.12 implementation uses the opener's `f_cred` for migration
permission checks (`__cgroup_procs_write`, lines 4869–4910), rather than treating
the current unprivileged writer as the opener. Kill uses the exact kernfs cgroup
under the cgroup mutex (lines 3755–3824). See
[kernel/cgroup/cgroup.c](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup.c#L4869).
NNP and dumpability follow the Linux
[NNP contract](https://man7.org/linux/man-pages/man2/PR_SET_NO_NEW_PRIVS.2const.html)
and [dumpability contract](https://man7.org/linux/man-pages/man2/PR_SET_DUMPABLE.2const.html).
The unchanged Cargo.lock resolves rustix 1.1.4 and libc 0.2.189; no dependency
upgrade is part of this slice.

Local macOS tests exercise pure admission vectors and the unchanged POSIX
guarantee refusal. Linux cross-compilation is not execution. The Linux refusal
test rejects ordinary files/unprovisioned hosts and makes no containment claim.

The separate `hagency-cgroup-probe` executable has no ignored-test or missing-host
success branch. A qualified host must supply inherited descriptors 3/4/5 and the
required identity/capability/NNP conditions, plus a fresh user-owned mode-0700 test
directory. The disposable fixture seals those descriptors before spawning and
sets its own nondumpability after exec. Run each mode with a fresh reserved group:
`guardian-death`, `stop`, `failed-spawn`, `guarantee-refused`. The first two run a
real native child and double-fork detached descendant; guardian loss occurs only
after Start and live-heartbeat observation. Closing all child IO first must leave
work alive; cgroup cleanup must stop it. Failed spawn and complete-guarantee
requests must leave no workspace execution. Admission/refusal exits 78 and never
prints the fixture's qualification result. No privileged fixture has been run in
this macOS environment. Provisioned Linux execution and adversarial reassignment/
ptrace checks remain required before advertising recovery availability.
