-- Live workspace onboarding state: tracks chosen products, optional skips and draft record links.
-- Readiness is always derived from actual saved records (event_types, forms, flows, calendars, schedules),
-- never from flags in this table.
CREATE TABLE workspace_onboarding (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  selected_products TEXT NOT NULL DEFAULT '["meet","forms","flow"]',
  active_product TEXT NOT NULL DEFAULT 'meet' CHECK (active_product IN ('meet', 'forms', 'flow')),
  active_step TEXT NOT NULL DEFAULT 'products',
  meet_calendar_skipped INTEGER NOT NULL DEFAULT 0,
  meet_event_type_id TEXT REFERENCES event_types(id) ON DELETE SET NULL,
  forms_form_id TEXT REFERENCES forms(id) ON DELETE SET NULL,
  flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
