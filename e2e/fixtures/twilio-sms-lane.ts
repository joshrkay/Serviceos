/**
 * Shared helpers for the #1017 §8.4 inbound-SMS rung-reachability specs
 * (row 4.8 tech-OUT, row 4.5 OMW-keyword). Builds on
 * `e2e/fixtures/twilio-phone-lane.ts` (the merged §8.3 phone lane):
 * `provisionTenant` / `signedPost` / `devAuthBearerToken` are reused
 * verbatim — this file only adds what the SMS legs need on top:
 *
 *   - a technician user with a registered mobile (Clerk-driven in prod,
 *     so inserted directly — same justification as
 *     packages/api/test/integration/tech-status-sms.test.ts: "Technician
 *     user with a registered mobile (Clerk-driven in prod, so we insert
 *     directly — PgUserRepository has no create())");
 *   - customers, locations and a scheduled+assigned job/appointment,
 *     ALL created through the real, authenticated HTTP API (owner
 *     dev-auth-bypass bearer token) rather than SQL — `POST /api/jobs`
 *     with `scheduledStart` + `technicianId` creates the job AND its
 *     canonical appointment AND the primary `appointment_assignments`
 *     row in one transactional call (packages/api/src/jobs/job-appointment
 *     -sync.ts `syncJobSchedule`), which is the only place in this codebase
 *     that wires a technician to an appointment — there is no dedicated
 *     "assign" endpoint;
 *   - the inbound-SMS webhook POST itself, at
 *     `/webhooks/twilio/sms/:tenantId` (packages/api/src/webhooks/routes.ts
 *     `router.post('/twilio/sms/:tenantId', twilioRoute('sms'))`, mounted
 *     at `/webhooks` in app.ts).
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { API_URL, signedPost, type ProvisionedTenant } from './twilio-phone-lane';
import { tzMidnight, localDateKey, addCalendarDays } from '../../packages/api/src/shared/timezone';

export { API_URL, signedPost, provisionTenant, devAuthBearerToken, pollFor } from './twilio-phone-lane';
export type { ProvisionedTenant } from './twilio-phone-lane';

/**
 * `count` distinct, ascending times "later today" in the TENANT's own
 * timezone, `gapMin` apart, computed with the SAME `tzMidnight`/
 * `localDateKey`/`addCalendarDays` helpers
 * (packages/api/src/shared/timezone.ts) the product itself uses to walk
 * "tenant-local today" (`createRescheduleProposalsFromTechOut`,
 * `tenantLocalDate` in sms/tech-status/handler.ts) — NOT a fixed
 * hours-from-now offset. A fixed UTC offset can silently cross the
 * tenant's own local midnight depending purely on what wall-clock time the
 * suite happens to run at (observed directly in this lane's RED trail: a
 * +2h offset landed the appointment on TOMORROW in America/Los_Angeles
 * when the suite ran at 05:36 UTC — see the lane report). This instead
 * anchors to the tenant's actual local-day boundaries and scales the gap
 * down (never below `gapMin`/2) only in the rare case where the tenant's
 * local day is nearly over, so every slot always lands inside
 * `[now, tenant-local midnight + 24h)` — the exact window the reschedule
 * walk reads — regardless of real run time.
 */
export function laterTodaySlots(tz: string, count: number, gapMin = 90): Date[] {
  const now = new Date();
  const dayStart = tzMidnight(localDateKey(now, tz), tz);
  const dayEnd = addCalendarDays(dayStart, 1, tz);
  const marginMs = 5 * 60 * 1000;
  const latestMs = dayEnd.getTime() - marginMs;
  const gapMs = gapMin * 60 * 1000;
  const desiredLastMs = now.getTime() + gapMs * count;
  const scale = desiredLastMs > latestMs ? Math.max((latestMs - now.getTime()) / (gapMs * count), 0.5) : 1;
  const effectiveGapMs = gapMs * scale;
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() + effectiveGapMs * (i + 1)));
}

/** `/webhooks/twilio/sms/:tenantId` — see webhooks/routes.ts:2845. */
export function smsWebhookPath(tenantId: string): string {
  return `/webhooks/twilio/sms/${tenantId}`;
}

/**
 * A signed, Twilio-shaped inbound SMS POST through the real webhook route.
 * Fills in the ordinary fields every inbound SMS carries (`NumMedia: '0'`,
 * a fresh `MessageSid` unless the caller supplies one — the handler's own
 * same-day idempotency is keyed on `tech_status_today`, not on MessageSid,
 * so two genuinely separate deliveries must carry two different SIDs) and
 * signs over the SAME params object it POSTs, via the shared `signedPost`.
 */
