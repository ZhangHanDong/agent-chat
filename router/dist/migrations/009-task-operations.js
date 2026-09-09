export const TASK_OPERATIONS_SCHEMA = `
CREATE TABLE runner_task_operations (
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, tool_call_id)
);
UPDATE router_event_meta SET schema_version = 9 WHERE id = 1;
`;
