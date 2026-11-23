CREATE TABLE booking_message_consent (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  whatsapp INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);
