import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * §8.3 row 3.4 — rung-5 reachability: "a booking POST cannot take a slot the
 * calendar wouldn't have offered, so the public page can't be gamed."
 *
 * packages/api/test/integration/public-booking-held-slot.integration.test.ts
 * already drives `createPublicBookingRouter` through supertest against real
 * Postgres for the HELD-SLOT race (two POSTs for the same slot). This file
 * proves the SIBLING guard the same route enforces — the "write-side twin"
 * of GET /availability's business-hours filter
 * (packages/api/src/routes/public-booking.ts:299-309, doc-comment: "A caller
 * can POST any future slot bypassing the UI; without this an out-of-hours
 * request ... would still create a held appointment that GET /availability
 * would never have offered") — reached from the REAL public `/book` page in
 * a real browser, with the crafted "gaming" request sent directly against
 * the real route (not through the picker, which would never offer an
 * out-of-hours slot in the first place — that IS the attack this guard
 * stops).
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-3-book-inapp-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
  businessHours: Record<string, { open: string; close: string } | null>,
): Promise<Tenant> {
  const sub = `user_e2e_gaming_${label}_${randomUUID().replace(/-/g, '')}`;
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
      businessName,
      businessHours,
      jobBufferMinutes: 15,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

async function customerCount(request: APIRequestContext, tenant: Tenant): Promise<number> {
  const res = await request.get(`${API_URL}/api/customers`, { headers: tenant.authHeaders });
  expect(res.ok(), `GET /api/customers -> ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { data?: unknown[] } | unknown[];
  const list = Array.isArray(body) ? body : (body.data ?? []);
  return list.length;
}

async function attemptBooking(
  request: APIRequestContext,
  tenantId: string,
  label: string,
  slotStart: string,
  slotEnd: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(`${API_URL}/api/public/booking/${tenantId}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({
      firstName: 'Gaming',
      lastName: `Attempt ${label}`,
      primaryPhone: '5125550188',
      street1: '9 Cannot Be Gamed Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      summary: `E2E out-of-hours attempt ${label} ${randomUUID().slice(0, 8)}`,
      slotStart,
      slotEnd,
      _company_url: '',
    }),
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

// Far future, fixed weekday/weekend pair — clock-safe by construction (an
// absolute date, never "today"/"tomorrow" relative math), matching the
// convention already established by public-self-booking.spec.ts and the
// underlying integration tests.
const WEEKDAY_DAY = '2099-06-15'; // a Monday
const WEEKEND_DAY = '2099-06-20'; // the following Saturday
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

test.describe('public booking cannot take an out-of-hours slot (3.4) — real Postgres', () => {
  const canRun =
    // A LOCALHOST E2E_BASE_URL means a self-managed, dedicated-port
    // webServer pair (this lane's own workaround for sibling lanes
    // squatting the default port 5173 on a shared Mac) — not a remote
    // deployed environment, so it does not disqualify a run.
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );

  test('a crafted out-of-hours POST bypassing the picker is refused by the SAME tenant-scoped hours the picker used to offer slots; a genuinely in-hours POST still succeeds', async ({
    page,
    baseURL,
  }: { page: Page; baseURL?: string }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: Mon-Fri 08:00-17:00. Tenant B: Sat/Sun 09:00-13:00 only —
    //    a genuinely DIVERGENT config (T2), in the SAME run. ────────────────
    const tenantA = await bootstrapOwner(page.request, 'a', 'Cannot Be Gamed HVAC A', WEEKDAY_HOURS);
    const tenantB = await bootstrapOwner(page.request, 'b', 'Cannot Be Gamed Plumbing B', WEEKEND_ONLY_HOURS);

    // ── Real browser reachability: load tenant A's real public /book page
    //    (no login) — it renders real near-term weekday slots from ITS OWN
    //    weekday-only hours (the picker queries a near-term window from
    //    today, not the far-future date below — so this also confirms the
    //    picker never reaches anywhere near the far-future instant the
    //    attack below targets, let alone offers it). ────────────────────────
    await blockExternalHosts(page, baseURL!);
    await page.goto(`/book?t=${tenantA.tenantId}`);
    await expect(page.getByRole('heading', { name: /choose a time/i })).toBeVisible();
    const firstSlot = page.locator('[data-testid^="booking-slot-"]').first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    const offeredStarts = await page.locator('[data-testid^="booking-slot-"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')?.replace('booking-slot-', '')),
    );
    expect(
      offeredStarts.some((iso) => iso === `${WEEKEND_DAY}T10:00:00.000Z`),
      'the picker itself must never have offered the far-future Saturday slot this spec is about to attack with',
    ).toBe(false);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.4-public-book-page.png') });

    const beforeCountA = await customerCount(page.request, tenantA);
    const beforeCountB = await customerCount(page.request, tenantB);

    // ── The attack: bypass the picker entirely and POST the Saturday 10:00
    //    slot straight at tenant A's booking endpoint — in hours for tenant
    //    B, but OUT of hours for tenant A (weekday-only). ────────────────────
    const gamedStart = `${WEEKEND_DAY}T10:00:00.000Z`;
    const gamedEnd = `${WEEKEND_DAY}T11:00:00.000Z`;
    const rejectedA = await attemptBooking(page.request, tenantA.tenantId, 'a-gamed', gamedStart, gamedEnd);
    expect(rejectedA.status, `expected 400, got ${rejectedA.status}: ${JSON.stringify(rejectedA.body)}`).toBe(400);
    expect(rejectedA.body.error).toBe('VALIDATION_ERROR');
    expect(String(rejectedA.body.message)).toMatch(/outside booking hours/i);

    // ── Durable proof of NO side effect — the write-side twin refused
    //    BEFORE any customer/job/appointment was created. ───────────────────
    expect(await customerCount(page.request, tenantA)).toBe(beforeCountA);

    // ── T2 / control — the IDENTICAL instant, posted to tenant B's OWN
    //    endpoint, is genuinely in hours for B and succeeds: the guard reads
    //    EACH tenant's own hours, it is not a global block, and a rejection
    //    is specifically about hours, not booking having broken outright. ──
    const acceptedB = await attemptBooking(page.request, tenantB.tenantId, 'b-control', gamedStart, gamedEnd);
    expect(acceptedB.status, `expected 201, got ${acceptedB.status}: ${JSON.stringify(acceptedB.body)}`).toBe(201);
    expect(await customerCount(page.request, tenantB)).toBe(beforeCountB + 1);
    // Tenant A's count is untouched by tenant B's successful booking.
    expect(await customerCount(page.request, tenantA)).toBe(beforeCountA);

    // ── Control (same tenant, not an over-broad refusal) — a genuinely
    //    in-hours slot for tenant A on the SAME weekday still succeeds. ─────
    const legitStart = `${WEEKDAY_DAY}T09:00:00.000Z`;
    const legitEnd = `${WEEKDAY_DAY}T10:00:00.000Z`;
    const acceptedA = await attemptBooking(page.request, tenantA.tenantId, 'a-legit', legitStart, legitEnd);
    expect(acceptedA.status, `expected 201, got ${acceptedA.status}: ${JSON.stringify(acceptedA.body)}`).toBe(201);
    expect(await customerCount(page.request, tenantA)).toBe(beforeCountA + 1);

    expect(pageErrors, 'no uncaught page errors while loading the public booking page').toEqual([]);
  });
});
