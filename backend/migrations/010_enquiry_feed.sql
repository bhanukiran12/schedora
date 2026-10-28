-- Workspace-wide enquiry feed: keyset pagination by arrival time, and follow-ups by subject.
CREATE INDEX responses_workspace_arrival ON responses(workspace_id, created_at, id);
CREATE INDEX bookings_workspace_arrival ON bookings(workspace_id, created_at, id);
CREATE INDEX flow_runs_subject ON flow_runs(workspace_id, subject_id);
CREATE INDEX tasks_source_run ON tasks(source_run_id);
