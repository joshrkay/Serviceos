import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { runHoldReaperSweep } from '../../packages/api/src/workers/hold-reaper-worker';
import { PgAppointmentRepository } from '../../packages/api/src/appointments/pg-appointment';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { createAppointment } from '../../packages/api/src/appointments/appointment';
import { createLogger } from '../../packages/api/src/logging/logger';

/**
 * §8.3 row 3.5 — rung-5 reachability: "a slot held while I decide, and
 * released if I don't, so a second prospect gets a real answer."
 *
 * packages/api/test/integration/hold-reaper.test.ts already proves
 * `runHoldReaperSweep` against real Postgres, including a T2 leg (a
 * neighbour tenant's identical hold is spared) — but every fixture there is
 * built directly through PgAppointmentRepository.create, never through the
 * product's own real booking surface, and no browser ever looks at the
 * result.
 *
 * This file closes that gap: a REAL held appointment is created through the
 * SAME public `/book` surface 2.9/3.4 use (no SQL), the owner's REAL
 * authenticated `/dispatch` session sees it as a tentative hold (the
 * amber "hold" badge, `appointment-hold-badge`), and — because waiting out
 * the real 24h hold window in CI is not viable, exactly like the digest and
 * proposal-expiry sweeps in this same suite — `runHoldReaperSweep` (the
 * IDENTICAL function app.ts's leader-locked 15-minute `setInterval` invokes)
 * is called directly against the real Postgres the API webServer is also
 * pointed at, with an injected clock past the hold's real `holdExpiryAt`.
 * The owner then reloads the SAME real `/dispatch` page and the hold badge
 * is gone; the slot is provably reachable through the real
 * `GET /api/dispatch/availability` route (row 3.2/3.3's own surface) again.
 *
 * Tenant B's still-live hold (the T2 control — an identical hold that must
 * NOT be reaped in the same pass) is seeded via the production
 * `createAppointment` domain function directly (the same function the
 * public-booking route itself calls), with an explicit far-future
 * `holdExpiryAt` — deterministic timing control, not a raw SQL write.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-3-book-inapp-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

interface Tenant {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

// 08:00-17:00 weekday hours (not all-day): GET /api/dispatch/availability
// returns only the first 6 open slots (routes.ts never passes `maxSlots`,
// booking-availability.ts's default), 30-min granularity
// (GRANULARITY_MS). With all-day hours the top-6 would all be
// pre-dawn and the 10:00 slot this spec books/frees would never appear in
// EITHER the "blocked" or "free" response, for a reason that has nothing to
// do with the hold. 08:00-17:00 puts 10:00 as the 5th slot when free.
const WEEKDAY_HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: null,
  sun: null,
};

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<Tenant> {
  const sub = `user_e2e_holdreap_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Hold Reaper E2E ${label.toUpperCase()}`,
      businessHours: WEEKDAY_HOURS,
      jobBufferMinutes: 15,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

interface CreatedEntity {
  id: string;
  [k: string]: unknown;
}

async function postJson(
  request: APIRequestContext,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<CreatedEntity> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CreatedEntity;
}

async function getAppointment(
  request: APIRequestContext,
  authHeaders: Record<string, string>,
  id: string,
): Promise<{ status: string; holdPendingApproval?: boolean; holdExpiryAt?: string }> {
  const res = await request.get(`${API_URL}/api/appointments/${id}`, { headers: authHeaders });
  expect(res.ok(), `GET /api/appointments/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as { status: string; holdPendingApproval?: boolean; holdExpiryAt?: string };
}

const FUTURE_DAY = '2099-06-15'; // a Monday, far future — clock-safe (absolute, never "today")

test.describe('held-slot reaper (3.5) — real Postgres', () => {
  const canRun =
    // A LOCALHOST E2E_BASE_URL means a self-managed, dedicated-port
    // webServer pair (this lane's own workaround for sibling lanes
    // squatting the default port 5173 on a shared Mac) — not a remote
    // deployed environment, so it does not disqualify a run.
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to run the reaper sweep).',
  );

  test('a real held appointment shows the owner a hold badge, the reaper cancels it once expired, the slot re-opens on the real availability route, and a neighbour tenant\'s live hold is spared', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const tenantA = await bootstrapOwner(page.request, 'a');
    const tenantB = await bootstrapOwner(page.request, 'b');

    // ── Real public booking (no SQL) creates a genuine tentative hold on
    //    tenant A's calendar, 10:00-11:00 UTC on the far-future Monday. ─────
    const bookRes = await page.request.post(`${API_URL}/api/public/booking/${tenantA.tenantId}`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        firstName: 'Held',
        lastName: 'Prospect',
        primaryPhone: '5125550177',
        street1: '3 Reaper Test Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        summary: `E2E hold-reaper fixture ${randomUUID().slice(0, 8)}`,
        slotStart: `${FUTURE_DAY}T10:00:00.000Z`,
        slotEnd: `${FUTURE_DAY}T11:00:00.000Z`,
        _company_url: '',
      }),
    });
    expect(bookRes.status(), `public booking POST -> ${bookRes.status()}: ${await bookRes.text()}`).toBe(201);
    const booking = (await bookRes.json()) as { appointmentId: string };
    const apptAId = booking.appointmentId;
    expect(apptAId).toMatch(UUID_RE);

    // #1133 workaround — poll until the appointment is durably readable
    // before asserting on it (the request transaction commits on res.finish,
    // after the 201 already flushed). The booking POST response itself
    // (routes/public-booking.ts:475-483) does not carry the hold expiry —
    // read it back from the real appointment record instead.
    let apptABefore: { status: string; holdPendingApproval?: boolean; holdExpiryAt?: string } | undefined;
    for (let i = 0; i < 10; i++) {
      apptABefore = await getAppointment(page.request, tenantA.authHeaders, apptAId);
      if (apptABefore.holdPendingApproval === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(apptABefore!.status).toBe('scheduled');
    expect(apptABefore!.holdPendingApproval).toBe(true);
    expect(apptABefore!.holdExpiryAt, 'appointment record must carry the hold expiry').toBeTruthy();
    const holdExpiryAtA = new Date(apptABefore!.holdExpiryAt!);

    // ── The availability route (3.2/3.3's own surface) shows the window
    //    BLOCKED while the hold is live. ─────────────────────────────────────
    const availBeforeRes = await page.request.get(
      `${API_URL}/api/dispatch/availability?from=${FUTURE_DAY}&to=${FUTURE_DAY}&durationMin=60`,
      { headers: tenantA.authHeaders },
    );
    expect(availBeforeRes.ok()).toBeTruthy();
    const availBefore = (await availBeforeRes.json()) as { slots: Array<{ start: string }> };
    expect(
      availBefore.slots.some((s) => s.start === `${FUTURE_DAY}T10:00:00.000Z`),
      'the held window must be BLOCKED while the hold is live',
    ).toBe(false);

    // ── Real owner browser: the held appointment renders on /dispatch with
    //    the amber "hold" badge and status "scheduled". ─────────────────────
    await installClerkStub(page, { signedIn: true, sub: tenantA.sub, token: tenantA.jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);
    await page.goto('/dispatch');
    await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('date-nav-picker').fill(FUTURE_DAY);
    const cardA = page.locator(`[data-appointment-id="${apptAId}"]`);
    await expect(cardA).toBeVisible({ timeout: 15_000 });
    await expect(cardA.getByTestId('appointment-hold-badge')).toBeVisible();
    await expect(cardA.getByTestId('appointment-status')).toHaveText('scheduled');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.5-dispatch-board-hold-before-sweep.png'), fullPage: true });

    // ── Tenant B: a STILL-LIVE hold (T2 control) — seeded via the SAME
    //    production `createAppointment` domain function public-booking.ts
    //    itself calls (not raw SQL), with an explicit far-future expiry so
    //    it is provably unaffected by the sweep run below regardless of
    //    wall-clock timing. ───────────────────────────────────────────────
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let apptBId!: string;
    try {
      const appointmentRepo = new PgAppointmentRepository(pool);
      const auditRepo = new PgAuditRepository(pool);

      const customerB = await postJson(page.request, `${API_URL}/api/customers`, tenantB.authHeaders, {
        firstName: 'Neighbour',
        lastName: 'Live Hold',
        primaryPhone: '5125550188',
        preferredChannel: 'phone',
      });
      const locationB = await postJson(page.request, `${API_URL}/api/locations`, tenantB.authHeaders, {
        customerId: customerB.id,
        street1: '4 Neighbour Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        isPrimary: true,
      });
      const jobB = await postJson(page.request, `${API_URL}/api/jobs`, tenantB.authHeaders, {
        customerId: customerB.id,
        locationId: locationB.id,
        summary: 'Hold reaper T2 fixture job',
        priority: 'normal',
      });

      const farFutureExpiry = new Date(holdExpiryAtA.getTime() + 100 * 24 * 60 * 60 * 1000); // +100 days past A's expiry
      const apptB = await createAppointment(
        {
          tenantId: tenantB.tenantId,
          jobId: jobB.id,
          scheduledStart: new Date(`${FUTURE_DAY}T10:00:00.000Z`),
          scheduledEnd: new Date(`${FUTURE_DAY}T11:00:00.000Z`),
          timezone: 'Etc/UTC',
          holdPendingApproval: true,
          holdExpiryAt: farFutureExpiry,
          createdBy: tenantB.sub,
        },
        appointmentRepo,
        undefined,
        auditRepo,
        'system',
      );
      apptBId = apptB.id;

      // ── The production sweep, called directly (a worker tick, not an
      //    admin route — the same function app.ts's leader-locked
      //    setInterval invokes), with an injected clock 1 minute past
      //    tenant A's REAL hold expiry. ────────────────────────────────────
      const now = new Date(holdExpiryAtA.getTime() + 60_000);
      const sweepResult = await runHoldReaperSweep({
        appointmentRepo,
        auditRepo,
        listTenantIds: async () => [tenantA.tenantId, tenantB.tenantId],
        logger: createLogger({ service: 'e2e-hold-reaper', environment: 'test', level: 'error' }),
        now: () => now,
      });
      expect(sweepResult.reaped, `sweep result -> ${JSON.stringify(sweepResult)}`).toBe(1);

      // ── A second sweep, same clock, is a no-op (idempotent). ────────────
      const secondSweep = await runHoldReaperSweep({
        appointmentRepo,
        auditRepo,
        listTenantIds: async () => [tenantA.tenantId, tenantB.tenantId],
        logger: createLogger({ service: 'e2e-hold-reaper-2', environment: 'test', level: 'error' }),
        now: () => now,
      });
      expect(secondSweep.reaped).toBe(0);

      // ── Audit: exactly the reaped appointment carries `appointment.
      //    hold_expired`; tenant B's spared hold carries none. ─────────────
      const auditA = await auditRepo.findByEntity(tenantA.tenantId, 'appointment', apptAId);
      expect(auditA.some((e) => e.eventType === 'appointment.hold_expired')).toBe(true);
      const auditB = await auditRepo.findByEntity(tenantB.tenantId, 'appointment', apptBId);
      expect(auditB.some((e) => e.eventType === 'appointment.hold_expired')).toBe(false);
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── Durable proof, read through the real, authenticated API ────────────
    const apptAAfter = await getAppointment(page.request, tenantA.authHeaders, apptAId);
    expect(apptAAfter.status).toBe('canceled');
    expect(apptAAfter.holdPendingApproval).toBe(false);
    const apptBAfter = await getAppointment(page.request, tenantB.authHeaders, apptBId!);
    expect(apptBAfter.status).toBe('scheduled');
    expect(apptBAfter.holdPendingApproval).toBe(true);

    // ── "An expired hold stops blocking the slot" — the SAME real
    //    availability route now offers the 10:00 window again. ─────────────
    const availAfterRes = await page.request.get(
      `${API_URL}/api/dispatch/availability?from=${FUTURE_DAY}&to=${FUTURE_DAY}&durationMin=60`,
      { headers: tenantA.authHeaders },
    );
    expect(availAfterRes.ok()).toBeTruthy();
    const availAfter = (await availAfterRes.json()) as { slots: Array<{ start: string }> };
    expect(
      availAfter.slots.some((s) => s.start === `${FUTURE_DAY}T10:00:00.000Z`),
      'the reaped hold must stop blocking the slot',
    ).toBe(true);

    // ── The SAME real owner browser, reloaded: the hold badge is gone and
    //    the status reads "canceled". ───────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('date-nav-picker').fill(FUTURE_DAY);
    const cardAAfter = page.locator(`[data-appointment-id="${apptAId}"]`);
    await expect(cardAAfter).toBeVisible({ timeout: 15_000 });
    await expect(cardAAfter.getByTestId('appointment-hold-badge')).toHaveCount(0);
    await expect(cardAAfter.getByTestId('appointment-status')).toHaveText('canceled');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.5-dispatch-board-hold-after-sweep.png'), fullPage: true });

    expect(pageErrors, 'no uncaught page errors while viewing the dispatch board').toEqual([]);
  });
});
