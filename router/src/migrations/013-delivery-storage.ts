import { RUNNER_ACTIVITY_SCHEMA } from '../activity.js';
import { FILE_REPLY_SCHEMA } from '../files.js';

export const DELIVERY_STORAGE_SCHEMA = RUNNER_ACTIVITY_SCHEMA + FILE_REPLY_SCHEMA + `
CREATE TABLE IF NOT EXISTS room_agent_history_boundaries (
  room_id TEXT NOT NULL, agent_name TEXT NOT NULL, since_ts INTEGER NOT NULL,
  PRIMARY KEY(room_id,agent_name)
);`;
