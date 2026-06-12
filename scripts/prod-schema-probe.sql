-- Production schema probes — run against live Postgres (read-only session).
-- Canonical migrations are idempotent DDL in packages/api/src/db/schema.ts;
-- there is no schema_migrations version table on the deploy path.
-- Expected results are documented inline. Any mismatch blocks launch.

-- 1. Webhook idempotency index (migration 012_create_webhook_events)
-- EXPECTED: one row — idx_webhook_idempotency UNIQUE on (source, idempotency_key)
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'webhook_events'
  AND indexdef ILIKE '%idempotency_key%';

-- 2. Appointment double-booking EXCLUDE constraint (migration 131)
-- EXPECTED: no_double_booking
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'appointment_assignments'::regclass
  AND contype = 'x';

-- 3. RLS FORCE audit — tables with RLS enabled but NOT forced
-- EXPECTED: ZERO rows (owner bypass would silently break tenant isolation)
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = true
  AND c.relforcerowsecurity = false;

-- 4. Tenant-scoped tables missing RLS entirely
-- EXPECTED: only documented exempt tables (oauth_states, platform_deprovision_log)
SELECT DISTINCT c.table_name
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_name = c.table_name AND t.table_schema = c.table_schema
WHERE c.table_schema = 'public'
  AND c.column_name = 'tenant_id'
  AND t.table_type = 'BASE TABLE'
  AND c.table_name NOT IN ('oauth_states', 'platform_deprovision_log')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class pc
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE pn.nspname = 'public'
      AND pc.relname = c.table_name
      AND pc.relrowsecurity = true
  )
ORDER BY c.table_name;

-- 5. Recent migration artifact spot-check (migration 132_customer_consent_status)
-- EXPECTED: consent_status column on customers
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'customers'
  AND column_name = 'consent_status';

-- 6. webhook_events table exists with expected columns
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'webhook_events'
ORDER BY ordinal_position;
