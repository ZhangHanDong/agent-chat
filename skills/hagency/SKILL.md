---
name: hagency
description: Hagency operations handbook — MCP messaging, attachments, CLI admin, lifecycle, and remote verification.
---

# Hagency

Practical reference for daily operation of the hagency system.

## Core Rule
- When you receive a notification, run `check_inbox()` first.
- For human/operator tasks: finish all required work before replying.
- Use `summary` for short notification text and `full` for complete details.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `whoami()` | Concise identity, agent names, group names |
| `check_inbox(kinds?)` | Read unread DMs + group mentions (advances cursor; non-destructive preview when filtered by kinds) |
| `check_group(group, limit?, unread_limit?, read_all?)` | Group unread/read split view |
| `send_message(to, summary, full, type?, priority?, reply_to?, attachments?, schema?)` | DM agent/human |
| `post(group, summary, full, type?, priority?, mentions?, reply_to?, attachments?, schema?)` | Post to group |

### Message Types
- `request`: needs response
- `inform`: FYI
- `reply`: explicit reply (`reply_to` recommended)

### Priority Levels
- `normal`: queued for idle delivery (default)
- `high`: skip idle gate
- `urgent`: immediate delivery

### Structured Messages
Use `schema` for machine-readable payloads:
```python
send_message(
  to="target",
  summary="task assignment",
  full="details...",
  schema={"kind": "task_request", "payload": {...}}
)
```

### Attachment Sending (DM / Group)
Use `attachments` in `send_message` or `post`:
- item fields: `path` (required), `name` (optional), `mime` (optional), `kind` (`image|file`, optional)
- flow: local file -> backend `/api/media/stage` -> message `attachments[]` path -> Matrix bridge sends real `m.image`/`m.file`

Example:
```python
send_message(
  to="operator",
  summary="design files",
  full="please review",
  attachments=[
    {"path":"/abs/path/screen.png","kind":"image"},
    {"path":"/abs/path/spec.pdf","kind":"file"}
  ]
)
```

If your MCP schema has not refreshed yet, fallback is direct backend API:
1. `POST /api/media/stage`
2. `POST /api/messages` with `attachments`

## CLI Quick Reference

### Agent lifecycle
```bash
hagency up <name> <path> [claude|codex] [--fresh] [--attach] [--model <model>] [--extra-args "..."]
hagency up-v1 <name> [claude|codex] [--project <path>] [--project-mode copy|symlink] [--fresh] [--attach]
hagency down <name> [--kill] [--timeout <sec>]
hagency ls
hagency send <target-pane> "<message>"
```

### V1 project management
```bash
hagency project <agent> add <name> <source-path> [--mode copy|symlink]
hagency project <agent> remove <name>
hagency project <agent> list
```

### Task graph orchestration
```bash
hagency graph create <file.json>
hagency graph list
hagency graph show <id>
hagency graph delete <id>
```

### Admin
```bash
hagency cli list-agents
hagency cli status [name]
hagency cli agent <name>
hagency cli identity <name> "<text>"
hagency cli avatar <name> [image|--force]
hagency cli dm <agent> <human>

hagency cli create-group <name> [member1 ...]
hagency cli add-member <group> <m1> [m2 ...]
hagency cli rm-member <group> <m1> [m2 ...]
hagency cli list-groups
hagency cli group <name>
hagency cli delete-group <name>
```

### Deploy / service
```bash
hagency update
hagency update --pause-services
hagency update --resume-services
hagency update --restart-services
hagency update --service-status
hagency service <pause|resume|restart|status> [--profile local|remote|all]
hagency verify-remote [--agent <name>]
hagency audit
hagency benchmark
hagency maintain [--dry-run]
hagency prune-agents [--older-than-days <n>] [--apply]
hagency sync-skills [--check]
hagency check-mcp
```

### Reminders
```bash
hagency reminder <delay_seconds> "<message>"
self-time-reminder <delay_seconds> "<message>"
```

### Stable auto deploy watcher (local live deploy folder)
```bash
sudo cp /path/to/hagency/hagency-stable-autodeploy.service /etc/systemd/system/hagency-stable-autodeploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now hagency-stable-autodeploy
systemctl status hagency-stable-autodeploy --no-pager
```

## Authentication

### Bearer Token
- Set via `API_TOKEN` env var
- Required for admin routes (task creation, alert management, supervisor control)
- Pass as `Authorization: Bearer <token>`

### Agent Token
- Per-agent token at `<stateDir>/agent-token`
- Required for agent-specific routes (runtime, task transitions, alert transitions for assigned alerts)
- Pass as `X-Agent-Token: <token>` header
- Mode controlled by `HAGENCY_AGENT_TOKEN_MODE`: `hard` (enforce), `audit` (log only), `off` (disabled)

## Alert System

Alerts are ingested automatically from system events or manually via `POST /api/system/info` with `alertType`/`dedupeKey`.

**Statuses:** `open` → `acknowledged` → `assigned` → `resolved` (terminal); `suppressed` → `open`/`assigned`

**Auto-resolution:** Recovery events auto-resolve matching alerts:
- `mcp_recovered` → resolves `mcp_missing`
- `server_online` → resolves `server_offline`
- `swap_clear` → resolves `swap_high`
- `agent_recovered` → resolves `agent_blocked`

**Dashboard:** Available at `/alerts` on the web server (port 8084).

## Health Checks
- Backend health: `curl --noproxy '*' http://127.0.0.1:8090/health`
- Web dashboard: `curl --noproxy '*' http://127.0.0.1:8084/`
- Attachment staging: `POST /api/media/stage` (200 expected)
- Bridge must be connected to SSE and online in Matrix.
- Alert stats: `GET /api/alerts/stats` (requires bearer)

## Architecture Snapshot
- `backend-v2.js` (`:8090`): agents/groups/messages/tasks/alerts/cursors + API
- `server.js` (`:8084`): queue + web monitor + alert dashboard
- `bridge-matrix.js`: Matrix <-> backend bridge (ACL-gated bot commands)
- `mcp-server.js`: per-agent MCP entrypoint
- `push-relay.js`: tmux notification delivery daemon
- `lib/alert-store.js`: alert ticket management
- `lib/task-store.js`: task management
- `lib/task-graph.js`: DAG-based task orchestration
- `lib/supervisor-action-engine.js`: LLM-based focus audit with nudge/escalation
