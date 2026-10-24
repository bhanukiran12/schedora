# Supabase PostgreSQL storage
Updated 24 October 2026.

## Connection
Render DATABASE_URL selects PostgreSQL. Use the Supabase session-pooler URL on port 5432. The server refuses to silently fall back to SQLite if PostgreSQL fails. DATABASE_PATH remains the local-development fallback only when DATABASE_URL is absent.

The bundled certs/supabase-ca.crt is the public root certificate linked by the Supabase project's Database Settings page. TLS hostname and chain verification remain enabled. DATABASE_CA_CERT can override the trusted CA for another PostgreSQL host. Do not disable certificate verification to work around connection failures.

## Schema and migrations
Schedora stores its tables in the dedicated schedora schema, outside public. PostgreSQL migrations initialize the final application schema from the existing SQLite migration chain, move foreign keys to a second phase, use BIGINT for millisecond timestamps, and install PostgreSQL overlap protection. Migration transactions roll back on failure; unexpected pre-existing tables stop initialization. Other schemas are not modified. An explicit postgres_v1 migration marker prevents reinitialization.

This release establishes a PostgreSQL baseline. Future schema changes require explicit PostgreSQL migration steps; changes to the SQLite migration chain alone do not upgrade an existing PostgreSQL baseline. Existing SQLite accounts and bookings are NOT automatically copied into Supabase. Back up/export any required SQLite data before redeployment. Fresh Supabase users register using the regular Schedora account flow; Supabase Auth is not used.

## Adapter behavior and capacity
The current application uses synchronous database methods throughout. A persistent worker-thread PostgreSQL client preserves that interface and transaction boundaries; queries block the request thread until the worker returns. This is a compatibility bridge, not an asynchronous connection pool. It serializes application database transactions with a PostgreSQL advisory lock to preserve current SQLite write semantics. Keep one backend instance initially and measure latency/load before production traffic. A later async repository refactor is required for higher concurrency.

Connection/query timeouts fail visibly. A bridge timeout closes the connection rather than retrying an ambiguous write. Restart the service after a fatal database connection loss. Client retries must retain booking idempotency keys.

## Backups and secrets
SQLite backup/restore commands explicitly refuse to operate on the PostgreSQL deployment. Use PostgreSQL pg_dump/pg_restore, an off-site encrypted copy and a recorded isolated restore. Never pass database passwords as command-line arguments. Configure database credentials through secret environment variables.

A credential was discovered in the tracked .env.example and replaced with an empty setting. Rotate the exposed database password in Supabase and update Render DATABASE_URL; historical Git commits can still contain the old value. Do not paste the replacement into chat or commit it. Local .env files are ignored.

## Verification
Opt-in tests run against temporary schedora_test_* schemas created for the test and removed afterward. They never truncate or drop the production schedora schema. Run with RUN_POSTGRES_TESTS=true and a privately supplied DATABASE_URL. The ordinary suite still uses isolated SQLite databases.

After deployment /api/health must report storage: postgres. Confirm signup/login after a second service restart. Google integration and subscription/email provider verification remain separate.

## References
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://node-postgres.com/features/ssl
