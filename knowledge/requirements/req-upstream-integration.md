---
kind: requirement
id: REQ-UPSTREAM-INTEGRATION
title: "Integrate Matrix workflow changes with current upstream"
status: Accepted
---

The operator requests integration of the committed Hagency, Robrix2 and Palpo
work with current upstream. Preserve resource-based allocation, Matrix DM/group
conversation and file handling, scoped approvals, explicit YOLO and upstream
three-layer task lifecycle, membership recovery and truthful dashboard state.
Existing databases from either branch must upgrade without losing data.
Resolve conflicts in isolated worktrees, validate and commit locally. Preserve
the running deployment and concurrent website work in the original checkout.

Validation must execute the entire expanded suite under the existing 4 GiB heap
limit. Recycle test processes at deterministic shard boundaries to contain the
documented backend-fixture module retention, preserving all failures and CI
JSON artifacts; do not silently retry, omit tests or raise the memory ceiling.
