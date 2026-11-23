CREATE TABLE form_workbook_links (
  source_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  snapshot TEXT,
  PRIMARY KEY (source_id, target_id)
);

CREATE UNIQUE INDEX form_workbook_one_live_link ON form_workbook_links(source_id) WHERE snapshot IS NULL;
CREATE INDEX form_workbook_links_by_target ON form_workbook_links(target_id);
