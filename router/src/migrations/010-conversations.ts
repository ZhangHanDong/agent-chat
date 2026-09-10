export const CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_conversation_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL, event_id TEXT NOT NULL, sender_mxid TEXT NOT NULL,
  body TEXT NOT NULL, event_ts INTEGER NOT NULL, thread_root TEXT,
  UNIQUE(room_id, event_id)
);
CREATE INDEX IF NOT EXISTS room_conversation_order ON room_conversation_events(room_id, seq);
CREATE TABLE IF NOT EXISTS room_conversation_files (
  room_id TEXT NOT NULL, event_id TEXT NOT NULL, manifest_json TEXT NOT NULL,
  PRIMARY KEY(room_id,event_id),
  FOREIGN KEY(room_id,event_id) REFERENCES room_conversation_events(room_id,event_id)
);
CREATE TABLE IF NOT EXISTS room_conversation_positions (
  room_id TEXT NOT NULL, agent_id TEXT NOT NULL, through_seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS dispatch_conversations (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id),
  room_id TEXT NOT NULL, agent_id TEXT NOT NULL, from_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL, read_parts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matrix_direct_rooms (
  room_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, human_mxid TEXT NOT NULL,
  project_room_id TEXT NOT NULL, engagement_id TEXT NOT NULL, root_event_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matrix_agent_rooms (
  room_id TEXT NOT NULL, agent_name TEXT NOT NULL, human_mxid TEXT NOT NULL,
  project_room_id TEXT NOT NULL, engagement_id TEXT NOT NULL, root_event_id TEXT,
  mode TEXT NOT NULL DEFAULT 'direct', since_ts INTEGER NOT NULL DEFAULT 0,
  private_root_event_id TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,agent_name)
);
INSERT OR IGNORE INTO matrix_agent_rooms(room_id,agent_name,human_mxid,project_room_id,engagement_id,root_event_id,created_at)
  SELECT room_id,agent_name,human_mxid,project_room_id,engagement_id,root_event_id,created_at FROM matrix_direct_rooms;
CREATE TABLE IF NOT EXISTS dispatch_conversation_visibility (
  dispatch_id TEXT PRIMARY KEY, since_ts INTEGER NOT NULL
);
`;
