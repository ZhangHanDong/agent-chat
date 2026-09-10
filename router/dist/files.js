export const FILE_REPLY_SCHEMA = `CREATE TABLE IF NOT EXISTS file_replies (
  command_id TEXT PRIMARY KEY REFERENCES notice_outbox(command_id),
  request_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL, prepared_json TEXT
);`;
