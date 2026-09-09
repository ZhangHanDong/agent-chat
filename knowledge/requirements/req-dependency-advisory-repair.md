---
kind: requirement
id: REQ-DEPENDENCY-ADVISORY-REPAIR
title: "Repair newly reported dependency advisories without relaxing the CI ratchet"
status: Accepted
liveness: auto
tags: [security, dependencies, ci]
---

## Problem

The existing production lockfile causes the blocking advisory ratchet to fail
on three newly reported Hono advisories and one Morgan advisory.

## Requirements

[REQ-DEPENDENCY-ADVISORY-REPAIR] Apply compatible patched versions of the affected
transitive dependencies, preserve the blocking audit policy and existing debt
baseline, and verify the affected MCP and Matrix approval paths with local tests.
This implements the existing security-debt policy; it does not approve the
remaining recorded vulnerabilities or claim that unused dependency paths are safe.

## Source Trace

- Existing policy: `docs/SECURITY-DEBT.md`, "The ratchet".
- CI failure: https://github.com/hagency-org/HAFleet/actions/runs/34382159421/job/102569479613
- https://github.com/advisories/GHSA-crvj-82cr-hjcx
- https://github.com/advisories/GHSA-g6gw-c38x-mqfc
- https://github.com/advisories/GHSA-gqvv-2mrq-wpjv
- https://github.com/advisories/GHSA-jxfw-x594-9x9m
