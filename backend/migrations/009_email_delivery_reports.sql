-- Delivery reports from the email provider's signed webhooks, matched by provider_message_id.
-- 'delivered' means the recipient's mail server accepted the message; inbox placement and reading
-- are never reported. NULL means no report was received.
ALTER TABLE emails ADD COLUMN delivery_status TEXT CHECK (delivery_status IN ('delayed', 'delivered', 'complained', 'bounced', 'provider_failed', 'suppressed'));
ALTER TABLE emails ADD COLUMN delivery_event_at INTEGER;
CREATE INDEX emails_provider_message ON emails(provider_message_id);

-- Webhook deliveries already processed (provider retries reuse the same key). No payload is kept.
CREATE TABLE email_provider_events (
  event_key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
