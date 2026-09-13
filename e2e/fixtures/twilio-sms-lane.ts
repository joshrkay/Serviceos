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
 * hours-from-now offset, which can silently cross the tenant's own local
 * midnight depending purely on what wall-clock time the suite happens to
 * run at.
 *
 * The scale-down branch below is deliberately UNFLOORED (previous version
 * clamped to a minimum 0.5, which is exactly what let a slot still land
 * PAST `latestMs` when the true safe scale was below 0.5 — Fable caught
 * this live: `laterTodaySlots('America/Los_Angeles', 1, 120)` at 23:04
 * Pacific had only ~51 real minutes of tenant-local day left, the floor
 * forced a 60-minute gap anyway, and the slot landed on TOMORROW). Callers
 * are additionally steered onto a timezone whose CURRENT local time is far
 * from ITS OWN midnight (see `pickSafeSecondaryTimezone` below and each
 * spec's tenant setup) so this clamp is a backstop, not the only guard.
 */
export function laterTodaySlots(tz: string, count: number, gapMin = 90): Date[] {
  const now = new Date();
  const dayStart = tzMidnight(localDateKey(now, tz), tz);
  const dayEnd = addCalendarDays(dayStart, 1, tz);
  const marginMs = 10 * 60 * 1000;
  const latestMs = dayEnd.getTime() - marginMs;
  const gapMs = gapMin * 60 * 1000;
  const desiredLastMs = now.getTime() + gapMs * count;
  const scale = desiredLastMs > latestMs ? Math.max((latestMs - now.getTime()) / (gapMs * count), 0) : 1;
  const effectiveGapMs = gapMs * scale;
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() + effectiveGapMs * (i + 1)));
}

/**
 * The curated timezone allow-list `tenantLocalDate`
 * (packages/api/src/sms/tech-status/handler.ts) actually honors —
 * `isValidTimezone` (packages/api/src/shared/timezone.ts), NOT the wider
 * `isRuntimeTimezone` used elsewhere. An Intl-valid but non-curated zone
 * would silently fall back to UTC in the handler and quietly defeat a T3
 * claim, so row 4.8's second tenant MUST come from this exact list.
 */
const CURATED_NON_UTC_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Boise',
] as const;

function currentLocalHour(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(at);
  // Some ICU builds render midnight as "24" with hour12:false; normalize.
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour + minute / 60;
}

function hoursFromLocalNoon(localHour: number): number {
  const diff = Math.abs(localHour - 12);
  return Math.min(diff, 24 - diff);
}

/**
 * Row 4.8's T3 grade needs a SECOND `tenant_settings.timezone` value that
 * is (a) genuinely different from tenant A's and (b) one the product will
 * actually honor (curated list, see above). A FIXED second zone is exactly
 * what caused the bug above: every curated zone is a US (+ Hawaii) zone, so
 * there is a real multi-hour stretch of UTC time (observed directly: UTC
 * ~04:00–10:30) where the ENTIRE curated list is simultaneously in the
 * evening/night — no fixed choice is safe at all real run times. This picks
 * whichever curated zone's CURRENT local time is closest to ITS OWN noon —
 * i.e. currently farthest from ITS OWN midnight — so the SAME appointment
 * math always gets the most headroom available, regardless of when the
 * suite runs. Tenant A separately uses plain `'UTC'` (see each spec) —
 * always in the curated list, always genuinely different from whatever
 * this picks (never 'UTC' itself), and its own "local time" IS the actual
 * UTC clock, which is safe from local-midnight-clustering entirely and
 * only close to ITS OWN midnight for a much narrower, unrelated window.
 */
export function pickSafeSecondaryTimezone(at: Date = new Date()): string {
  return [...CURATED_NON_UTC_TIMEZONES].sort(
    (a, b) => hoursFromLocalNoon(currentLocalHour(a, at)) - hoursFromLocalNoon(currentLocalHour(b, at)),
  )[0]!;
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

/**
 * #1133 workaround (filed by Fable, not fixed here — TEST-ONLY lane):
 * `withTenantTransaction` (packages/api/src/middleware/tenant-context.ts)
 * commits each request's own DB transaction on the Express response's
 * `finish` event — AFTER the response body is already flushed to the
 * client — via a fire-and-forget `void cleanup(commit)` the request
 * pipeline never awaits. A request that immediately references something a
 * PRIOR request just created (a location referencing a customer, a job
 * referencing that location) can race that still-in-flight COMMIT and see
 * the parent as not-yet-existing (observed directly: `POST /api/jobs` 404
 * "Location not found" 9ms after that location's own 201). This polls the
 * just-created row's own GET /:id until it 200s (bounded to 2s) BEFORE
 * returning it to the caller, who uses it in the next, dependent call —
 * exactly the workaround shape requested, not a retry-the-write.
 */
async function waitUntilReadable(
  request: APIRequestContext,
  ownerToken: string,
  path: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get(`${API_URL}${path}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    if (res.status() === 200) return;
    if (Date.now() >= deadline) return; // let the dependent call surface the real (or now-resolved) error
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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
  const customer = (await res.json()) as { id: string };
  await waitUntilReadable(request, ownerToken, `/api/customers/${customer.id}`); // #1133 workaround
  return customer;
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
  const location = (await res.json()) as { id: string };
  await waitUntilReadable(request, ownerToken, `/api/locations/${location.id}`); // #1133 workaround
  return location;
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
  const job = (await res.json()) as { id: string };
  await waitUntilReadable(request, ownerToken, `/api/jobs/${job.id}`); // #1133 workaround
  return job;
}

/**
 * `GET /api/appointments?jobId=` (legacy bare-array contract) as the owner.
 * This route does not 404 on an unknown/uncommitted job — it just returns
 * an empty array (`listByJob` has no existence check) — so this polls for a
 * NON-EMPTY result (bounded to 2s), the same #1133 workaround shape as
 * `waitUntilReadable` above: the appointment row is written inside the
 * job's own request transaction, so a read immediately after can race the
 * same deferred COMMIT.
 */
export async function getAppointmentIdForJob(
  request: APIRequestContext,
  ownerToken: string,
  jobId: string,
): Promise<string> {
  const timeoutMs = 2000;
  const intervalMs = 100;
  const deadline = Date.now() + timeoutMs;
  let appointments: Array<{ id: string }> = [];
  for (;;) {
    const res = await request.get(`${API_URL}/api/appointments?jobId=${jobId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status(), `GET /api/appointments?jobId= failed: ${await res.text()}`).toBe(200);
    appointments = (await res.json()) as Array<{ id: string }>;
    if (appointments.length > 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  expect(appointments.length, `no appointment synced for job ${jobId}`).toBeGreaterThan(0);
  return appointments[0]!.id;
}
