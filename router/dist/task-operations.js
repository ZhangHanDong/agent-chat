import { createHash } from 'node:crypto';
import { createRouterTaskStore } from './task-repository.js';
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    }
    return value;
}
/** Called only inside the store's capability-validated transaction. */
export function applyTaskOperation(router, input, sessionId, boundTaskId) {
    const refuse = (message, code = 'bad_request') => ({ ok: false, code, message });
    const session = router.db.prepare('SELECT agent_id, agent_name, room_id, thread_root_event_id FROM sessions WHERE session_id = ?').get(sessionId);
    if (!session)
        return refuse('runner session is missing');
    const store = createRouterTaskStore(router);
    const visibleIds = new Set(router.db.prepare(`SELECT b.task_id FROM task_bindings b JOIN dispatches d ON b.request_scope = 'dispatch:' || d.dispatch_id WHERE d.session_id = ?`).all(sessionId).map(row => row.task_id));
    if (boundTaskId)
        visibleIds.add(boundTaskId);
    const patch = input.patch ?? {};
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
        return refuse('patch must be an object');
    if (input.action === 'list') {
        let tasks = [...visibleIds].map(id => store.getTask(id)).filter((task) => task !== null);
        if (typeof patch.assignee === 'string' && patch.assignee !== '*')
            tasks = tasks.filter(task => task.assignee === patch.assignee);
        if (typeof patch.status === 'string') {
            const statuses = patch.status.split(',').map(s => s.trim());
            tasks = tasks.filter(task => statuses.includes(task.status));
        }
        if (typeof patch.priority === 'string')
            tasks = tasks.filter(task => task.priority === patch.priority);
        if (typeof patch.label === 'string')
            tasks = tasks.filter(task => task.labels.includes(String(patch.label)));
        const offset = Number.isSafeInteger(patch.offset) && Number(patch.offset) >= 0 ? Number(patch.offset) : 0;
        const limit = Number.isSafeInteger(patch.limit) && Number(patch.limit) > 0 ? Math.min(500, Number(patch.limit)) : 500;
        return { ok: true, replayed: false, tasks: tasks.slice(offset, offset + limit) };
    }
    if (!input.taskId || !visibleIds.has(input.taskId))
        return refuse('task is outside the runner session', 'missing_task_credential');
    const task = store.getTask(input.taskId);
    if (!task)
        return refuse('task not found', 'not_found');
    if (input.action === 'get')
        return { ok: true, replayed: false, task };
    const binding = router.db.prepare('SELECT assignee_agent_id, room_id, thread_root_event_id, activation_state FROM task_bindings WHERE task_id = ?').get(input.taskId);
    if (input.taskId !== boundTaskId || task.assignee !== session.agent_name || !binding
        || binding.assignee_agent_id !== session.agent_id || binding.room_id !== session.room_id
        || binding.thread_root_event_id !== session.thread_root_event_id || binding.activation_state !== 'active') {
        return refuse('only the active task assignee may change this task', 'missing_task_credential');
    }
    if (!['accept', 'transition', 'comment', 'execution'].includes(input.action))
        return refuse('unknown task operation');
    if (typeof input.toolCallId !== 'string' || !input.toolCallId.trim() || input.toolCallId.length > 512)
        return refuse('tool_call_id is required');
    const payloadDigest = createHash('sha256').update(JSON.stringify(canonical({ action: input.action, taskId: input.taskId, patch }))).digest('hex');
    const previous = router.db.prepare('SELECT payload_digest, response_json FROM runner_task_operations WHERE dispatch_id = ? AND tool_call_id = ?').get(input.dispatchId, input.toolCallId);
    if (previous) {
        if (previous.payload_digest !== payloadDigest)
            return refuse('tool call id already used with different content', 'idempotency_conflict');
        const result = JSON.parse(previous.response_json);
        return { ok: true, replayed: true, task: result.task };
    }
    let updated;
    if (input.action === 'accept')
        updated = store.transitionTask(input.taskId, 'accepted');
    else if (input.action === 'transition')
        updated = store.transitionTask(input.taskId, String(patch.status ?? ''), patch);
    else if (input.action === 'comment')
        updated = store.addComment(input.taskId, { text: patch.text, author: session.agent_name });
    else
        updated = store.updateTaskExecution(input.taskId, patch);
    const result = { ok: true, replayed: false, task: updated };
    router.db.prepare('INSERT INTO runner_task_operations(dispatch_id, tool_call_id, payload_digest, response_json) VALUES (?, ?, ?, ?)').run(input.dispatchId, input.toolCallId, payloadDigest, JSON.stringify(result));
    return result;
}