export async function signedSmsPost(
  request: APIRequestContext,
  tenant: Pick<ProvisionedTenant, 'tenantId' | 'authToken' | 'subaccountSid' | 'did'>,
  params: { From: string; Body: string; MessageSid?: string },
) {
  const body: Record<string, string> = {
    MessageSid: params.MessageSid ?? `SM${crypto.randomUUID().replace(/-/g, '')}`,
    AccountSid: tenant.subaccountSid,
    From: params.From,
    To: tenant.did,
    Body: params.Body,
    NumMedia: '0',
  };
  return signedPost(request, smsWebhookPath(tenant.tenantId), body, tenant.authToken);
}

/**
 * Insert a technician user directly — mirrors exactly what Clerk's
 * `user.created` webhook + the team-invite accept flow leaves in `users`
 * (role, mobile_number), the same shape
 * packages/api/test/integration/tech-status-sms.test.ts's fixture uses.
 * `PgUserRepository` has no `create()` (users are Clerk-driven), so every
 * merged tech-status DB proof provisions this way — not a test-only shortcut.
 */
export async function insertTechnician(
  pool: Pool,
  tenantId: string,
  opts: { mobile: string; firstName: string; lastName: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, mobile_number, first_name, last_name)
     VALUES ($1, $2, $3, $4, 'technician', $5, $6, $7)`,
    [id, tenantId, id, `${opts.firstName.toLowerCase()}+${id.slice(0, 8)}@example.com`, opts.mobile, opts.firstName, opts.lastName],
  );
  return { id };
}

/** `POST /api/customers` as the owner (dev-auth-bypass bearer). */
export async function createCustomerViaApi(
  request: APIRequestContext,
  ownerToken: string,
  opts: { firstName: string; lastName: string; primaryPhone?: string },
): Promise<{ id: string }> {
  const res = await request.post(`${API_URL}/api/customers`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: {
      firstName: opts.firstName,
      lastName: opts.lastName,
      ...(opts.primaryPhone ? { primaryPhone: opts.primaryPhone } : {}),
      preferredChannel: 'sms',
      smsConsent: true,
    },
  });
  expect(res.status(), `POST /api/customers failed: ${await res.text()}`).toBe(201);
  return res.json();
}

/** `POST /api/locations` as the owner. */
export async function createLocationViaApi(
  request: APIRequestContext,
  ownerToken: string,
  customerId: string,
): Promise<{ id: string }> {
  const res = await request.post(`${API_URL}/api/locations`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: {
      customerId,
      street1: '100 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
    },
  });
  expect(res.status(), `POST /api/locations failed: ${await res.text()}`).toBe(201);
  return res.json();
}

/**
 * `POST /api/jobs` with a `scheduledStart` + `technicianId` — creates the
 * job AND, in the SAME transaction, its canonical appointment AND the
 * primary `appointment_assignments` row binding it to the technician
 * (jobs/job-appointment-sync.ts `syncJobSchedule`). Returns the job id;
 * the caller resolves the appointment id via `GET /api/appointments?jobId=`.
 */
export async function createScheduledJobViaApi(
  request: APIRequestContext,
  ownerToken: string,
  opts: {
    customerId: string;
    locationId: string;
    summary: string;
    technicianId: string;
    scheduledStart: Date;
    timezone: string;
    durationMin?: number;
  },
): Promise<{ id: string }> {
  const res = await request.post(`${API_URL}/api/jobs`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: {
      customerId: opts.customerId,
      locationId: opts.locationId,
      summary: opts.summary,
      scheduledStart: opts.scheduledStart.toISOString(),
      technicianId: opts.technicianId,
      durationMin: opts.durationMin ?? 60,
      timezone: opts.timezone,
    },
  });
  expect(res.status(), `POST /api/jobs failed: ${await res.text()}`).toBe(201);
  return res.json();
}

/** `GET /api/appointments?jobId=` (legacy bare-array contract) as the owner. */
export async function getAppointmentIdForJob(
  request: APIRequestContext,
  ownerToken: string,
  jobId: string,
): Promise<string> {
  const res = await request.get(`${API_URL}/api/appointments?jobId=${jobId}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(res.status(), `GET /api/appointments?jobId= failed: ${await res.text()}`).toBe(200);
  const appointments = (await res.json()) as Array<{ id: string }>;
  expect(appointments.length, `no appointment synced for job ${jobId}`).toBeGreaterThan(0);
  return appointments[0]!.id;
}
