const LABELS = {
    command: '运行命令', files: '读取或修改文件', search: '搜索资料', delegate: '委派任务', tool: '调用工具',
};
/** A delivery projection only. Routing and lifecycle authority remain in RouterStore. */
export class ActivityStore {
    db;
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS runner_activity (
      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id), phase TEXT NOT NULL,
      kind TEXT, tools INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, anchor TEXT
    );
    CREATE TABLE IF NOT EXISTS runner_activity_events (
      dispatch_id TEXT NOT NULL REFERENCES runner_activity(dispatch_id), event_key TEXT NOT NULL,
      PRIMARY KEY(dispatch_id, event_key)
    );`);
    }
    read(dispatchId) {
        return this.db.prepare('SELECT * FROM runner_activity WHERE dispatch_id = ?').get(dispatchId);
    }
    update(dispatchId, event, now) {
        const previous = this.read(dispatchId);
        if (previous && ['completed', 'interrupted'].includes(previous.phase))
            return null;
        if (!previous && event.phase !== 'started')
            return null;
        if (previous && event.phase === 'started')
            return null;
        let row = previous ?? {
            dispatch_id: dispatchId, phase: 'started', kind: null, tools: 0, finished: 0,
            started_at: now, updated_at: now, queued_at: now, revision: 0, anchor: null,
        };
        if (!previous)
            this.db.prepare(`INSERT INTO runner_activity
      (dispatch_id, phase, started_at, updated_at, queued_at) VALUES (?, 'started', ?, ?, ?)`)
                .run(dispatchId, now, now, now);
        if (event.phase === 'tool_start' || event.phase === 'tool_end') {
            if (!Object.hasOwn(LABELS, event.kind))
                return null;
            if (event.phase === 'tool_end' && !this.db.prepare('SELECT 1 FROM runner_activity_events WHERE dispatch_id = ? AND event_key = ?')
                .get(dispatchId, `tool_start:${event.eventId}`))
                return null;
            const inserted = this.db.prepare(`INSERT OR IGNORE INTO runner_activity_events VALUES (?, ?)`)
                .run(dispatchId, `${event.phase}:${event.eventId}`);
            if (!inserted.changes)
                return null;
            row = { ...row, phase: event.phase, kind: event.kind,
                tools: row.tools + Number(event.phase === 'tool_start'), finished: row.finished + Number(event.phase === 'tool_end') };
        }
        else if (event.phase !== 'heartbeat')
            row = { ...row, phase: event.phase, kind: null };
        const immediate = ['started', 'waiting', 'resumed', 'completed', 'interrupted'].includes(event.phase)
            || (event.phase === 'tool_start' && row.tools === 1);
        const due = immediate || now - row.queued_at >= (event.phase === 'heartbeat' ? 30_000 : 5_000);
        this.db.prepare(`UPDATE runner_activity SET phase = ?, kind = ?, tools = ?, finished = ?, updated_at = ? WHERE dispatch_id = ?`)
            .run(row.phase, row.kind, row.tools, row.finished, now, dispatchId);
        if (!due)
            return null;
        const revision = row.revision + 1;
        this.db.prepare('UPDATE runner_activity SET queued_at = ?, revision = ? WHERE dispatch_id = ?').run(now, revision, dispatchId);
        const phase = row.phase === 'waiting' ? '等待负责人授权；请在私人审批房间处理'
            : row.phase === 'completed' ? '本轮处理已结束'
                : row.phase === 'interrupted' ? '执行已中断，结果待确认'
                    : row.phase === 'resumed' ? '已收到审批决定，继续处理'
                        : row.phase === 'tool_start' ? `正在${LABELS[row.kind ?? 'tool']}`
                            : row.phase === 'tool_end' ? '工具调用已返回，继续处理'
                                : '已开始处理，等待运行器的下一步事件';
        const elapsed = Math.max(0, Math.floor((now - row.started_at) / 1000));
        const icon = row.phase === 'completed' ? '✅' : row.phase === 'interrupted' ? '⚠️' : row.phase === 'waiting' ? '⏸️' : '⏳';
        return { revision, body: `${icon} ${phase}\n已运行 ${elapsed} 秒 · 工具调用 ${row.tools} 次，已返回 ${row.finished} 次` };
    }
    delivered(dispatchId, eventId) {
        this.db.prepare('UPDATE runner_activity SET anchor = COALESCE(anchor, ?) WHERE dispatch_id = ?').run(eventId, dispatchId);
    }
}
