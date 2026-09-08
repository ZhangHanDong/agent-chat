// A completed canonical task can reopen for a new human follow-up. Task-scoped
// grants from its previous work must never become active again, even if nobody
// read the approval store between completion and reopening.
export const TASK_AUTHORIZATION_EPOCH_SCHEMA = `
ALTER TABLE tasks ADD COLUMN execution_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER tasks_finish_execution_epoch AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status != 'done'
BEGIN
  UPDATE tasks SET execution_epoch = OLD.execution_epoch + 1 WHERE task_id = NEW.task_id;
END;
`;
