import type { ActivityEvent, ToolKind } from './activity.js';
export declare function codexActivity(method: string, params: Readonly<Record<string, unknown>>, threadId: string, turnId: string): ActivityEvent | null;
export declare function claudeActivity(event: Readonly<Record<string, unknown>>, activeTools: Map<string, ToolKind>): ActivityEvent[];
