/**
 * P6-028 — Tech "I'm out today" SMS event contract.
 *
 * A technician marks themselves out for the CURRENT (tenant-local) day by
 * replying OUT, SICK, or UNAVAILABLE to the shop's SMS number from their
 * registered mobile (P1-022 `findByMobileNumber`). On receipt the API:
 *
 *   1. resolves + role-checks the inbound mobile (anti-spoofing — only a
 *      user whose role is `technician` may mark a tech out);
 *   2. records a daily idempotency key in `tech_status_today`
 *      (PK includes `local_date`, so "midnight clear" emerges with no cron);
 *   3. writes a same-day `unavailable_blocks` row (tenant-local midnight →
 *      +24h);
 *   4. for each of the tech's remaining appointments today, drafts a
 *      customer-facing reschedule SMS in brand voice (P4-015) and creates a
 *      `reschedule_appointment` proposal routed to the owner with the draft
 *      attached on `sourceContext.draftSms`.
 *
 * This module is the single typed contract for that inbound event so the SMS
 * handler (producer) and any downstream consumer agree on the shape. The
 * status values mirror the three accepted keywords.
 */
import { z } from 'zod';

/**
 * The three statuses a tech can set for the day. Each maps 1:1 to an accepted
 * keyword (OUT / SICK / UNAVAILABLE), normalized to lowercase. These are also
 * the values the `tech_status_today.status` CHECK constraint enforces
 * (migration 117).
 */
export const TECH_STATUS_VALUES = ['out', 'sick', 'unavailable'] as const;
export type TechStatus = (typeof TECH_STATUS_VALUES)[number];

/**
 * Map a normalized inbound keyword to its status. Returns null when the token
 * is not one of the three accepted keywords (defensive — the keyword
 * dispatcher only routes registered keywords, but the handler re-derives the
 * status from the body so it can never trust an unexpected token).
 */
export function techStatusForKeyword(keyword: string): TechStatus | null {
  const k = keyword.trim().toLowerCase();
  return (TECH_STATUS_VALUES as readonly string[]).includes(k)
    ? (k as TechStatus)
    : null;
}

/**
 * The inbound tech-status event the handler processes. `localDate` is the
 * tech's tenant-local calendar date (YYYY-MM-DD), the idempotency key's date
 * component — NOT the server-local date.
 */
export const TechStatusEventSchema = z.object({
  /** Tenant the technician belongs to (RLS scope). */
  tenantId: z.string().uuid(),
  /** The resolved technician's user id (bound via findByMobileNumber). */
  technicianId: z.string().uuid(),
  /** Normalized E.164 of the inbound mobile (e.g. "+15551234567"). */
  fromE164: z.string().min(7),
  /** The status the tech set for the day. */
  status: z.enum(TECH_STATUS_VALUES),
  /** Tenant-local calendar date (YYYY-MM-DD) the status applies to. */
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'localDate must be YYYY-MM-DD'),
  /** Provider message SID of the inbound SMS (idempotency provenance). */
  sourceMessageSid: z.string().min(1),
});

export type TechStatusEvent = z.infer<typeof TechStatusEventSchema>;

/**
 * The three availability-status keywords (OUT/SICK/UNAVAILABLE), each
 * mapping 1:1 to a `TechStatus` via `techStatusForKeyword`. Kept as its own
 * constant so `TechStatusKeywordHandler` (sms/tech-status/keyword-router.ts)
 * registers EXACTLY these with the P2-034 dispatcher — the en-route keywords
 * below route to a DIFFERENT handler and must never fall through to the
 * status-claim flow (which would just decline them as 'unrecognized_keyword').
 */
export const TECH_STATUS_AVAILABILITY_KEYWORDS = ['out', 'sick', 'unavailable'] as const;

/**
 * B5.5 / Part F decision F-3 — the en-route ACT keyword(s). Deliberately NOT
 * part of `TECH_STATUS_VALUES` (the status enum above) or of
 * `techStatusForKeyword`: "on my way" is an ACT (the technician is departing
 * right now), not a day-long availability status — it never claims
 * `tech_status_today` and never creates an `unavailable_blocks` row. Routed
 * by a dedicated dispatcher registration
 * (sms/tech-status/en-route-keyword.ts) to the SAME audited direct status
 * act the app en-route button and the voice leg use
 * (dispatch/routes.ts `triggerEnRoute`).
 */
export const EN_ROUTE_SMS_KEYWORDS = ['omw', 'on my way'] as const;

/**
 * The full keyword set this feature area registers with the P2-034
 * dispatcher — availability-status keywords PLUS the en-route act
 * keyword(s). Two different `KeywordHandler`s consume their own subset (see
 * the doc comments above); nothing consumes the union directly.
 */
export const TECH_STATUS_KEYWORDS = [
  ...TECH_STATUS_AVAILABILITY_KEYWORDS,
  ...EN_ROUTE_SMS_KEYWORDS,
] as const;
