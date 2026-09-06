---
kind: requirement
id: REQ-PROVISION-PROJECT-DOCS
title: "Bootstrap project documentation reflects provisioned project bindings"
status: Accepted
liveness: auto
tags: [provisioning, agents, projects]
---

## Problem

The real Codex E2E provisioned a project symlink and manifest binding, but
workdir/docs/projects.md contained only a generic placeholder. A middle agent
following its bootstrap could not identify the assigned code directory.

## Requirements

[REQ-PROVISION-PROJECT-DOCS] Provisioning MUST derive projects.md mappings from
the existing managedProjects manifest, including the project name, workdir
relative edit path, absolute edit path, source mode and origin path. It MUST
explain that symlink edits affect the origin and copy edits remain isolated.
The path base MUST explicitly be workdir, whose projects directory is projects/.

Refreshing bindings MUST preserve manual notes outside a managed document
block, replace the known old placeholder, and avoid duplicate blocks. Project
addition and removal MUST refresh this projection. No-project provisioning
MUST explicitly report that no project is bound. The manifest remains the
binding source; this document does not create task or credential authority.

## Source Trace

- Operator-directed 2026-09-06 real Codex provisioning E2E finding.
- scripts/provision-v1-agent-home.js and workdir bootstrap entry templates.
