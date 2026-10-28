-- Preserve the transport used for a successful hand-off. NULL means historical evidence is
-- unavailable; never backfill from the server's current email provider.
ALTER TABLE emails ADD COLUMN accepted_transport TEXT;
