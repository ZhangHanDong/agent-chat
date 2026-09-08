import { createHash } from 'node:crypto';
const CODEX_TOOLS = {
    commandExecution: 'command', fileChange: 'files', webSearch: 'search',
    mcpToolCall: 'tool', dynamicToolCall: 'tool', collabAgentToolCall: 'delegate',
};
const CLAUDE_TOOLS = {
    Bash: 'command', Read: 'files', Write: 'files', Edit: 'files', MultiEdit: 'files',
    Glob: 'files', Grep: 'search', WebSearch: 'search', WebFetch: 'search', Task: 'delegate', Agent: 'delegate',
};
const key = (id) => createHash('sha256').update(id).digest('hex');
export function codexActivity(method, params, threadId, turnId) {
    if (!threadId || !turnId || params.threadId !== threadId || params.turnId !== turnId)
        return null;
    if (method !== 'item/started' && method !== 'item/completed')
        return null;
    const item = params.item;
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || !Object.hasOwn(CODEX_TOOLS, item.type))
        return null;
    return { phase: method === 'item/started' ? 'tool_start' : 'tool_end', kind: CODEX_TOOLS[item.type], eventId: key(item.id) };
}
export function claudeActivity(event, activeTools) {
    const message = event.message;
    if (!message || !Array.isArray(message.content))
        return [];
    const activities = [];
    for (const block of message.content) {
        if (event.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
            const kind = Object.hasOwn(CLAUDE_TOOLS, block.name) ? CLAUDE_TOOLS[block.name] : 'tool';
            activeTools.set(block.id, kind);
            activities.push({ phase: 'tool_start', kind, eventId: key(block.id) });
        }
        else if (event.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const kind = activeTools.get(block.tool_use_id);
            if (!kind)
                continue;
            activities.push({ phase: 'tool_end', kind, eventId: key(block.tool_use_id) });
            activeTools.delete(block.tool_use_id);
        }
    }
    return activities;
}
