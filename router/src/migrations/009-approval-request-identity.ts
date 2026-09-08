// An operation may be requested again after denial. Preserve each approval's
// history; request identity and consumption, not identical input bytes, fence it.
export const APPROVAL_REQUEST_IDENTITY_SCHEMA = `
CREATE TABLE approval_waits_v9 (
  approval_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  operation_digest TEXT NOT NULL,
  upstream_thread_id TEXT,
  upstream_turn_id TEXT,
  upstream_item_id TEXT,
  upstream_request_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision TEXT,
  resumed_at INTEGER
);
INSERT INTO approval_waits_v9
SELECT w.*, CASE
  WHEN d.state = 'parked' AND w.rowid = (
    SELECT MAX(latest.rowid) FROM approval_waits latest WHERE latest.dispatch_id = w.dispatch_id
  ) THEN NULL
  ELSE COALESCE(w.resolved_at, w.created_at)
END
FROM approval_waits w JOIN dispatches d ON d.dispatch_id = w.dispatch_id;
DROP TABLE approval_waits;
ALTER TABLE approval_waits_v9 RENAME TO approval_waits;
CREATE UNIQUE INDEX approval_waits_runtime_request ON approval_waits(
  dispatch_id, upstream_thread_id, upstream_turn_id, upstream_request_id
) WHERE upstream_thread_id IS NOT NULL AND upstream_turn_id IS NOT NULL AND upstream_request_id IS NOT NULL;
CREATE UNIQUE INDEX approval_waits_current_dispatch ON approval_waits(dispatch_id)
  WHERE resumed_at IS NULL;
`;
