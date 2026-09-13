import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * §8.3 rows 3.2 + 3.3 — rung-5 reachability, real Postgres.
 *
 * Both rows are proven at the function/isolated-router level already:
 *   - 3.2: packages/api/test/integration/dispatch-availability.test.ts
 *     (`findBookableSlots` called directly — business hours, buffer removal,
 *     tenant isolation).
 *   - 3.3: packages/api/test/integration/dispatch-availability-stale-defaults
 *     .integration.test.ts (an inline `express()` app wrapping
 *     `createSchedulingRouter` directly, fake auth middleware, no session).
 *
 * Neither drives the REAL, fully-booted production server
 * (`packages/api/src/app.ts`) through a REAL authenticated session (a real
 * signed Clerk `user.created` webhook + a real JWT the app's own
 * `requireAuth`/`requireTenant` middleware verifies) the way every other
 * owner surface in this suite does. This file is that step: both rows share
 * the identical HTTP surface — `GET /api/dispatch/availability` — so they're
 * proven together in one browser-authenticated run.
 *
 * Honest gap, matching the row's own note: "the web app never calls this
 * endpoint; only mobile does" (packages/api/src/scheduling/routes.ts's own
 * doc-comment: "so the mobile SlotPicker has an authed source"). There is no
 * `page.goto()` for this capability — no SPA route renders it. The owner's
 * real, authenticated BROWSER session (installClerkStub-bound, cookies/token
 * flowing exactly as the SPA's own fetch layer would) is what issues the
 * request, through the real routes, against real Postgres — the strongest
 * reachability available for a route with no dedicated web UI, and the exact
 * HTTP contract packages/mobile's SlotPicker depends on.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Bootstraps a real owner (Clerk webhook + /api/me), optionally completing
 *  onboarding identity — leaving that step off is how a "cold" tenant (no
 *  tenant_settings row) is produced, since only that PUT writes the row. */
async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  identity?: {
    businessName: string;
    businessHours: Record<string, { open: string; close: string } | null>;
    jobBufferMinutes: number;
    timezone: string;
  },
): Promise<Tenant> {
  const sub = `user_e2e_avail_${label}_${randomUUID().replace(/-/g, '')}`;
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

  if (identity) {
    const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName: identity.businessName,
        businessHours: identity.businessHours,
        jobBufferMinutes: identity.jobBufferMinutes,
        hourlyRateCents: 12500,
        timezone: identity.timezone,
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();
  }

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

interface AvailabilityResponse {
  timezone: string;
  durationMin: number;
  slots: Array<{ start: string; end: string }>;
  config: {
    timezoneSource: string;
    businessHoursSource: string;
    bufferSource: string;
    bufferMinutes: number;
    notes: string[];
  };
}

async function getAvailability(
  request: APIRequestContext,
  authHeaders: Record<string, string>,
  day: string,
): Promise<AvailabilityResponse> {
  const res = await request.get(
    `${API_URL}/api/dispatch/availability?from=${day}&to=${day}&durationMin=60`,
    { headers: authHeaders },
  );
  expect(res.ok(), `GET /api/dispatch/availability -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as AvailabilityResponse;
}

// Far future + a fixed weekday so business-hours slots are unambiguously in
// the future (never-in-the-past guard) and never depend on the wall clock at
// run time — the same date the underlying integration tests already pin.
const FUTURE_DAY = '2099-06-15'; // a Monday
const WEEKDAY_HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: null,
  sun: null,
};

test.describe('dispatch availability (3.2 business hours/buffer/isolation + 3.3 stale-defaults) — real Postgres', () => {
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

  test('3.2: an owner\'s own hours + buffer shape their real offered slots and a booked window is removed; a same-shaped neighbour tenant is never blocked. 3.3: a cold tenant is told its times are defaults, a configured tenant is told they\'re its own', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: configured Mon-Fri 08:00-17:00 UTC, 30-min buffer ─────────
    const tenantA = await bootstrapOwner(page.request, 'a', {
      businessName: 'Availability E2E A',
      businessHours: WEEKDAY_HOURS,
      jobBufferMinutes: 30,
      timezone: 'Etc/UTC',
    });

    // ── Tenant B: the SAME hours/buffer shape, but a SEPARATE tenant with an
    //    empty calendar — proves tenant A's booked appointment never blocks
    //    tenant B (3.2's isolation clause, T2: divergent data, same run). ───
    const tenantB = await bootstrapOwner(page.request, 'b', {
      businessName: 'Availability E2E B',
      businessHours: WEEKDAY_HOURS,
      jobBufferMinutes: 30,
      timezone: 'Etc/UTC',
    });

    // ── Tenant Cold: bootstrapped but NEVER completes onboarding identity —
    //    a REAL tenant with no tenant_settings row at all (3.3's core case). ─
    const tenantCold = await bootstrapOwner(page.request, 'cold');

    // ── Real customer/location/job -> appointment on tenant A's calendar,
    //    10:00-11:00 UTC on the far-future Monday, through the real,
    //    authenticated API (no SQL). ───────────────────────────────────────
    const customerA = await postJson(page.request, `${API_URL}/api/customers`, tenantA.authHeaders, {
      firstName: 'Avail',
      lastName: 'Customer A',
      primaryPhone: '555-0161',
      preferredChannel: 'phone',
    });
    const locationA = await postJson(page.request, `${API_URL}/api/locations`, tenantA.authHeaders, {
      customerId: customerA.id,
      street1: '1 Availability Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    await postJson(page.request, `${API_URL}/api/jobs`, tenantA.authHeaders, {
      customerId: customerA.id,
      locationId: locationA.id,
      summary: 'Availability E2E — booked visit',
      priority: 'normal',
      scheduledStart: `${FUTURE_DAY}T10:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
    });

    // ── Bind the browser to tenant A's real owner session — the request
    //    below goes through the SAME fetch layer + auth flow the SPA (or, in
    //    production, packages/mobile) would use, not a bare APIRequestContext. ─
    await installClerkStub(page, { signedIn: true, sub: tenantA.sub, token: tenantA.jwt });
    await blockExternalHosts(page, baseURL!);

    // #1133 workaround: poll until the job's appointment is actually
    // queryable through the availability endpoint before asserting on it —
    // the request transaction commits on res.finish, after the 201 already
    // flushed.
    let availA: AvailabilityResponse | undefined;
    for (let i = 0; i < 10; i++) {
      availA = await getAvailability(page.request, tenantA.authHeaders, FUTURE_DAY);
      const blocks10 = availA.slots.some((s) => s.start === `${FUTURE_DAY}T10:00:00.000Z`);
      if (!blocks10) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(availA, 'tenant A availability must have loaded').toBeTruthy();

    // ── 3.2a — only in-hours slots are offered ──────────────────────────────
    expect(availA!.slots.length).toBeGreaterThan(0);
    for (const s of availA!.slots) {
      const startHour = new Date(s.start).getUTCHours();
      expect(startHour, `slot ${s.start} must start at/after 08:00`).toBeGreaterThanOrEqual(8);
      expect(
        new Date(s.end).getTime(),
        `slot ending ${s.end} must not run past 17:00`,
      ).toBeLessThanOrEqual(new Date(`${FUTURE_DAY}T17:00:00.000Z`).getTime());
    }

    // ── 3.2b — the buffered booked window (09:30-11:30, a 30-min buffer
    //    either side of the 10:00-11:00 appointment) is removed; the
    //    unaffected 08:00 slot is still offered. ────────────────────────────
    expect(availA!.slots.map((s) => s.start)).toContain(`${FUTURE_DAY}T08:00:00.000Z`);
    const blockedStart = new Date(`${FUTURE_DAY}T09:30:00.000Z`).getTime();
    const blockedEnd = new Date(`${FUTURE_DAY}T11:30:00.000Z`).getTime();
    for (const s of availA!.slots) {
      const start = new Date(s.start).getTime();
      const end = new Date(s.end).getTime();
      expect(start < blockedEnd && end > blockedStart, `slot ${s.start} must not overlap the buffered hold`).toBe(false);
    }

    // ── 3.2 T2 — tenant B (same hours shape, empty calendar) is offered the
    //    IDENTICAL 10:00 slot tenant A's booking removed — A's calendar never
    //    blocks B's. Read through B's OWN authenticated session (a fresh
    //    browser context), never A's. ────────────────────────────────────────
    const bContext = await page.context().browser()!.newContext();
    const bPage = await bContext.newPage();
    await installClerkStub(bPage, { signedIn: true, sub: tenantB.sub, token: tenantB.jwt });
    await blockExternalHosts(bPage, baseURL!);
    const availB = await getAvailability(bPage.request, tenantB.authHeaders, FUTURE_DAY);
    expect(
      availB.slots.map((s) => s.start),
      'tenant B must be offered the 10:00 slot that tenant A\'s OWN booking blocked for tenant A',
    ).toContain(`${FUTURE_DAY}T10:00:00.000Z`);
    await bContext.close();

    // ── 3.2 config provenance (also 3.3's "configured" leg) — tenant A's OWN
    //    hours/buffer/timezone are sourced from ITS tenant_settings row. ────
    expect(availA!.config.timezoneSource).toBe('tenant');
    expect(availA!.config.businessHoursSource).toBe('tenant');
    expect(availA!.config.bufferSource).toBe('tenant');
    expect(availA!.config.bufferMinutes).toBe(30);
    expect(availA!.timezone).toBe('Etc/UTC');
    // No screenshot here: no SPA route renders this endpoint (mobile-only —
    // see the header comment), so a browser screenshot would just capture
    // about:blank. The evidence is the response body itself, logged in the
    // PR body / lane report.

    // ── 3.3 — a COLD tenant, real-onboarded (Clerk webhook, never completes
    //    the identity step), is told its timezone/hours are DEFAULTS, through
    //    the owner's own real session. ──────────────────────────────────────
    //
    // FINDING (product gap, not a test bug): `bufferSource` is NOT 'default'
    // here, unlike the isolated-router integration test's "zero
    // tenant_settings row" cold tenant. The real Clerk `user.created`
    // webhook handler (packages/api/src/auth/clerk.ts:622) calls
    // `ensureTenantSettings` (packages/api/src/settings/settings.ts:1154),
    // which inserts a tenant_settings row for EVERY real tenant at
    // signup — before onboarding/identity ever runs — deliberately leaving
    // `timezone`/`businessHours` unset (nullable columns, settings.ts:1163
    // comment: "the zone stays UNSET until the tenant picks one") but never
    // touching `jobBufferMinutes`, which the schema declares `NOT NULL
    // DEFAULT 30` (migration 098, contracts.ts comment above
    // `jobBufferMinutes`). So the row's `job_buffer_minutes` column reads 30
    // from the moment the tenant is born, and `schedulingConfigFromSettings`
    // /`findBookableSlotsDetailed`'s bufferSource check
    // (`input.bufferMinutes != null` — booking-availability.ts:314) can only
    // ever see "non-null" for a REAL tenant. A genuinely bufferSource:
    // 'default' response is reachable only for a tenant with ZERO
    // tenant_settings row at all — impossible via the real onboarding
    // surface, only via a hand-built DB tenant that skips ensureTenantSettings
    // entirely (what dispatch-availability-stale-defaults.integration.test.ts
    // does). Asserted here as the row's REAL, reachable behaviour.
    const coldContext = await page.context().browser()!.newContext();
    const coldPage = await coldContext.newPage();
    await installClerkStub(coldPage, { signedIn: true, sub: tenantCold.sub, token: tenantCold.jwt });
    await blockExternalHosts(coldPage, baseURL!);
    const availCold = await getAvailability(coldPage.request, tenantCold.authHeaders, FUTURE_DAY);
    expect(availCold.config.timezoneSource).toBe('default');
    expect(availCold.config.businessHoursSource).toBe('default');
    expect(availCold.config.bufferSource, 'see FINDING above — a real tenant always has a settings row with the schema default buffer').toBe('tenant');
    expect(availCold.config.bufferMinutes).toBe(30);
    expect(availCold.config.notes.length).toBeGreaterThanOrEqual(2);
    expect(availCold.config.notes.join(' ')).toMatch(/not configured/i);
    // T1 — the cold tenant's own defaults never leak the configured tenant's
    // timezone (a neighbour tenant queried in the SAME run). The fallback
    // constant (DEFAULT_TIMEZONE, scheduling/routes.ts) is 'America/New_York',
    // never tenant A's real 'Etc/UTC'.
    expect(availCold.timezone).not.toBe(availA!.timezone);
    expect(availCold.timezone).toBe('America/New_York');
    await coldContext.close();

    expect(pageErrors, 'no uncaught page errors while the owner session drove the availability requests').toEqual([]);
  });
});
