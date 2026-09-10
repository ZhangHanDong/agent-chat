[English](README.md) | [中文](README.zh-CN.md)

# Hagency

**A control plane for a fleet of interactive coding agents.**

Hagency runs Claude Code and Codex agents in tmux panes and gives them what they
otherwise lack: identity, a message bus, a shared task system, human oversight,
and an optional Matrix front door. It is local-first — the backend binds to
loopback by construction, and nothing needs to leave the machine.

Hagency is a fork of [agent-chat](https://github.com/shisuiki/agent-chat). Many
internal identifiers still carry the `hagency` / `HAGENCY_` prefix; those
are stable interfaces and are deliberately unchanged. See
[Naming](#naming) below.

## Contents

| Section | |
|---|---|
| [What it does](#what-it-does) | The capability surface |
| [Architecture](#architecture) | Components and layers |
| [Install](#install) | Five paths, pick by host |
| [Quick start](#quick-start) | First agent, first message |
| [Operating](#operating) | Upgrade, roll back, verify |
| [Configuration](#configuration) | `.env` reference |
| [Security posture](#security-posture) | What is enforced, and what is assumed |
| [Development](#development) | Tests and gates |

## What it does

**Fleet lifecycle.** Start, stop, list and resume agents as tmux sessions.
Per-agent home directories, project mounting, and reusable framework presets.

**Message bus.** Agents do not talk to each other directly — they talk to the
bus. DMs, groups, mailbox semantics (messages persist while an agent is busy),
offline catch-up, delivery receipts, attachments. Messages can carry a structured
`schema: {kind, version, payload}` envelope, which is how third-party execution
backends integrate.

**Task system.** A task store plus **task graphs**: a DAG whose nodes each carry
an assignee, dependencies and optional conditions. Upstream results are injected
into downstream dispatches, and only the assigned agent may close its own node.

**Attention routing.** The backend emits SSE; the push relay consumes it and
delivers by *typing into the agent's tmux pane*. It also infers state from pane
output — idle vs active, blocked-on-a-prompt, context compaction.

**11 MCP tools** give agents `whoami`, `send_message`, `post`, `check_inbox`,
`check_group`, `list_tasks`, `get_task`, `accept_task`, `transition_task`,
`comment_task`, `update_task_execution`.

**Human-in-the-loop approvals.** A coding runtime's permission requests are
relayed to **the owning developer**, not to everyone in the room.

**Optional Matrix bridge.** Puts agents in real Matrix rooms so you can reach
them from Element on a phone. Per-agent accounts, E2EE, a trust model, and 20
`!` operator commands.

**Optional supervisor.** Watches agents and escalates: after N consecutive
negative assessments it nudges, then escalates. It can message; it cannot start,
stop or reassign.

Surface area: **101 REST endpoints**, **19 CLI subcommands**, **11 MCP tools**,
**7 dashboard pages**, **4 runtime dependencies**.

## Architecture

| Component | Role |
| --- | --- |
| `backend-v2.js` | Central API, durable JSON stores, agent registry, task graphs, alerts, SSE stream, auth boundary |
| `server.js` | Dashboard and queue/reminder delivery surface |
| `push-relay.js` | SSE consumer that injects notifications into tmux panes |
| `mcp-server.js` | Per-agent MCP server exposing messaging and task tools |
| `bridge-matrix.js` | Optional Matrix bridge for external rooms and operators |
| `services/hagency-services.mjs` | Non-systemd process supervisor (the macOS runtime) |
| `bin/hagency` | Unified CLI dispatcher |
| `remote/` | Minimal remote relay package for other machines |

Three concentric layers, declared in `scripts/architecture-boundaries.json` and
**enforced in CI**:

- **Kernel** — `agent-state`, `task-graph`, `task-store`, `agent-launch-policy`.
  Forbidden from importing the backend, dashboard or `remote/`.
- **Control plane** — the REST API, SSE and JSON persistence, single process.
- **Edges** — tmux/CLI glue, Matrix bridge, dashboard, MCP. All optional.

Default local ports:

| Service | Default |
| --- | --- |
| Backend API | `http://127.0.0.1:8090` |
| Dashboard | `http://127.0.0.1:8084` |

Systemd units (Linux), all shipped with sandboxing and resource limits:

| Unit | Entrypoint | Notes |
| --- | --- | --- |
| `hagency-backend.service` | `backend-v2.js` | Starts first |
| `hagency.service` | `server.js` | Dashboard and local queue surface |
| `hagency-push-relay.service` | `push-relay.js` | tmux notification relay |
| `bridge-matrix.service` | `bridge-matrix.js` | Optional, `--with-bridge` |
| `hagency-stable-autodeploy.service` | watcher | Optional; unprivileged |

## Install

Five paths. Pick by what the host is for — full detail in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

| Path | Host | Use when |
| --- | --- | --- |
| Bootstrap | Linux + systemd | The normal case |
| Manual clone | Linux + systemd | You want the checkout somewhere specific |
| **macOS** | macOS | A Mac host: launchd + supervised services |
| Containers | Any | Control plane only, no local agents |
| Remote relay | Linux or macOS | Agents only, reporting to a backend elsewhere |

### Bootstrap (recommended, Linux)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/hagency-org/hagency/master/install/bootstrap.sh)
```

Downloads the published release tarball, **verifies it against `SHA256SUMS`**,
and unpacks it — no git required. A checksum mismatch aborts rather than falling
back. Installer flags go after `--`:

```bash
bash <(curl -fsSL .../bootstrap.sh) -- --dry-run
bash <(curl -fsSL .../bootstrap.sh) --ref v1.2.0 -- --with-bridge
bash <(curl -fsSL .../bootstrap.sh) --list
```

### Manual clone (Linux)

```bash
git clone https://github.com/hagency-org/hagency.git
cd hagency
./install-full.sh --dry-run   # review every action first
./install-full.sh
```

| Option | Use |
| --- | --- |
| `--dry-run` | Print planned actions only, change nothing |
| `--no-start` | Install files without enabling or restarting services |
| `--with-bridge` | Also install and start `bridge-matrix.service` |
| `--env-file PATH` | Use a custom env file |
| `--bin-dir PATH` | Link CLI commands into a custom directory |
| `--systemd-dir PATH` | Render service files into a custom directory |
| `--service-user USER` | Render units for a specific user |
| `--skip-mcp` | Skip Claude Code and Codex MCP configuration |
| `--skip-npm` | Skip `npm install` |
| `--skip-prereq-check` | Skip host prerequisite checks |

`install.sh` and `install-v2.sh` are deprecated wrappers that delegate here.

### macOS

`install-full.sh` refuses to run on macOS, because it renders systemd units.

```bash
./install/install-macos.sh --dry-run
./install/install-macos.sh
```

launchd user agent instead of systemd, `hagency-services.mjs` as the
supervisor, Matrix bridge off by default, and no auto-deploy watcher. Missing
prerequisites (`node >= 22`, `tmux`) are installed with Homebrew.

> **It will refuse if unrelated tmux sessions already exist.** Hagency registers
> tmux sessions as agents, and the relay delivers by typing into their panes — so
> on a shared host it can type into someone else's work. Stop or rename them, or
> pass `--allow-existing-tmux` to accept the risk knowingly.

### Prerequisites

| | Linux | macOS |
| --- | --- | --- |
| Node.js | `22+` | `22+` |
| tmux, git, bash | required | required |
| systemd + sudo | required | n/a (launchd) |
| Homebrew | n/a | required for prereq install |

Optional: the Claude Code or Codex CLI for automatic MCP registration; Matrix
credentials only if you run the bridge.

### Uninstall

```bash
./uninstall.sh              # preserves ~/.hagency, data/, .env
./uninstall.sh --yes        # non-interactive
./uninstall.sh --purge-data --purge-hagency-home   # destructive, confirms
```

The uninstaller only removes symlinks and units that point into *this* checkout,
and only skill directories it owns.

## Quick start

```bash
# Start an agent
hagency up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh

# Talk to it
hagency send alice "status?"

# See the fleet
hagency ls
hagency service status
```

The current contribution dashboard is the Next.js app in `mockup/`, at
`http://127.0.0.1:3100`. See [its startup instructions](mockup/README.md) for
the server-side backend URL and operator token. Port 8084 below refers to the
older `server.js` web/queue service, not this console.

Agents run over one of two transports, decided by their framework adapter: tmux
(`hagency up`) or ACP (`hagency acp-up`). `hagency ls` shows which in the `TRANS`
column. See [docs/agent-onboarding.md](docs/agent-onboarding.md) for both paths,
what onboarding actually does, and what the failure messages mean.

Dashboard design notes live in [docs/design/](docs/design/): a scored
[UX review](docs/design/dashboard-ux-review.md) and the
[left-rail relayout design](docs/design/dashboard-relayout.md).

Current dashboard pages:

| Path | Purpose |
| --- | --- |
| `/`, `/resources` | Contributed agents, presets, ceilings and measured usage |
| `/workforce` | Agent roster, availability and project access |
| `/agents/<name>` | Runtime, terminal capture where available, activity and read-only profile |
| `/resources/new`, `/onboard` | Contribution preset and agent onboarding forms |
| `/capability`, `/engagements` | Offered roles and capacity allocations |
| `/projects`, `/projects/new` | Project access and project-side onboarding |
| `/usage` | Measured task counts, tokens and current allocations |
| `/alerts` | Alerts |
| `/config` | Agent and preset configuration |

Reach an agent through Matrix, `hagency send`, its terminal where present, or the
REST API. Thread-session runners use durable dispatch state; an idle headless
runner has no resident pane. The contribution console reports availability and
usage, while decomposition, assignment and lower-loop verification remain with
the managed agents.

## Operating

### Verify

```bash
systemctl status hagency-backend hagency hagency-push-relay
node services/standalone-doctor.mjs     # cross-component health
hagency check-mcp
node -e 'import("./lib/version.js").then(m=>console.log(m.formatBuildIdentity()))'
```

### Upgrade, with automatic revert

```bash
./upgrade.sh --list          # current version and available releases
./upgrade.sh --to v1.3.0     # gate, apply, health-check, revert on failure
```

It refuses a dirty tree, gates the **target** ref in a throwaway worktree so a
bad target never touches the live checkout, and reverts if the new version does
not come up healthy. Exit `1` means rollback succeeded; exit `2` means rollback
also failed and a human is needed.

### Auto-deploy (optional)

The watcher polls a deploy branch, gates the candidate, and restarts. It runs
**unprivileged**, escalating only for `systemctl restart` through a narrow
sudoers rule, and the release gate is **on by default**.

On a health-gate failure it rolls the live checkout back to the last healthy ref
and **quarantines** the bad one, so the same commit is not re-deployed forever.
Pushing a fix clears the quarantine. See [docs/ROLLBACK.md](docs/ROLLBACK.md).

### Stable Branch Auto Deploy (Live)

The live deploy checkout is **disposable**. Run the preflight gate before
promoting a deploy candidate:

```bash
npm run verify:cd-preflight
```

The watcher repairs the live checkout with reset-based operations rather than
fast-forward pulls, so a diverged or dirty checkout can never block a deploy:

```bash
git reset --hard HEAD
git clean -fd
git reset --hard origin/stable
```

After deployment, verify the loaded remote relay:

```bash
hagency verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

### Releases

Tag-driven. Pushing `v1.3.0` runs the gates and publishes two reproducible,
checksummed tarballs — full stack and remote relay. See
[docs/RELEASING.md](docs/RELEASING.md).

## Configuration

Most configuration lives in `.env`, created from `.env.example` by the installer.

> The supervised-services path does **not** auto-load `.env`. Source it first:
> `set -a; . ./.env; set +a`

### Core

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `API_TOKEN` | **Yes** | none | Operator bearer token for backend, dashboard proxy, MCP and relay |
| `HAGENCY_API` | No | `http://127.0.0.1:8090` | Backend API base URL |
| `HAGENCY_RUNTIME_DIR` | No | repository root | Runtime root for `data/` and `logs/` |
| `HAGENCY_BACKEND_PORT` | No | `8090` | Backend port |
| `HAGENCY_WEB_PORT` | No | `8084` | Dashboard port |
| `HAGENCY_BACKEND_HOST` | No | `127.0.0.1` | Backend bind address. **Containers only** — see [Security posture](#security-posture) |
| `HAGENCY_WEB_HOST` | No | `127.0.0.1` | Dashboard bind address. Same caveat |
| `HAGENCY_WEB_URL` | No | `http://127.0.0.1:8084` | Public dashboard URL used in push queue calls and Matrix links |
| `HAGENCY_QUEUE_URL` | No | `${HAGENCY_WEB_URL}/api/queue` | Queue endpoint for push notifications |
| `HAGENCY_DASHBOARD_TOKEN` | No | empty | Bearer token for non-local dashboard mutations |
| `HAGENCY_SERVER` | Remote: yes | `local` or hostname | Server identity in runtime reports |
| `MSG_BASE_URL` | Legacy | from `HAGENCY_WEB_URL` | Override for Matrix `/msg` links |

`backend-v2.js` and `server.js` fail fast when started without a non-empty
`API_TOKEN`.

### Agent runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAGENCY_HOMEDIR` | `~/.hagency` | Agent home root |
| `HAGENCY_AGENT_TOKEN_MODE` | `hard` | Per-agent token enforcement |
| `AGENT_IDLE_THRESHOLD_MS` | `20000` | Idle threshold for push delivery |
| `AGENT_SCOPE_MONITOR_ENABLED` | `true` | Local resource monitoring |
| `OFFLINE_CATCHUP_LIST_LIMIT` | `50` | Offline catch-up message limit |
| `REMINDER_MERGE_PREVIEW_LIMIT` | `20` | Reminder merge preview limit |

Coding-agent permission policy is **enforced by the launchers**, not chosen by
the agent: Claude runs `auto-mode`, Codex runs Level 2
(`workspace-write` + `on-request`). Policy-changing `extraArgs` are rejected.

### Push relay

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUSH_RELAY_MODE` | `local` | Local or remote relay profile |
| `PUSH_RELAY_SCAN_INTERVAL_MS` | `30000` | Runtime scan interval |
| `PUSH_RELAY_RECONNECT_MS` | `5000` | SSE reconnect interval |
| `PUSH_RELAY_HEARTBEAT_INTERVAL_MS` | `15000` | Heartbeat interval |

### Matrix bridge

| Variable | Default | Meaning |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | `https://matrix.example.com` | Homeserver URL |
| `MATRIX_SERVER_NAME` | homeserver host | Matrix server name |
| `MATRIX_BOT_USERNAME` | `agent-bridge` | Bridge bot username |
| `MATRIX_BOT_PASSWORD` | empty | Bridge bot password — **cannot be generated** |
| `MATRIX_BRIDGE_SECRET` | empty | Shared secret between backend and bridge; generated by the installers |
| `MATRIX_REG_TOKEN` | empty | Registration token |
| `MATRIX_AGENT_PREFIX` | `ac_` | Prefix for agent Matrix account names |
| `MATRIX_AGENT_TOKEN_<AGENT>` | empty | One agent's Matrix access token, supplied by you. Agent name upper-cased, non-alphanumerics as `_` (`wf_coordinator` → `MATRIX_AGENT_TOKEN_WF_COORDINATOR`). Agent passwords are no longer derived from a shared secret — see ADR-014 decision 3 |
| `MATRIX_DEFAULT_WAKE` | `off` | Mention-only. Unaddressed group messages wake nobody |
| `MATRIX_TRUST_MODE` | `enforce` | `enforce`, `audit` or `off`. Use `enforce` on public homeservers |
| `MATRIX_TRUSTED_INVITER_MXIDS` | empty | Users whose invites are auto-joinable |
| `MATRIX_OPERATOR_MXIDS` | empty | Users allowed privileged commands |
| `MATRIX_GREETING_MXIDS` | empty | Users to proactively DM when absent from the directory |
| `MATRIX_IGNORED_SENDER_MXIDS` | empty | Senders to ignore entirely |
| `MATRIX_INVITE_POLL_MS` | `60000` | Invite poll interval, floor 5000. Public homeservers rate-limit hard |

### Supervisor

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPERVISOR_ENABLED` | `false` | Enable supervisor loops |
| `SUPERVISOR_LLM_PROVIDER` | `deepseek` | Model provider |
| `SUPERVISOR_LLM_MODEL` | `deepseek-chat` | Model |
| `SUPERVISOR_LLM_KEY` | placeholder | Provider API key |
| `SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS` | `60000` | Lifecycle sweep interval |

### Deploy and release gates

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAGENCY_DEPLOY_BRANCH` | `stable` | Branch watched by the deploy watcher |
| `HAGENCY_RELEASE_GATE` | `worktree` | Candidate gate. `none` disables it — an explicit opt-out |
| `HAGENCY_DEPLOY_SERVICES` | script-specific | Services restarted on deploy |
| `HAGENCY_ALERT_URL` | empty | Optional endpoint for deploy-failure alerts |
| `HAGENCY_ALERT_TOKEN` | empty | Bearer token for the above |
| `HAGENCY_VERIFY_REMOTE_BIN` | `bin/verify-remote` | Remote verification helper |

## Security posture

What Hagency **enforces**:

- **Agents cannot widen their own permissions.** Launch policy is applied by the
  launcher and policy-changing arguments are rejected.
- **Agents cannot orchestrate other agents.** No MCP tool creates a task graph;
  that requires the operator token.
- **Approvals go to the owner**, not the room.
- **Services are sandboxed.** Every unit ships `NoNewPrivileges`,
  `ProtectSystem=full`, capability and syscall restrictions, and resource limits.
- **The backend binds loopback by construction** — a function default with no env
  override on the Linux/systemd path.

What it **assumes**, and you should know:

- **Loopback trust is machine-scoped, not user-scoped.** Any local process is
  treated as local. On a shared host, per-agent tokens
  (`HAGENCY_AGENT_TOKEN_MODE=hard`) are the real control.
- **A non-loopback bind is for containers.** `HAGENCY_*_HOST` exists so a
  container can be reachable through a published port. It is logged loudly at
  every start; a malformed value falls back to loopback rather than widening.
- **Task-graph completion is self-reported.** A node closes when its assignee
  says so; nothing verifies the claim.
- **Existing tmux sessions get adopted.** Hagency registers what it finds.
- **There is known dependency debt** — 53 transitive advisories, ratcheted so
  nothing new can land. See [docs/SECURITY-DEBT.md](docs/SECURITY-DEBT.md).

For internet-facing deployments, put the dashboard behind an HTTPS reverse proxy
and keep `HAGENCY_API` loopback-only.

## Development

```bash
npm install

# Run services directly
API_TOKEN=dev-token node backend-v2.js
API_TOKEN=dev-token node server.js
API_TOKEN=dev-token node push-relay.js

# Or under the supervisor
set -a; . ./.env; set +a
HAGENCY_RUNTIME_DIR="$PWD" node services/hagency-services.mjs start
```

Tests and gates:

```bash
npm test                              # full suite
npm run test:kernel
npm run check:syntax
npm run check:cli-contract
npm run check:architecture-boundaries # import + route-ownership rules
npm run audit:baseline                # advisory ratchet
AGENT_NAME=hagency-develop npm run verify:ci
```

Remote package and release artifacts:

```bash
npm run build:remote:check
npm run check:remote-sync
./scripts/build-release-package.sh --out-dir dist
```

Runtime data, logs, `.env`, generated `remote-dist/` and `dist/` are ignored and
are not source of truth.

## Naming

The project is **Hagency**. Internal identifiers still use the upstream
`hagency` / `hagency` / `HAGENCY_` / `HAGENCY_` naming, deliberately:
systemd unit names, CLI command names, `.env` variable names, the MCP server
name and the `~/.hagency` data directory are all covered by the compatibility
contract in [docs/RELEASING.md](docs/RELEASING.md). Renaming them is a major
version with a migration, not a documentation change.

## Documentation

| Document | Covers |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | All five install paths, platform matrix, hardening |
| [docs/RELEASING.md](docs/RELEASING.md) | Versioning, the SemVer surface, cutting a release |
| [docs/ROLLBACK.md](docs/ROLLBACK.md) | Auto-deploy and manual rollback, state files |
| [docs/SECURITY-DEBT.md](docs/SECURITY-DEBT.md) | Dependency advisories and the ratchet |
| [docs/LICENSING.md](docs/LICENSING.md) | Fork provenance and Apache 2.0 attribution obligations |
| [docs/TESTING.md](docs/TESTING.md) | Test harness, the memory leak behind flaky runs, concurrency trade-off |
| [OPERATIONS.md](OPERATIONS.md) | Operator runbook: health, deploys, incidents |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [remote/README.md](remote/README.md) | Remote relay package |
| [services/README.md](services/README.md) | Supervised services and the two doctors |

Archived, kept for historical context only — use the runbooks above instead:
`ROADMAP-remote.md` — Superseded remote planning archive.

## License

**Apache License 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Hagency is a fork of [agent-chat](https://github.com/shisuiki/agent-chat), which
adopted Apache 2.0 on 2026-07-29; both are now under the same license. **717 of
this tree's commits are inherited from upstream**, so `NOTICE` credits the
upstream authors — retain it when you redistribute, along with `LICENSE`, and
mark any files you change. See [docs/LICENSING.md](docs/LICENSING.md).
