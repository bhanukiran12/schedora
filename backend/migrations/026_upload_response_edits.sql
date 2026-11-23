ALTER TABLE form_uploads ADD COLUMN edit_response_id TEXT;
CREATE INDEX form_uploads_edit_response ON form_uploads(edit_response_id);
