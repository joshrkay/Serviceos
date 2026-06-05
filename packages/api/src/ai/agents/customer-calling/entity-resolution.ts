/**
 * QA-2026-06-05 (SCH-02/03) — real entity resolution for the calling agent.
 *
 * The phase-1 "auto-resolve" path passed raw classifier strings through as
 * resolved refs, so scheduling proposals carried entities like
 * `{ customerName: "Dana Rivera", dateTimeDescription: "next Tuesday at 2 PM" }`
 * and execution failed handler validation ('Payload must include a valid
 * jobId'). This module turns those references into concrete ids/timestamps:
 *
 *  - dateTimeDescription → scheduledStart/scheduledEnd (deterministic parser
 *    for the common dispatcher phrasings; 60-minute default window; UTC —
 *    tenant-timezone rendering is a presentation concern).
 *  - customerName → customerId via tenant-scoped display_name lookup
 *    (skipped for generic references like "our customer").
 *  - create_appointment/create_booking → jobId: explicit uuid if given, else
 *    the most recent active job for the resolved customer, else the tenant's
 *    most recent active job.
 *  - cancel/reschedule/confirm → appointmentId: explicit uuid if given, else
 *    the next upcoming non-terminal appointment, else the most recently
 *    created one.
 *
 * Best-effort by design: anything unresolvable stays absent and the proposal
 * surfaces for operator review (HITL is the safety net — never guess across
 * tenants, always tenant-scoped parameterized queries).
 */

import type { Pool } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const GENERIC_CUSTOMER_REFS = new Set([
  'our customer', 'the customer', 'a customer', 'customer', 'them', 'that customer', 'this customer',
]);

export interface ParsedWindow {
  scheduledStart: string;
  scheduledEnd: string;
}

/**
 * Parse common dispatcher datetime phrasings relative to `now`:
 * "today/tomorrow/next tuesday/this friday/tuesday" + "at 2 PM" / "at 14:30".
 * Returns undefined when nothing parseable is found — never guesses.
 */
export function parseNaturalDatetime(desc: string, now: Date = new Date(), durationMinutes = 60): ParsedWindow | undefined {
  const text = desc.toLowerCase();

  let dayOffset: number | undefined;
  if (/\btoday\b/.test(text)) dayOffset = 0;
  else if (/\btomorrow\b/.test(text)) dayOffset = 1;
  else {
    const wd = Object.keys(WEEKDAYS).find((w) => text.includes(w));
    if (wd) {
      const target = WEEKDAYS[wd];
      const current = now.getUTCDay();
      let ahead = (target - current + 7) % 7;
      // Bare/this/next weekday: always the NEXT occurrence (never today —
      // a dispatcher saying "Tuesday" on a Tuesday means next week).
      if (ahead === 0) ahead = 7;
      dayOffset = ahead;
    }
  }

  const timeMatch = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (dayOffset === undefined && !timeMatch) return undefined;

  let hour = 9; // default morning slot when only a day was given
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;
  }

  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (dayOffset ?? (timeMatch ? 1 : 0)),
    hour, minute, 0, 0,
  ));
  if (start.getTime() <= now.getTime()) start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

const SCHEDULING_CREATE_INTENTS = new Set(['create_appointment', 'create_booking']);
const APPOINTMENT_REF_INTENTS = new Set([
  'cancel_appointment', 'reschedule_appointment', 'confirm_appointment', 'reassign_appointment',
]);

export async function resolveSchedulingEntities(
  pool: Pool,
  tenantId: string,
  intent: string,
  entities: Record<string, unknown>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  const dt = typeof entities.dateTimeDescription === 'string'
    ? entities.dateTimeDescription
    : typeof entities.datetime === 'string' ? entities.datetime : undefined;
  if (dt && typeof entities.scheduledStart !== 'string') {
    const win = parseNaturalDatetime(dt);
    if (win) {
      resolved.scheduledStart = win.scheduledStart;
      resolved.scheduledEnd = win.scheduledEnd;
    }
  }

  // Customer by name — only for specific references.
  let customerId = typeof entities.customerId === 'string' && UUID_RE.test(entities.customerId)
    ? entities.customerId
    : undefined;
  const name = typeof entities.customerName === 'string' ? entities.customerName.trim() : undefined;
  if (!customerId && name && !GENERIC_CUSTOMER_REFS.has(name.toLowerCase())) {
    const r = await pool.query(
      `SELECT id FROM customers
       WHERE tenant_id = $1 AND is_archived = false AND display_name ILIKE $2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, `%${name}%`],
    );
    if (r.rows[0]?.id) customerId = r.rows[0].id as string;
  }
  if (customerId) resolved.customerId = customerId;

  if (SCHEDULING_CREATE_INTENTS.has(intent)) {
    let jobId = typeof entities.jobId === 'string' && UUID_RE.test(entities.jobId) ? entities.jobId : undefined;
    if (!jobId) {
      const r = await pool.query(
        `SELECT id FROM jobs
         WHERE tenant_id = $1
           AND status NOT IN ('completed', 'cancelled')
           ${customerId ? 'AND customer_id = $2' : ''}
         ORDER BY created_at DESC LIMIT 1`,
        customerId ? [tenantId, customerId] : [tenantId],
      );
      jobId = (r.rows[0]?.id as string) ?? undefined;
    }
    if (jobId) resolved.jobId = jobId;
  }

  if (APPOINTMENT_REF_INTENTS.has(intent)) {
    let appointmentId = typeof entities.appointmentId === 'string' && UUID_RE.test(entities.appointmentId)
      ? entities.appointmentId
      : undefined;
    if (!appointmentId) {
      const upcoming = await pool.query(
        `SELECT id FROM appointments
         WHERE tenant_id = $1
           AND status IN ('scheduled', 'confirmed')
           AND scheduled_start > now() - interval '1 hour'
         ORDER BY scheduled_start ASC LIMIT 1`,
        [tenantId],
      );
      appointmentId = (upcoming.rows[0]?.id as string) ?? undefined;
      if (!appointmentId) {
        const latest = await pool.query(
          `SELECT id FROM appointments
           WHERE tenant_id = $1 AND status IN ('scheduled', 'confirmed')
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId],
        );
        appointmentId = (latest.rows[0]?.id as string) ?? undefined;
      }
    }
    if (appointmentId) resolved.appointmentId = appointmentId;
    // The cancellation handler requires a reason. Use the classifier's when
    // present; otherwise record the channel — the operator sees the full
    // summary at approval time.
    if (intent === 'cancel_appointment' && typeof entities.reason !== 'string') {
      resolved.reason = 'Requested by caller via voice session';
    }
  }

  return resolved;
}
