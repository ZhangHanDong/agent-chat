spec: task
name: "Reusable middle-agent inner execution monitor"
inherits: project
satisfies: [REQ-INNER-LOOP-MONITOR, ADR-011]
tags: [agents, herdr, verification, regression]
---

## Intent

Give Hagency-managed middle agents a reusable skill and deterministic monitor
for delegated repository work through Herdr and octoloop. Replace ad hoc
terminal text watchers with fresh result correlation and independent checks.

## Constraints

### Must
- Prepare a fresh job id and nonce, observed identity, repository and verifier before dispatch.
- Bound the monitor by a finite deadline and each external command by at most 60 seconds.
- Validate the result content, commit, identity and repository stability around independent verification.
- Distinguish verified work from runtime status and Hagency task completion.

### Must Not
- Do not use translated status labels, line counts or old ACK text as completion authority.
- Do not execute a verifier supplied by the result file.
- Do not contact a live Herdr server or external service in tests.

## Decisions

- [JS-only] Use a self-contained Node ESM script with prepare and watch commands and JSON output.
- Save each fresh manifest outside the edited Git repository; refuse to reuse an existing job directory.
- Bind terminal and agent identity to Herdr pane process-info shell pid and foreground process group, rejecting same-pane restarts.
- Treat Herdr state_change_seq as diagnostic because octos lifecycle detection may not advance it.
- Read result content on each poll, including an in-place replacement; incomplete JSON remains pending until the deadline.
- Hash tracked changes and untracked contents before and after verification, and match the result commit to HEAD.
- Execute only the prepared argv in the recorded working directory, without a shell.
- Keep backend choice and authorized startup with the middle agent; the helper only prepares and observes.

## Boundaries

### Allowed Changes
- skills/hagency-inner-loop/**
- tests/inner-loop-monitor.test.js
- knowledge/requirements/req-inner-loop-monitor.md
- specs/task-inner-loop-monitor.spec.md

### Forbidden
- remote/**
- Runtime credentials and local .env files
- Hagency task state-machine, capabilities, Matrix routing and global agent settings

## Acceptance Criteria

Scenario: Preparation binds a fresh job to the explicit execution target
  Test: prepares distinct jobs with the observed identity and predeclared verifier
  Given a named Herdr session and a ready agent in a Git repository
  When the middle agent prepares two jobs outside that repository
  Then both manifests contain different job ids and nonces and the exact declared argv
  And mismatched working directories and job paths inside the repository are rejected

Scenario: In-place result replacement leads to independently verified work
  Test: observes in-place completion and reports verified work separately from unchanged runtime state
  Given an incomplete result followed by a matching completed result
  When the declared verifier passes and identity and repository remain unchanged
  Then the monitor returns verified work even if the diagnostic sequence is unchanged

Scenario: Stale and failed claims fail closed
  Test: rejects stale nonce wrong commit invalid checks and explicit failure
  Given a stale nonce, wrong commit, invalid checks or explicit failed result
  When the watcher observes the result
  Then it reports failure without executing the verifier

Scenario: Blocking and replacement stop monitoring
  Test: rejects blocked or replaced agents without running verification
  Given the original agent becomes blocked or a different identity or process group occupies its pane
  When the watcher observes the agent
  Then it returns blocked or failed without executing the verifier

Scenario: Concurrent changes invalidate verification
  Test: rejects commit tracked untracked result and identity changes during verification
  Given a valid completed result
  When verification changes HEAD, tracked files, untracked contents, result bytes or agent identity
  Then the watcher returns failed

Scenario: Failed and slow verifiers cannot claim success
  Test: fails a nonzero verifier and bounds a hanging child process
  Given a valid completed result and a failing or hanging declared verifier
  When verification runs
  Then the watcher returns failure or timeout and preserves command evidence

Scenario: Missing and incomplete results have finite waits
  Test: times out missing or incomplete results without running verification
  Given the job has no completed valid result
  When its deadline expires
  Then the watcher returns timed_out without running verification

Scenario: CLI has JSON results and an exit code for failed observation
  Test: CLI prepare and watch use the explicit session and emit JSON with matching exit codes
  Given a temporary local Herdr executable and repository
  When prepare and watch are invoked through the script
  Then stdout contains JSON and verified or failed results use matching process exit codes

Scenario: Installed skill symlinks preserve the executable resource
  Test: runs the CLI through an installed skill directory symlink
  Given the installed skill directory links to the repository skill
  When the script is invoked through that symlink
  Then it prints its command help

Scenario: Runtime work and task verification remain separate observations
  Test: keeps a working runtime distinct from independently verified work
  Given matching work passes the independent verifier while Herdr reports working
  When the helper emits its report file
  Then the report identifies verified work and the working runtime separately

## Out of Scope

- Starting, stopping or selecting the lower execution agent automatically.
- Authorizing approval prompts, changing sandboxes, committing or pushing work.
- Hagency task completion or Matrix delivery; those remain authenticated backend responsibilities.
- Non-Git workspaces and remote execution.
