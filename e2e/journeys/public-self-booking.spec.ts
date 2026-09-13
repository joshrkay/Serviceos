import { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 2.9 — rung-5 reachability: a prospect books themselves on the tenant's
 * public `/book` page with no login, at real Postgres, and the resulting
 * held appointment shows up in the owner's approval queue.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts. Setup goes
 * through the real authenticated API (owner identity + business hours via
 * PUT /api/onboarding/identity) — no SQL, no platform-admin route, no
 * env-var shortcut. `/api/public/booking` is rate-limited to 5 req/min per
 * IP (packages/api/src/app.ts:3053-3078) — this spec makes exactly 4
 * requests against it (one availability GET + one booking POST per tenant)
 * to stay well under that.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/public-surfaces-r5');
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
  ownerSub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

/**
 * `businessHours` follows updateSettingsSchema's per-day record — a full
 * week is supplied explicitly (never left to defaults) so the two tenants'
 * offered slots are provably disjoint, not accidentally different.
 */
async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
  businessHours: Record<string, { open: string; close: string } | null>,
): Promise<Tenant> {
  const ownerSub = `user_e2e_selfbook_${label}_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(ownerSub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
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
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName,
      businessHours,
      jobBufferMinutes: 15,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, ownerSub, jwt, authHeaders };
}

/** RLS-scoped read against real Postgres, mirroring e2e/qa-matrix/helpers/rw-db.ts. */
async function queryAsTenant(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function signInAsOwner(page: Page, tenant: Tenant, baseURL: string): Promise<void> {
  await installClerkStub(page, { signedIn: true, sub: tenant.ownerSub, token: tenant.jwt });
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
  await blockExternalHosts(page, baseURL);
}

const WEEKDAY_HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: null,
  sun: null,
};

const WEEKEND_ONLY_HOURS = {
  mon: null,
  tue: null,
  wed: null,
  thu: null,
  fri: null,
  sat: { open: '09:00', close: '13:00' },
  sun: { open: '09:00', close: '13:00' },
};

test.describe('website self-booking (2.9) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('a prospect books a real open slot on the tenant weekday-hours page; a differently-configured tenant offers disjoint slots and never sees this booking', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: Mon–Fri 08:00–17:00 ────────────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 2.9', WEEKDAY_HOURS);
    // ── Tenant B: Sat/Sun 09:00–13:00 only — T3, a genuinely different config ─
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 2.9', WEEKEND_ONLY_HOURS);

    // ── T3 — differently-configured tenants each get their OWN correct,
    //    non-overlapping slots in the SAME run ───────────────────────────────
    await page.goto(`/book?t=${tenantA.tenantId}`);
    await expect(page.getByRole('heading', { name: /choose a time/i })).toBeVisible();
    const firstSlotA = page.locator('[data-testid^="booking-slot-"]').first();
    await expect(firstSlotA).toBeVisible({ timeout: 15_000 });
    const slotStartA = await firstSlotA.getAttribute('data-testid');
    expect(slotStartA).toMatch(/^booking-slot-/);
    const isoA = slotStartA!.replace('booking-slot-', '');
    // Tenant A's weekday hours never offer a weekend slot.
    const weekdayA = new Date(isoA).toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
    });
    expect(['Sat', 'Sun']).not.toContain(weekdayA);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '2.9-booking-before.png') });

    await firstSlotA.click();
    await page.getByTestId('booking-cta').click();

    const bookingSummaryA = `E2E self-booking A ${randomUUID().slice(0, 8)}`;
    await page.getByTestId('booking-field-name').fill('Riley Prospect');
    await page.getByTestId('booking-field-phone').fill('5125550111');
    await page.getByTestId('booking-field-street1').fill('42 Self Booking Ln');
    await page.getByTestId('booking-field-city').fill('Austin');
    await page.getByTestId('booking-field-state').fill('TX');
    await page.getByTestId('booking-field-postalCode').fill('78701');
    await page.getByTestId('booking-field-summary').fill(bookingSummaryA);

    const bookingResponsePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/api/public/booking/${tenantA.tenantId}`),
    );
    await page.getByTestId('booking-cta').click();
    const bookingResponse = await bookingResponsePromise;
    expect(bookingResponse.status(), `booking POST -> ${bookingResponse.status()}`).toBe(201);
    const bookingResult = (await bookingResponse.json()) as {
      appointmentId: string;
      proposalId: string;
      scheduledStart: string;
    };
    expect(bookingResult.appointmentId).toBeTruthy();

    await expect(page.getByRole('heading', { name: /Request received!/i })).toBeVisible({
      timeout: 15_000,
    });

    // ── Durable proof: a HELD appointment pending owner approval ────────────
    const apptRes = await request.get(`${API_URL}/api/appointments/${bookingResult.appointmentId}`, {
      headers: tenantA.authHeaders,
    });
    expect(apptRes.ok()).toBeTruthy();
    const appt = (await apptRes.json()) as {
      status: string;
      holdPendingApproval: boolean;
      holdExpiryAt?: string;
    };
    expect(appt.status).toBe('scheduled');
    expect(appt.holdPendingApproval).toBe(true);
    expect(appt.holdExpiryAt).toBeTruthy();

    const bookingAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'appointment' AND entity_id = $2 AND event_type = 'appointment.booking_requested'`,
      [tenantA.tenantId, bookingResult.appointmentId],
    );
    expect(bookingAudit).toHaveLength(1);
    expect((bookingAudit[0].metadata as { proposalId?: string }).proposalId).toBe(bookingResult.proposalId);

    // ── The owner's approval queue shows it, verified after a full reload ──
    await signInAsOwner(page, tenantA, baseURL!);
    await page.goto('/inbox');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const inboxRowA = page.getByTestId('inbox-row').filter({ hasText: bookingSummaryA });
    await expect(inboxRowA).toBeVisible({ timeout: 15_000 });
    await expect(inboxRowA.getByText(/New online booking/i)).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '2.9-owner-inbox-after-reload.png') });

    // ── T1/T3 — a differently-configured tenant offers a disjoint slot set
    //    and is fully isolated ────────────────────────────────────────────
    // `/api/public/booking` is rate-limited to 5 req/min per IP
    // (packages/api/src/app.ts:3053-3078), and tenant A's own page load
    // already cost 2 GETs — React 18 StrictMode double-invokes the
    // availability-fetch effect on mount in dev — plus 1 POST. A SECOND full
    // browser page load for tenant B would push the run to 6 calls in the
    // same window and 429. Waiting out the window was tried first and
    // surfaced a worse problem: the API process crashed on an unrelated
    // "idle in transaction" Postgres disconnect during the ~65s idle period
    // (a pre-existing stability issue, not touched here — no product code
    // changes). So tenant B's half of this proof — the same public
    // `/api/public/booking/:tenantId` surface the browser page itself calls,
    // already proven reachable end-to-end via tenant A above — is driven
    // directly, keeping this run's total booking-router calls at exactly 5
    // (A: 2 GET + 1 POST; B: 1 GET + 1 POST) and adding zero idle time.
    const availB = await request.get(
      `${API_URL}/api/public/booking/${tenantB.tenantId}/availability?from=${new Date()
        .toISOString()
        .slice(0, 10)}&to=${new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)}&durationMin=60`,
    );
    expect(availB.ok(), `availability -> ${availB.status()}`).toBeTruthy();
    const availBBody = (await availB.json()) as { slots: Array<{ start: string; end: string }> };
    expect(availBBody.slots.length).toBeGreaterThan(0);
    const slotB = availBBody.slots[0];
    const weekdayB = new Date(slotB.start).toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
    });
    // Tenant B's weekend-only hours never offer a weekday slot, and the
    // offered instant itself is never the one tenant A was offered.
    expect(['Sat', 'Sun']).toContain(weekdayB);
    expect(slotB.start).not.toBe(isoA);

    const bookingSummaryB = `E2E self-booking B ${randomUUID().slice(0, 8)}`;
    const bookRes = await request.post(`${API_URL}/api/public/booking/${tenantB.tenantId}`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        firstName: 'Sam',
        lastName: 'OtherProspect',
        primaryPhone: '5125550122',
        street1: '7 Bexar Way',
        city: 'San Antonio',
        state: 'TX',
        postalCode: '78205',
        summary: bookingSummaryB,
        slotStart: slotB.start,
        slotEnd: slotB.end,
        _company_url: '',
      }),
    });
    expect(bookRes.status(), `booking POST -> ${bookRes.status()} ${await bookRes.text()}`).toBe(201);

    // Tenant A's inbox never sees tenant B's booking; tenant B's inbox never
    // sees tenant A's.
    await signInAsOwner(page, tenantB, baseURL!);
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-row').filter({ hasText: bookingSummaryB })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('inbox-row').filter({ hasText: bookingSummaryA })).toHaveCount(0);

    await signInAsOwner(page, tenantA, baseURL!);
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-row').filter({ hasText: bookingSummaryA })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('inbox-row').filter({ hasText: bookingSummaryB })).toHaveCount(0);

    expect(pageErrors, 'no uncaught page errors during the self-booking journey').toEqual([]);
  });
});
