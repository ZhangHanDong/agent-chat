import { type LegacyTask } from './task-repository.js';
import type { RouterStore } from './store.js';
import type { CapabilityInput, Refusal } from './types.js';
export interface TaskOperationInput extends CapabilityInput {
    action: string;
    taskId?: string;
    toolCallId?: string;
    patch?: Readonly<Record<string, unknown>>;
}
export type TaskOperationResult = Refusal | {
    ok: true;
    replayed: boolean;
    task?: LegacyTask;
    tasks?: LegacyTask[];
};
/** Called only inside the store's capability-validated transaction. */
export declare function applyTaskOperation(router: RouterStore, input: TaskOperationInput, sessionId: string, boundTaskId: string | null): TaskOperationResult;
