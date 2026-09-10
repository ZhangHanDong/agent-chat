---
name: hagency-inner-loop
description: Use when an Hagency-managed Claude, Codex or other middle agent delegates repository work through Herdr and octoloop to a lower execution agent, or must monitor and verify such a job.
---

# Hagency inner execution

The Hagency-managed agent owns decomposition, execution choice, verification
and the reply to the originating task. Herdr owns terminal processes;
octoloop supplies its execution workflow. Choose the lower backend for the
task: octoscode, Claude Code (`claude` in Herdr), Codex, Grok or another
installed kind. This does not make octos a supported Hagency thread runner.

## Select and start

Use the operator-authorized Herdr session and project path. Authorization
already given for this task persists. Outside Herdr, an explicitly authorized
named session is required; never borrow the focused session. Discover the
installed CLI with `herdr --help`, `herdr agent` and `herdr pane`. Do not run
bare `herdr` for discovery. For octoloop, read its installed skill and the
selected project's startup protocol; it is a skill, not necessarily a binary.

Inspect the explicit session with `herdr --session "$SESSION" agent list`.
Reuse only an assigned agent that is ready for new work. Otherwise select an
available shell pane or create one within the authorized layout. Get IDs from
JSON responses; keep the user's focus and set the project working directory:

```bash
herdr --session "$SESSION" pane split "$PARENT_PANE" --direction right --cwd "$PROJECT" --no-focus
herdr --session "$SESSION" agent start "$INNER_NAME" --kind "$KIND" --pane "$NEW_PANE" --timeout 30000
herdr --session "$SESSION" agent get "$INNER_NAME"
```

Use `down` when it fits the layout. Pass authorized native agent arguments
after `--`; preserve sandbox and approval policy. Inspect blocked startup
instead of injecting a prompt or approving it. A started pane alone does not
prove readiness. Inspect octoloop's active goal/loop state before assigning a
new job; do not silently reuse an old active goal or take over another agent.

For a new named session, start its headless server and create its first
workspace with `workspace create --cwd "$PROJECT" --no-focus` before selecting
a pane. Two octoscode instances in the same project may collide on an Octos
instance lock. If startup reports `OCTOS_DATA_DIR_LOCKED`, preserve the existing
owner and give the new instance its own control directory through Octos's
`--instance-data-dir`. Confirm the installed `octos serve --help` and pass the
command through octoscode's `--stdio-command`; do not delete another instance's
lock or interrupt its job. A profile-list error may be a consequence of this
failed server startup, so inspect the actual server error.

On macOS, a deeply nested instance directory can exceed the Unix socket path
limit and leave the TUI visible after its server has exited. Inspect the
operator-control RPC error and use a short, dedicated runtime path (or a
verified private alias to it). Preserve the real control files outside the
edited repository. Restart only this job's failed instance, then confirm the
backend is connected before preparing or sending work.

## Prepare before dispatch

Resolve [scripts/monitor.mjs](scripts/monitor.mjs) relative to this skill's
directory and set `MONITOR` to that absolute path. The helper requires Node
22+, Git and Herdr. Set `CONTROL` to a directory outside the edited repository.
Choose an independent, task-specific verifier before dispatch; use the exact
test selector or a review script under the middle agent's control. A command
that merely prints success is not verification. The result must never choose
the verifier. Tests that intentionally edit source need a separate verification
checkout and a verifier that checks its correspondence to the submitted work.

```bash
node "$MONITOR" prepare --session "$SESSION" --agent "$INNER_NAME" \
  --cwd "$PROJECT" --jobs-dir "$CONTROL" \
  --verify-json '["npm","test","--","tests/relevant.test.js"]' \
  --timeout-ms 900000 --command-timeout-ms 60000
```

The JSON response contains `manifest_path`, `result_path`, `job_id`, `nonce`
and the observed execution identity, including the pane's shell pid and
foreground process group from `pane process-info`. Missing process evidence
fails preparation; do not substitute a pane label. Each preparation creates a fresh job.
Keep the manifest unchanged. Its directory is a local evidence record, not
Hagency task state or an authorization boundary between same-user processes.

Give the inner agent the actual task, boundaries and acceptance criteria plus
the generated result path, job id and nonce. Require it to write the result
after finishing its edits and checks, with no further writes for this job.
Use an atomic rename when possible; the helper also reads an in-place update.
The completed result schema is:

```json
{
  "version": 1,
  "job_id": "copy the prepared job_id",
  "nonce": "copy the prepared nonce",
  "status": "completed",
  "summary": "Concrete changes and limitations",
  "commit": "exact git rev-parse HEAD of the submitted repository",
  "checks": [{"name": "exact check run by inner", "status": "passed"}]
}
```

`commit` identifies the base HEAD even when authorized edits are uncommitted;
do not commit solely to satisfy this field. Failed or blocked work must use
`status: "failed"` or `"blocked"` and a concrete `summary`. Optional progress
uses `"working"`, retaining the version, job id and nonce. Completed results
require at least one named passed check; skipped or uncertain checks do not
become passed. Inner test claims are evidence to examine, not acceptance.

## Keep the monitor owned

Start the monitor as a managed shell-tool process that gives you a resumable
process handle, then send the prepared task in the same active batch:

```bash
node "$MONITOR" watch --job "$MANIFEST"
herdr --session "$SESSION" agent prompt "$INNER_NAME" "$(cat "$PROMPT_FILE")"
```

These are separate tool operations: `watch` stays running while you send the
prompt. Keep its process handle and resume it at intervals of at most 60
seconds. Do not end the Hagency dispatch while an unowned watcher or inner
job is still outstanding. If prompt delivery fails, record the failure and
inspect the target; do not automatically resend a possibly accepted job.
`agent prompt --wait` and a pane that says idle can refer to another turn;
neither replaces the job monitor.

The helper polls the full result content, validates the fresh job and nonce,
matches the reported commit to HEAD and executes only the prepared argv in
the recorded directory. It compares tracked and non-ignored untracked file
contents, Git status/index, result bytes and agent identity around verification.
Ignored runtime files are outside that comparison; Git submodules are rejected.
Keep exclusive ownership of the submitted tree throughout verification: two
matching snapshots do not prove that another writer never ran between them.

It prints JSON, saves `report.json` beside the manifest, and exits:

| Exit | `work_status` | Action |
|---|---|---|
| 0 | `verified` | Review verifier output and evidence against task acceptance. |
| 1 | `failed` | Inspect reason and logs; fix or explicitly plan a fresh job. |
| 2 | `blocked` | Surface the actual blocker through the task's existing flow. |
| 3 | `timed_out` | Inspect bounded failure; do not assume the inner stopped. |

`runtime_status` and `runtime_state_change_seq` are separate observations.
Herdr may classify octoscode as idle with an unchanged sequence while it is
working. Neither field, a translated label, ACK substring nor file line count
can prove this job completed. `verified` means the chosen independent check
passed on the sampled unchanged work; it does not mean the runtime stopped,
Hagency marked its task done, or Matrix delivered a reply.

After review, use the current session's authenticated Hagency task lifecycle
tools and return the evidence-backed result to the originating thread. Follow
the existing octoloop receipt/goal-close protocol where applicable. Never
edit backend state or manufacture an ACK to force completion. Stop only
processes owned by this job when authorized; keep unrelated panes and sessions.
