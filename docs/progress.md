
## 2026-09-06 macOS E2E

Operator requested Computer Use E2E with local Docker Palpo only, formal GUI @ member selection, and mempal disabled only for this E2E agent. Source baselines: HAFleet 0a0ae88, Palpo 8433b4a1, Robrix2 e28e118e. Palpo and PostgreSQL run in isolated Compose project hafleet-e2e at 127.0.0.1:8008; existing 8128 deployment is untouched. Palpo Docker source build and Robrix release build passed. Runtime: `~/.hafleet/e2e`; full evidence and per-layer RESULT.md: `~/.octos/outer/verify/e2e-{1,2,3}`.

GUI request/verdict/@ picker/real nonce reply passed. API isolation and recovery cases have explicit verified/partial ratings. F07 agent-leave test produced the expected warning in project 2; agent membership was restored in Matrix and HAFleet, confirmed in the GUI picker, and a test-end note posted.

Real thread runner launched Herdr session hafleet-agents-e2e, pane w1:p1, octoscode inner. Hello CLI implementation commit 0ad443b has four passing tests. Initial autonomous monitoring failed to recognize in-place ACK and the actual completion label, requiring intervention. Subsequent fresh-nonce E2EAUTOWATCH20260906A recheck completed autonomously through agent-authored monitoring, independent testing and a reply to the same Matrix thread; Codex only observed. mempal Stop hook and MCP are excluded by E2E-only wrappers for headless and ordinary tmux sessions; global settings hash is unchanged.

Source fixes: common startup now drains router outboxes without bot login; limited sync recovery now persists cursor bounds, pages the correct interval, validates complete responses, preserves failed/legacy recovery, and routes only messages through the authenticated router. Original 45-message burst delivered only 22; corrected live retest delivered all 45, including recovery after a real history-read rate limit. Red/green tests and independent review are recorded. Final regression/CI and commit evidence are linked in E2E-3 RESULT.md and `.octos/OUTER_LOOP_REVIEW.md`.

Remaining product gaps are not passing: task stays in_progress because legacy task lifecycle MCP is unavailable to the session runner; botless SSE membership path has misleading success logging after bot-client failure; task-title mention truncation. No state was manually changed to make lifecycle appear complete, and remote/ was not edited.

This checkout has no projects/, task-writer, or provisioned control-plane task object. No canonical task state was fabricated. These docs are coordination notes only.
