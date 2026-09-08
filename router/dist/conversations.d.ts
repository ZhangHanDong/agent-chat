import type Database from 'better-sqlite3';
export declare const CONVERSATION_SCHEMA = "\nCREATE TABLE IF NOT EXISTS room_conversation_events (\n  seq INTEGER PRIMARY KEY AUTOINCREMENT,\n  room_id TEXT NOT NULL, event_id TEXT NOT NULL, sender_mxid TEXT NOT NULL,\n  body TEXT NOT NULL, event_ts INTEGER NOT NULL, thread_root TEXT,\n  UNIQUE(room_id, event_id)\n);\nCREATE INDEX IF NOT EXISTS room_conversation_order ON room_conversation_events(room_id, seq);\nCREATE TABLE IF NOT EXISTS room_conversation_files (\n  room_id TEXT NOT NULL, event_id TEXT NOT NULL, manifest_json TEXT NOT NULL,\n  PRIMARY KEY(room_id,event_id),\n  FOREIGN KEY(room_id,event_id) REFERENCES room_conversation_events(room_id,event_id)\n);\nCREATE TABLE IF NOT EXISTS room_conversation_positions (\n  room_id TEXT NOT NULL, agent_id TEXT NOT NULL, through_seq INTEGER NOT NULL,\n  PRIMARY KEY(room_id, agent_id)\n);\nCREATE TABLE IF NOT EXISTS dispatch_conversations (\n  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id),\n  room_id TEXT NOT NULL, agent_id TEXT NOT NULL, from_seq INTEGER NOT NULL,\n  through_seq INTEGER NOT NULL, read_parts INTEGER NOT NULL DEFAULT 0\n);\nCREATE TABLE IF NOT EXISTS matrix_direct_rooms (\n  room_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, human_mxid TEXT NOT NULL,\n  project_room_id TEXT NOT NULL, engagement_id TEXT NOT NULL, root_event_id TEXT,\n  created_at INTEGER NOT NULL\n);\nCREATE TABLE IF NOT EXISTS matrix_agent_rooms (\n  room_id TEXT NOT NULL, agent_name TEXT NOT NULL, human_mxid TEXT NOT NULL,\n  project_room_id TEXT NOT NULL, engagement_id TEXT NOT NULL, root_event_id TEXT,\n  mode TEXT NOT NULL DEFAULT 'direct', since_ts INTEGER NOT NULL DEFAULT 0,\n  private_root_event_id TEXT, created_at INTEGER NOT NULL,\n  PRIMARY KEY(room_id,agent_name)\n);\nINSERT OR IGNORE INTO matrix_agent_rooms(room_id,agent_name,human_mxid,project_room_id,engagement_id,root_event_id,created_at)\n  SELECT room_id,agent_name,human_mxid,project_room_id,engagement_id,root_event_id,created_at FROM matrix_direct_rooms;\nCREATE TABLE IF NOT EXISTS dispatch_conversation_visibility (\n  dispatch_id TEXT PRIMARY KEY, since_ts INTEGER NOT NULL\n);\n";
export type DirectRoom = {
    roomId: string;
    agent: string;
    humanMxid: string;
    projectRoomId: string;
    engagementId: string;
    rootEventId: string | null;
    mode?: 'direct' | 'group';
    sinceTs?: number;
    privateRootEventId?: string | null;
};
/** Shares the router connection: range snapshots and successful delivery commit atomically. */
export declare class ConversationStore {
    private db;
    constructor(db: Database.Database);
    archive(input: {
        roomId: string;
        eventId: string;
        senderMxid: string;
        body: string;
        timestamp: number;
        threadRoot?: string | null;
        attachment?: Readonly<Record<string, unknown>>;
    }): {
        seq: number;
        replayed: boolean;
    };
    prepare(dispatchId: string, roomId: string, agentId: string): Record<string, unknown> | null;
    page(dispatchId: string, offset?: number): {
        messages: never[];
        next: null;
        totalMessages: number;
        totalParts: number;
        roomId?: never;
    } | {
        roomId: string;
        messages: {
            eventId: string;
            sender: string;
            timestamp: number;
            threadRoot: string | null;
            part: number;
            parts: number;
            attachment?: {
                eventId: string;
                name: unknown;
                mime: unknown;
                size: unknown;
                errorCode?: {};
                error?: unknown;
                instruction: string;
            };
            body: string;
        }[];
        next: number | null;
        totalMessages: number;
        totalParts: number;
    };
    delivered(dispatchId: string): boolean;
    private since;
    private archiveFile;
    private file;
    receivedFile(dispatchId: string, eventId: string): Record<string, unknown> | null;
    roomBindings(roomId: string): DirectRoom[];
    direct(roomId: string, agent?: string): DirectRoom | null;
    promoteRoom(roomId: string, sinceTs: number): void;
    bindDirect(input: Omit<DirectRoom, 'rootEventId'>): DirectRoom;
    directRoot(roomId: string, eventId: string, agent?: string): string;
}
