/**
 * Shared helpers for the #1014 §8.2 Capture rung-5 reachability specs
 * (lane C — test/8-2-capture-r5). Builds on `e2e/fixtures/twilio-phone-lane.ts`
 * (provisionTenant / signedPost / sessionIdFromTwiml / devAuthBearerToken /
 * pollFor) and `e2e/fixtures/twilio-sms-lane.ts` (signedSmsPost /
 * createCustomerViaApi) exactly as the merged §8.3/§8.4 phone lanes do —
 * this file only adds the row-specific DB read-back helpers §8.2 needs on
 * top, so each spec file stays focused on driving the webhook rather than
 * re-deriving SQL.
 */
import type { Pool } from 'pg';
import { pollFor } from './twilio-phone-lane';

export {
  API_URL,
  SIGNING_BASE,
  signedPost,
  sessionIdFromTwiml,
  provisionTenant,
  devAuthBearerToken,
  pollFor,
  stripTrailingSlash,
  type ProvisionedTenant,
} from './twilio-phone-lane';
export {
  signedSmsPost,
  smsWebhookPath,
  createCustomerViaApi,
  createLocationViaApi,
  createScheduledJobViaApi,
  insertTechnician,
  laterTodaySlots,
} from './twilio-sms-lane';

/** `normalizePhone` (packages/api/src/shared/phone.ts), reimplemented locally
 * so a spec can compute the expected `leads.phone_normalized` value without
 * importing server source into the Playwright process. Kept byte-identical
 * to the source. Drops a US country-code leading '1' (11 digits → 10) — this
 * is `leads.phone_normalized`'s convention ONLY (find-or-create-lead.ts).
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * `normalizeConsentPhone` (packages/api/src/compliance/consent-events.ts)
 * and the `customers.phone_normalized` GENERATED COLUMN (migration 053:
 * `regexp_replace(primary_phone, '[^0-9]', '', 'g')`) both strip
 * non-digit characters ONLY — neither drops a leading US country-code '1'.
 * This is DIFFERENT from `normalizePhone` above (`leads.phone_normalized`'s
 * convention) — verified directly against a real `consent_events` row
 * during this lane's own debugging (stored `"15125557788"` for
 * `+15125557788`, not `"5125557788"`). Use this helper for `consent_events`
 * and `customers` lookups; use `normalizePhone` above for `leads` lookups.
 */
export function stripNonDigits(phone: string): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** A `leads` row for this tenant + normalized phone (0 or 1 rows expected —
 * the partial unique index on (tenant_id, phone_normalized) while open). */
export async function leadRows(pool: Pool, tenantId: string, phoneNormalized: string) {
  const { rows } = await pool.query<{
    id: string;
    source: string;
    phone_normalized: string;
    primary_phone: string;
  }>(
    `SELECT id, source, phone_normalized, primary_phone FROM leads
      WHERE tenant_id = $1 AND phone_normalized = $2`,
    [tenantId, phoneNormalized],
  );
  return rows;
}

/** `audit_events` rows matching an exact event_type for this tenant. */
export async function auditRows(pool: Pool, tenantId: string, eventType: string) {
  const { rows } = await pool.query<{
    id: string;
    event_type: string;
    entity_type: string;
    entity_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, event_type, entity_type, entity_id, metadata FROM audit_events
      WHERE tenant_id = $1 AND event_type = $2
      ORDER BY created_at ASC`,
    [tenantId, eventType],
  );
  return rows;
}

/**
 * The customer-timeline `system_event` message `logInboundCallOnCustomerTimeline`
 * (packages/api/src/telephony/inbound-call-log.ts) appends, awaited inline
 * inside `handleInbound` BEFORE the `/voice` response is built — i.e. it is
 * the positive, in-request proof that a caller was identified as this
 * customer (there is no dedicated "identified" audit event; see the lane
 * report). `metadata->>'callSid'` ties the row to one specific call.
 */
export async function inboundCallTimelineMessages(
  pool: Pool,
  tenantId: string,
  customerId: string,
  callSid: string,
) {
  const { rows } = await pool.query<{ content: string; metadata: Record<string, unknown> }>(
    `SELECT m.content, m.metadata
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.tenant_id = $1 AND c.entity_type = 'customer' AND c.entity_id = $2
        AND m.metadata->>'callSid' = $3`,
    [tenantId, customerId, callSid],
  );
  return rows;
}

/** `voice_sessions` row for a CallSid (tenant-scoped read). */
export async function voiceSessionRow(pool: Pool, tenantId: string, callSid: string) {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    customer_id: string | null;
    state: string;
  }>(
    `SELECT id, tenant_id, customer_id, state FROM voice_sessions
      WHERE tenant_id = $1 AND call_sid = $2`,
    [tenantId, callSid],
  );
  return rows;
}

/** `consent_events` rows for a tenant + normalized caller phone. */
export async function consentEventRows(pool: Pool, tenantId: string, phoneNormalized: string) {
  const { rows } = await pool.query<{
    kind: string;
    state: string;
    source: string;
    voice_session_id: string | null;
  }>(
    `SELECT kind, state, source, voice_session_id FROM consent_events
      WHERE tenant_id = $1 AND phone_normalized = $2
      ORDER BY created_at ASC`,
    [tenantId, phoneNormalized],
  );
  return rows;
}

/** `triage_events` rows for a tenant (row-dump helper for row 2.6). */
export async function triageEventRows(pool: Pool, tenantId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM triage_events WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows;
}

/** Re-exported for specs that need a bounded poll on one of the helpers
 * above (e.g. `pollFor(pool, 'SELECT ... FROM leads WHERE ...', [...])`). */
export { pollFor as pollForRows };
