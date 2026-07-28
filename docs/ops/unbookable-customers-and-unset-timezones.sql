-- Diagnostics for the two 2026-07-28 booking defects.
--
-- READ-ONLY. Nothing here writes. Both queries exist because the fixes
-- deliberately do NOT rewrite existing tenant data: in each case a wrong value
-- and a correct value are byte-identical in the database, so only a human can
-- tell them apart.
--
-- Run against a read replica if you have one. Every query is tenant-scoped by
-- the RLS policy on the underlying tables, so run them as a superuser or with
-- `SET app.current_tenant_id` when you want a single tenant.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CUSTOMERS THAT CANNOT BE BOOKED
--
-- `jobs.location_id` is NOT NULL, so a customer with zero non-archived
-- `service_locations` rows cannot have a job created and therefore cannot have
-- an appointment. Booking one fails at execution with
--   "Customer has no service location — add one before booking a new job"
--
-- The drafting handler now gates these at DRAFT time instead, but that only
-- helps the NEXT booking. This lists the customers already in that state so
-- you can decide whether to backfill.
--
-- `recovered_address` is the spoken address, if it survived anywhere:
--   * `communication_notes` — written by CreateCustomerExecutionHandler when
--     an address was too incomplete to become a service_location (the fix
--     shipped earlier today; Jimmy Hartlett's case).
--   * the originating proposal's transcript — the only remaining source for
--     customers created BEFORE that fix (Ashia Aksuna's case).
--
-- A row with a NULL recovered_address has no address anywhere and will need a
-- phone call.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    c.tenant_id,
    c.id                AS customer_id,
    c.display_name,
    c.primary_phone,
    c.created_at,

    -- Address preserved on the customer by the voice create path.
    substring(c.communication_notes FROM 'Address from voice: "([^"]+)"')
                        AS address_from_notes,

    -- Fallback: the transcript of the proposal that created this customer.
    -- `sourceContext` is JSONB; the voice path stores the utterance verbatim.
    (
        SELECT p.source_context ->> 'transcript'
        FROM proposals p
        WHERE p.tenant_id = c.tenant_id
          AND p.proposal_type = 'create_customer'
          AND p.source_context ->> 'transcript' IS NOT NULL
          -- Match the proposal to the customer it produced. Executed
          -- proposals record the created id; fall back to a name match for
          -- older rows that predate result_entity_id.
          AND (
                p.result_entity_id = c.id::text
             OR p.payload ->> 'name' = c.display_name
          )
        ORDER BY p.created_at DESC
        LIMIT 1
    )                   AS transcript_from_proposal,

    -- How many bookings have already died on this customer.
    (
        SELECT count(*)
        FROM proposals p2
        WHERE p2.tenant_id = c.tenant_id
          AND p2.proposal_type = 'create_appointment'
          AND p2.status = 'failed'
          AND p2.payload ->> 'customerId' = c.id::text
    )                   AS failed_booking_attempts

FROM customers c
WHERE c.is_archived = false
  AND NOT EXISTS (
        SELECT 1
        FROM service_locations sl
        WHERE sl.tenant_id  = c.tenant_id
          AND sl.customer_id = c.id
          AND sl.is_archived = false
      )
ORDER BY failed_booking_attempts DESC, c.created_at DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. TENANTS WHOSE TIMEZONE MAY NEVER HAVE BEEN CHOSEN
--
-- `tenant_settings.timezone` was `NOT NULL DEFAULT 'America/New_York'` until
-- migration 263. A tenant that never submitted a zone at onboarding therefore
-- reads back a perfectly valid Eastern zone, which is why an America/Phoenix
-- operator had every spoken booking land three hours early with nothing
-- downstream able to detect it.
--
-- Migration 263 drops the default and the NOT NULL so FUTURE tenants can be
-- distinguished, but it deliberately does not touch existing rows: a stored
-- 'America/New_York' may be a real Eastern tenant's genuine choice, and no
-- query can tell the two apart. This surfaces the candidates and the evidence
-- for a human decision.
--
-- The strongest signal is the mismatch column: an Eastern-stamped tenant whose
-- appointments cluster outside plausible Eastern working hours is almost
-- certainly in another zone.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    ts.tenant_id,
    ts.business_name,
    ts.timezone,
    ts.updated_at       AS settings_last_updated,

    -- A zip in the service area is the cheapest independent read on where the
    -- business actually is.
    ts.service_area_zips,
    ts.service_address,

    (
        SELECT count(*)
        FROM appointments a
        WHERE a.tenant_id = ts.tenant_id
    )                   AS appointment_count,

    -- Appointments whose LOCAL start hour (in the stored zone) falls outside
    -- 06:00–20:00. A tenant booking "10am" who shows up as 7am or 7pm here is
    -- being resolved in the wrong zone.
    (
        SELECT count(*)
        FROM appointments a
        WHERE a.tenant_id = ts.tenant_id
          AND (
                extract(hour FROM a.scheduled_start AT TIME ZONE ts.timezone) < 6
             OR extract(hour FROM a.scheduled_start AT TIME ZONE ts.timezone) > 20
          )
    )                   AS implausible_local_hours

FROM tenant_settings ts
WHERE ts.timezone IS NULL              -- post-263: definitively never chosen
   OR ts.timezone = 'America/New_York' -- pre-263: possibly just the old default
ORDER BY implausible_local_hours DESC, appointment_count DESC;
