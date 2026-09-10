# Completed Matrix thread follow-up recovery

The operator's second question, “改写为python版本”, had a valid native Matrix
mention and the original `octos-code-use` thread relation. The bridge received
it and Hagency stored it as `msg_0005`. Dispatch
`20de23cb-830b-41f4-9d5b-ef986d5c062a` was queued against the previously completed
task, while claimDispatch refused `task_status: done`. There was no pending
approval or running model for this second message. Intake and scheduling disagreed
about continuation after completion, and the done-state branch emitted no notice.

ADR-020 and `specs/task-completed-thread-followup.spec.md` define the scoped repair.
The existing one-task-per-assignee/thread binding remains. A fresh, unprocessed
supplementary Matrix message from the original human requester can reopen the
completed task when its never-started dispatch is claimed. The claim independently
checks the exact session, agent, room, thread, active binding, input attachment,
original Matrix sender and unprocessed state. Reopening and leasing commit in
one transaction after active-runner, unknown-outcome, workspace and resource gates.
The original completion timestamp and triggering message are recorded in a router
audit event. Old dispatches, outputs and message identities remain unchanged.

Foreign senders, agent peer messages, processed inputs, missing attachments,
mismatched scope and closed bindings do not reopen a task. Ineligible pending
work receives a deduplicated thread notice. Generic task transitions, sandbox
settings, runtime approval and mentionless lookup are unchanged. No new public
endpoint, database migration or live state-file edit was introduced.

Four new focused tests first reproduced the failure. After the fix, 114 tests in
six router/backend/runner/reconciliation/session-tool files pass with no skips.
The new integration test uses authenticated bridge HTTP intake for both messages,
then verifies the same task/session, latest input, previous result and replay
deduplication. Strict TypeScript build, generated-output comparison, router module
boundary, whitespace and 270 active spec selectors pass. Agent-spec1.4 reports
quality100%; its Cargo-only lifecycle retains5 unsupported behavioral skips and
is not passing. The separate Vitest results supply behavioral evidence.

Before deployment the isolated backend had no leased, started or parked runner.
Its owned PID67354 was gracefully stopped and restarted as PID52844 with the
existing private launcher and configuration. Mini1 Palpo, its web app, the local
bridge, console and separate manual runtime were not restarted. A consistent
read-only SQLite backup was saved privately before the restart.

The live router then claimed the original queued dispatch, with the original
message and session intact, at23:30:37Z. The task returned to in_progress and the
prior JavaScript dispatch remained completed. Router audit event65 records the
prior23:10:15Z completion and `msg_0005`. This is a fresh execution of the never-run
Python follow-up, not replay of the completed JavaScript dispatch. Live Python
completion and any runtime approval are recorded separately below when observed.

Live follow-up produced `projects/sum-js/sum.py` and `test_sum.py` in the same
agent workdir. Independent `python3 -B -m unittest -v test_sum.py` passes all3
positive/negative/zero checks. The runner then parked for the owner's actual
`./task-writer done` approval, request `approval_ba9fdadd9c28425fa973b8daee2489d4`.
The operator was directed to the new private card; the assistant did not issue
a verdict. At that observation the task was still in_progress, so Python test
success alone is not reported as canonical completion.

Subsequent independent API reads at23:49Z and23:55Z confirm this same task is
done (completed_at23:38:00.660Z), and the Python dispatch is completed. The
earlier pending approval is historical. The separate routine-maintenance repair
is documented in `2026-09-07-task-maintenance-approval.md`.

Private evidence under `palpo-admin-e2e/2026-09-06`:
`octos-second-question-diagnosis.json`, `octos-second-question-router.json`,
`completed-followup-before.log`, `completed-followup-tests.log`,
`completed-followup-contract.json`, `completed-followup-lifecycle.json`,
`completed-followup-predeploy.json`, and `completed-followup-recovered.json`.
No commit or push was performed.
