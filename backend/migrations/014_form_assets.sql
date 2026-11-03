-- Host-authored images for forms (docs/FORMS.md, "Media"). Additive: older releases ignore these tables.
-- Bytes are validated, metadata-stripped raster images, stored base64-encoded so the SQLite and the
-- PostgreSQL bridge store and return them identically. Never respondent uploads.
CREATE TABLE form_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX form_assets_workspace ON form_assets (workspace_id, created_at);

-- Which assets each published version shows. A version's images stay available for as long as the
-- version exists, whatever later drafts do; the public image route serves only assets listed here
-- for a form that is currently collecting responses.
CREATE TABLE form_version_assets (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES form_assets(id) ON DELETE CASCADE,
  PRIMARY KEY (form_id, version, asset_id)
);
CREATE INDEX form_version_assets_asset ON form_version_assets (asset_id);
