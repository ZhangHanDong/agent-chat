export declare const FILE_REPLY_SCHEMA = "CREATE TABLE IF NOT EXISTS file_replies (\n  command_id TEXT PRIMARY KEY REFERENCES notice_outbox(command_id),\n  request_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,\n  manifest_json TEXT NOT NULL, prepared_json TEXT\n);";
export interface FileReplyManifest {
    path: string;
    name: string;
    mime: string;
    kind: 'image' | 'file';
    size: number;
    sha256: string;
}
export interface FileReplyRow {
    command_id: string;
    request_key: string;
    request_digest: string;
    manifest_json: string;
    prepared_json: string | null;
}
export interface FileReplyResult {
    deliveryId: string;
    status: 'queued' | 'delivered' | 'failed';
    filename: string;
    size: number;
    sha256: string;
    eventId: string | null;
    errorCode: string | null;
}
