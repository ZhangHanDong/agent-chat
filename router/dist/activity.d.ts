export declare const RUNNER_ACTIVITY_SCHEMA = "CREATE TABLE IF NOT EXISTS runner_activity (\n      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id), phase TEXT NOT NULL,\n      kind TEXT, tools INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,\n      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER NOT NULL,\n      revision INTEGER NOT NULL DEFAULT 0, anchor TEXT\n    );\n    CREATE TABLE IF NOT EXISTS runner_activity_events (\n      dispatch_id TEXT NOT NULL REFERENCES runner_activity(dispatch_id), event_key TEXT NOT NULL,\n      PRIMARY KEY(dispatch_id, event_key)\n    );";
import type Database from 'better-sqlite3';
export type ToolKind = 'command' | 'files' | 'search' | 'delegate' | 'tool';
export type ActivityEvent = {
    phase: 'started' | 'heartbeat' | 'waiting' | 'resumed' | 'completed' | 'interrupted';
} | {
    phase: 'tool_start' | 'tool_end';
    kind: ToolKind;
    eventId: string;
};
type ActivityRow = {
    dispatch_id: string;
    phase: string;
    kind: ToolKind | null;
    tools: number;
    finished: number;
    started_at: number;
    updated_at: number;
    queued_at: number;
    revision: number;
    anchor: string | null;
};
/** A delivery projection only. Routing and lifecycle authority remain in RouterStore. */
export declare class ActivityStore {
    private readonly db;
    constructor(db: Database.Database);
    read(dispatchId: string): ActivityRow | undefined;
    update(dispatchId: string, event: ActivityEvent, now: number): {
        revision: number;
        body: string;
    } | null;
    delivered(dispatchId: string, eventId: string): void;
}
export {};
