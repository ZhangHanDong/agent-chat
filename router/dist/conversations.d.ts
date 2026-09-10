import type Database from 'better-sqlite3';
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
    cacheReceivedFile(dispatchId: string, eventId: string, file: Readonly<Record<string, unknown>>): void;
    setAdmission(roomId: string, agentName: string, sinceTs: number): void;
    roomBindings(roomId: string): DirectRoom[];
    direct(roomId: string, agent?: string): DirectRoom | null;
    promoteRoom(roomId: string, sinceTs: number): void;
    bindDirect(input: Omit<DirectRoom, 'rootEventId'>): DirectRoom;
    directRoot(roomId: string, eventId: string, agent?: string): string;
}
