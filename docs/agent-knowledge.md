
## 2026-09-06 E2E preflight observations

- This HAFleet source checkout links AGENTS.md/CLAUDE.md to agent-home templates, but has no provisioned `task-writer` or `projects/` directory. Treat missing control-plane state honestly.
- Robrix2 e28e118e uses macOS `~/Library/Application Support/org.robius.robrix`, as resolved by its robius-directories dependency. The runbook path `.../robrix` does not identify the existing session directory here.
- `verify-agent-e2e.sh` does not create a project side, registration, or prove room delivery; its own final output states the Matrix leg is not covered.
- HAFleet current `create_task` MCP implementation requires `DISPATCH_CAPABILITY` from the thread-session runner. Runbook E2E-3 ordinary tmux path still requires live verification.

## 2026-09-06 verified E2E findings

- Botless appservice deployments need router outbox polling from common bridge startup. Starting it only after bot login strands pending_thread tasks despite successful inbound Matrix delivery.
- Incremental sync gaps are distinct from the invite-to-join window. Persist from/to before advancing the cursor, retain unknown legacy boundaries, and validate pagination and every event before delivery. Recover messages only: replaying stale membership after newer sync state can remove a currently joined agent.
- A completed runner dispatch is not a completed task. Current session-scoped MCP rejects the legacy task/post routes; final text is routed by backend outbox. Do not bypass capabilities or mark task done from model-authored text.
- mempal may be installed as a direct global Stop hook, independently of MCP discovery. E2E isolation required an E2E settings copy without that hook, strict MCP configuration, and a wrapper applied to both headless and ordinary tmux sessions. Preserve global settings and other permission hooks.
- An inner loop can replace ACK in place. File line count and a single translated idle label are insufficient completion signals. The successful real recheck validated a fresh nonce result file, a newer completion sequence, and independent test results. Keep the initial failed monitoring result separate from the repaired recheck.
- Herdr session hafleet-agents-e2e can be attached with `herdr session attach hafleet-agents-e2e`; default Ctrl+B then Q detaches without stopping pane processes. The real inner is w1:p1; the old ordinary tmux pane is not the headless runner's current state.
- Computer Use paste timeout -10005 may occur after successful insertion. Inspect the current composer before retrying; type_text also dropped Chinese in this run. Use the official Computer Use tool path for GUI interaction.
