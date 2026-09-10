---
kind: requirement
id: REQ-EXECUTION-AUTHORIZATION
title: "Explicit Codex YOLO and revocable scoped execution grants"
status: Accepted
tags: [runtime, approval, security, console]
---

The operator requests an optional YOLO configuration. Checked means Codex's
execution approvals and built-in sandbox are disabled, subject to OS and service
permissions. Unchecked retains sandboxed execution with interactive escalation.
Existing installations remain unchecked. The contributor configures local machine
execution policy; a project request cannot silently change it.

Private approval cards offer approve once, allow matching permission within the
canonical task, always allow matching permission for this Agent/project, and deny
when the request has a precisely representable scope. Show that scope before
consent. Persist long-term grants across runners/restarts and provide revocation.
Unknown request types retain once/deny. Ordinary text is never approval.
