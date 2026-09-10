# Palpo authorization import in onboarding

The operator could create a project-side record in Hagency, but step three only
offered registration tokens or generating an App Service registration. Using an
existing Palpo authorization required leaving the wizard for Engagements.

Step three now offers Appservice → 导入 Palpo 已授权配置. It validates the owner
download against the selected server, previews the actual representative,
namespace and callback, and provides 保存并验证. The callback comes from the
download; the operator does not have to choose a host address for this route.
Manual registration generation and registration-token onboarding remain available.

File selection does not write credentials. Invalid replacement files clear the
previous preview, and changing methods clears the pending import. Explicit save
uses the existing authenticated credential endpoint without generating another
registration. The file contents leave UI state before verification. Failed saves
remain editable; failed verification retains the saved credential and can retry
without another write. The completion page distinguishes Matrix identity access
from actual inbound event/reception verification in Palpo.

Validation:

- 14 Vitest tests pass across `tests/fleet-credential-import.test.js` and
  `tests/console-live-ux.test.js`.
- Four controlled Playwright scenarios pass against the final deployed console:
  the four-step import flow, foreign/invalid replacement refusal, save/verification
  failure recovery, and method switching with legacy onboarding. All API requests
  are intercepted; this is not a live Matrix-write acceptance claim.
- The production build succeeds. All 264 active spec selectors resolve; scoped
  whitespace checks pass.
- Agent-spec 1.4 parses/lints the task at 95% quality. Its lifecycle passes the
  change boundary but retains three unsupported behavioral skips, so the native
  lifecycle is **not passing**. Vitest and Playwright results are separate evidence.

The final build is deployed at `http://127.0.0.1:13202` using the isolated
`.next-palpo-wizard-v2` output. The previous build is retained for rollback.
The temporary browser console on13203 was stopped.

A real provider login downloaded the existing Palpo authorization and Playwright
successfully previewed it in the live wizard. The operator's `测试房间 1` record
still has no credential: the operator requested a manual walkthrough and will
perform the final save. Existing backend, bridge, Palpo, resource and history
state were not rewritten for this implementation. No commit or push was made.

Private evidence is under
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/`:
`wizard-browser-final.log`, `wizard-live-preview-verified.json`,
`wizard-live-import-preview.png` and `wizard-import-lifecycle.json`.
The downloaded `wizard-owner-configuration.json` is mode0600 and contains
credentials; it is not a repository artifact.
