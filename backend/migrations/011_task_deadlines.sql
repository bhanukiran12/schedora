-- tasks.due_at and tasks.assignee_id exist since 002 (contact follow-ups); Flow tasks now use them
-- too. This index serves "assigned to me" and deadline ordering.
CREATE INDEX tasks_assignee ON tasks(workspace_id, assignee_id, status);
