# REQ-CONSOLE-PRODUCT-PRESENTATION — Provider console presentation

Status: accepted

The operator asked to remove debugging clutter from the Hagency web app. The
console should lead with resource configuration, requests, connection status and
usage. Implementation explanations, internal identifiers, credential paths and
raw diagnostics belong in optional, keyboard-accessible disclosures.

English and Chinese must describe the same behavior. Sample data, unavailable
measurements, pending operations, unenforced limits and execution permissions must
remain explicit. Per-slice data provenance remains available; partial failures
must be visible without opening a disclosure. Unknown usage must not become zero.

Presentation changes must not change stored names, identity matching, approval
payloads, publication behavior, permissions or runtime configuration. Names alone
must never become authority. Required setup fields and recovery actions remain
accessible. Existing user data, including test records, must not be deleted.

Verification uses deterministic rendering and intercepted browser fixtures. It
must not create, approve, revoke or reconfigure real agents or project access.
