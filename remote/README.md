# Hagency Remote Package

This folder is the deployable package for remote servers.
Most files here are managed by root-level generators/sync checks:
- Build output: `bash scripts/build-remote-package.sh`
- Sync managed files into `remote/`: `bash scripts/build-remote-package.sh --sync-remote`
- Validate managed files: `bash scripts/build-remote-package.sh --check`

## Included

- `bin/hagency`
- `bin/hagency-up`
- `bin/hagency-down`
- `bin/hagency-ls`
- `bin/hagency-send`
- `bin/hagency-service`
- `bin/hagency-update`
- `bin/verify-remote`
- `bin/hagency-maintain`
- `bin/hagency-prune-agents`
- `bin/hagency` (deprecated alias)
- `push-relay.js`
- `mcp-server.js`
- `lib/push-relay-core.js`
- `lib/mcp-server-core.js`
- `lib/blocked-patterns.js`
- `lib/eventsource-mini.js`
- `push-relay.service`
- `push-relay-autodeploy.service` (installed only from git-checkout deployments)
- `.env.example`
- `install-remote.sh`

## CLI Migration

- New unified CLI: `hagency`
- Legacy commands (`hagency-up`, `hagency-down`, `hagency-send`, etc.) are deprecated wrappers that forward to `hagency` with a warning.
- Remote `hagency` only advertises commands included in this package. Central checkout commands such as `up-v1`, `project`, `graph`, `resume-id`, `benchmark`, `audit`, `sync-skills`, and `check-mcp` are intentionally not packaged here.

Examples:
- `hagency up <name> <path> [claude|codex] [--allow-shared-workspace]`
- `hagency down <name>`
- `hagency update --pause-services` (git-checkout installs only)
- `hagency cli fleet --expect-version <short-sha> [--json]`
- `hagency maintain`
- `hagency prune-agents --older-than-days 7 --apply`

## Quick Start

1. Copy `.env.example` to `.env` and fill values:
   - `HAGENCY_API=https://hagency.example.com`
   - `API_TOKEN=<backend token>`
   - `HAGENCY_SERVER=<this server id>` (unique for this remote host; never `local`)
2. Run install:
   - `bash install-remote.sh`
   - Do not run as root. The script uses `sudo` only for systemd.
3. Verify relay:
   - `sudo systemctl status hagency-push-relay`
   - `hagency verify-remote`
4. Verify MCP injection:
   - `claude mcp list`
   - `codex mcp list`
   - Both should include `hagency` with command `node .../mcp-server.js`
5. Launch remote agents:
   - `hagency up <name> <path> [claude|codex] [--allow-shared-workspace]`
6. Verify agent state after launch:
   - `hagency verify-remote --agent <name>`

Standalone package note: `hagency update` does not self-update generated packages because they have no `.git` checkout. Preserve `.env`, `data`, and `logs`, then install from a git checkout with `bash remote/install-remote.sh`.

Git-checkout autodeploy note: after `hagency-push-relay` restarts, `hagency-remote-autodeploy.sh` runs `verify-remote --expect-version <short-sha>` with `VERIFY_SAMPLES=2` and `VERIFY_INTERVAL=16` by default. Configure `HAGENCY_API`, `HAGENCY_SERVER`, `API_TOKEN`, and optional `VERIFY_AGENT` in `.env`; verification failure keeps the deploy pending for the next poll.

## Notes

- The central checkout operations runbook lives outside standalone remote packages. For generated packages, use the Standard Deployment Template below.
- In normal `git clone` deployments, `install-remote.sh` uses repo-root `bin/` as the helper source of truth.
  `remote/bin` is only a fallback when root `bin/` is unavailable.
- `remote/bin/hagency` is profile-specific, not a byte-for-byte mirror of root `bin/hagency`.
- `remote/bin/hagency-up` remains profile-specific, but it enforces the same coding-agent permission baseline as the local launcher: Claude auto-mode and Codex Level 2 (`workspace-write + on-request`).
- `remote/push-relay.js` and `remote/mcp-server.js` are thin wrappers. Shared logic lives in:
  - `lib/push-relay-core.js`
  - `lib/mcp-server-core.js`
- The script links helpers into `~/.local/bin` (no copy), so path resolution stays consistent.
- Re-running `bash install-remote.sh` is safe and is the recommended way to refresh both service and MCP config after updates.
- `install-remote.sh` now runs hard verification and exits non-zero on failures (service inactive, heartbeat not increasing, auth issues, or agent/server mismatch when `VERIFY_AGENT` is set).
- Git-checkout remote autodeploy verifies the loaded commit after restart and does not report deploy success when verification fails.

## Standard Deployment Template

Use this sequence for remote rollout and acceptance:

1. `hagency update`
2. `hagency verify-remote --expect-version <short-sha>`
3. `hagency up <name> <path> [claude|codex] [--allow-shared-workspace]`
4. `hagency verify-remote --agent <name>`

Pass criteria:
- `hagency-push-relay` is `active`
- `/api/servers` shows target server `online=true` and `lastSeen` increasing across 3 samples
- `/api/agents/<name>` shows `online=true`, `server=<HAGENCY_SERVER>`, `serverOnline=true`

Any failed step should stop immediately and be reported with raw command output.
