import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * PRD 4.7 — "As M, I want lateness detected from where the truck actually is,
 * so I hear it before the customer does." Acceptance: given geofence/dwell
 * signals, when evaluated, then a lateness state with a confidence breakdown.
 *
 * Rung-5 reachability leg, real Postgres, no DEV_AUTH_BYPASS: each tenant's
 * technician posts real GPS pings through `POST /api/technician-location`
 * (the production ingestion route, audited as
 * `technician_location.batch_ingested`); the owner opens the real dispatch
 * board, whose `GET /api/dispatch/board` evaluates lateness from those pings
 * (#1079, dispatch/lateness-resolver.ts), and the appointment card renders it
 * as a badge whose title carries the confidence breakdown.
 *
 * T2: tenant B has its OWN technician parked at its OWN site, but only a few
 * minutes into a one-hour visit — B's board shows B's card with no lateness
 * badge, while A (fifty minutes on site for a thirty-minute visit) shows
 * "Running late". A neighbour's pings never change A's answer, nor A's B's.
 *
 * Runs under `chromium-noauthbypass` (NO_AUTH_BYPASS_SPECS in
 * playwright.config.ts) for its hermetic real-Postgres owner/technician
 * bootstrap — the same harness as running-late-chip.spec.ts (4.6).
 */

const API_URL =
  process.env.E2E_NOAUTHBYPASS_API_URL ?? process.env.E2E_API_URL ?? 'http://localhost:3002';
const REPORT_DIR = 'docs/audit/lane-reports/8-4-technician-surfaces';
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';
const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN = 60_000;

// Two service sites a few kilometres apart (lat/lng on the location row is
// what the evaluator's geofence reads).
const SITE_A = { latitude: 39.7817, longitude: -89.6501 };
const SITE_B = { latitude: 39.8017, longitude: -89.6436 };

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function hmacToken(sub: string, tenantId: string, role: string): string {
  const input = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub,
    sid: `e2e-session-${sub}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  })}`;
  return `${input}.${createHmac('sha256', Buffer.from('')).update(input).digest('base64url')}`;
}

async function postSignedWebhook(request: APIRequestContext, body: Record<string, unknown>) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': `v1,${sig}`,
    },
    data: rawBody,
  });
}

async function postJson(
  request: APIRequestContext,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

function queryScalar(sql: string): string {
  return execFileSync('psql', [process.env.DATABASE_URL!, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

function queryScalarUntilNonEmpty(sql: string, timeoutMs = 2000): string {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = queryScalar(sql);
    if (last) return last;
  }
  return last;
}

async function bootstrapOwnerTenant(request: APIRequestContext, label: string) {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const webhookRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: `${label}-${Date.now()}@serviceos-hermetic.test` }] },
  });
  expect(webhookRes.status()).toBe(200);
  const tenantId = queryScalarUntilNonEmpty(`SELECT tenant_id FROM users WHERE clerk_user_id = '${sub}' LIMIT 1;`);
  expect(tenantId).toMatch(UUID_RE);
  const token = hmacToken(sub, tenantId, 'owner');
  const authHeaders = { Authorization: `Bearer ${token}` };
  expect((await request.get(`${API_URL}/api/me`, { headers: authHeaders })).status()).toBe(200);
  const open = { open: '00:00', close: '23:59' };
  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Lateness Badge E2E ${label.toUpperCase()}`,
      businessHours: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open },
      jobBufferMinutes: 0,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok()).toBeTruthy();
  return { sub, token, authHeaders, tenantId };
}

async function inviteAndJoinTechnician(
  request: APIRequestContext,
  ownerHeaders: Record<string, string>,
  tenantId: string,
  label: string,
) {
  const techEmail = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({ email: techEmail, role: 'technician' }),
  });
  expect(inviteRes.status()).toBe(201);
  const invitationId = ((await inviteRes.json()) as { id: string }).id;
  const techSub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: {
      id: techSub,
      email_addresses: [{ email_address: techEmail }],
      public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status()).toBe(200);
  const token = hmacToken(techSub, tenantId, 'technician');
  const me = (await (
    await request.get(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { internal_user_id: string };
  expect(me.internal_user_id).toMatch(UUID_RE);
  return { token, techId: me.internal_user_id };
}

/** Customer + geocoded service location + a job booked on the technician; returns the appointment id. */
async function bookVisit(
  request: APIRequestContext,
  ownerHeaders: Record<string, string>,
  techId: string,
  site: { latitude: number; longitude: number },
  start: Date,
  durationMin: number,
  label: string,
): Promise<string> {
  const customer = await postJson(request, `${API_URL}/api/customers`, ownerHeaders, {
    firstName: label,
    lastName: `Customer ${Date.now()}`,
    preferredChannel: 'phone',
    source: 'referral',
  });
  const location = await postJson(request, `${API_URL}/api/locations`, ownerHeaders, {
    customerId: customer.id,
    street1: `1 ${label} Ave`,
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
    latitude: site.latitude,
    longitude: site.longitude,
  });
  const job = await postJson(request, `${API_URL}/api/jobs`, ownerHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} lateness visit`,
    priority: 'normal',
    scheduledStart: start.toISOString(),
    durationMin,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });
  const res = await request.get(`${API_URL}/api/appointments?jobId=${job.id}`, { headers: ownerHeaders });
  expect(res.ok()).toBeTruthy();
  const list = (await res.json()) as { id: string }[];
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

/** The technician's own device posts accurate pings parked on the site. */
async function postDwellPings(
  request: APIRequestContext,
  techToken: string,
  techId: string,
  appointmentId: string,
  site: { latitude: number; longitude: number },
  minutesAgo: number[],
) {
  const now = Date.now();
  const res = await request.post(`${API_URL}/api/technician-location`, {
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${techToken}` },
    data: JSON.stringify({
      technicianId: techId,
      pings: minutesAgo.map((m) => ({
        clientPingId: randomUUID(),
        appointmentId,
        lat: site.latitude,
        lng: site.longitude,
        accuracyMeters: 10,
        recordedAt: new Date(now - m * MIN).toISOString(),
        source: 'e2e-device',
      })),
    }),
  });
  expect(res.status(), `POST /api/technician-location -> ${await res.text()}`).toBe(201);
  expect(((await res.json()) as { acceptedCount: number }).acceptedCount).toBe(minutesAgo.length);
}

async function openBoardAs(
  page: import('@playwright/test').Page,
  baseURL: string,
  owner: { sub: string; token: string },
) {
  await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.token });
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
  await page.goto('/dispatch');
}

test.describe('dispatch board lateness badge (4.7) — real pings, real board, real Postgres, no DEV_AUTH_BYPASS', () => {
  const canRun = !process.env.E2E_BASE_URL && hasViteClerkKey() && process.env.E2E_USE_TEST_DB === 'true';
  test.skip(!canRun, 'Requires the local webServer pair against a real Postgres with --project=chromium-noauthbypass.');
  // Both visits sit in "today" (UTC tenant) — too close to midnight and A's
  // visit, started an hour ago, would be on yesterday's board.
  test.skip(new Date().getUTCHours() < 2, 'Needs >= 02:00 UTC so an hour-old visit is on today\'s board.');

  // The board opens on the BROWSER's today; the tenants run on UTC, so the
  // browser does too (otherwise a US-evening run opens yesterday's board).
  test.use({ timezoneId: 'UTC' });

  let apiCtx: APIRequestContext;
  let ownerA: Awaited<ReturnType<typeof bootstrapOwnerTenant>>;
  let ownerB: Awaited<ReturnType<typeof bootstrapOwnerTenant>>;
  let apptA: string;
  let apptB: string;

  test.beforeAll(async () => {
    if (!canRun) return;
    apiCtx = await pwRequest.newContext();
    const now = Date.now();
    const minute = (msAgo: number) => new Date(Math.floor((now - msAgo) / MIN) * MIN);

    // Tenant A: a 30-minute visit that started an hour ago; the truck has
    // been parked on site for ~50 minutes (threshold = 30 + 5 grace).
    ownerA = await bootstrapOwnerTenant(apiCtx, 'lateowner');
    const carlos = await inviteAndJoinTechnician(apiCtx, ownerA.authHeaders, ownerA.tenantId, 'latetech');
    apptA = await bookVisit(apiCtx, ownerA.authHeaders, carlos.techId, SITE_A, minute(60 * MIN), 30, 'LateA');
    await postDwellPings(apiCtx, carlos.token, carlos.techId, apptA, SITE_A, [50, 40, 30, 20, 10, 2]);

    // Tenant B: its own technician parked at its own site, but only a few
    // minutes into a one-hour visit — on track.
    ownerB = await bootstrapOwnerTenant(apiCtx, 'ontimeowner');
    const bea = await inviteAndJoinTechnician(apiCtx, ownerB.authHeaders, ownerB.tenantId, 'ontimetech');
    apptB = await bookVisit(apiCtx, ownerB.authHeaders, bea.techId, SITE_B, minute(5 * MIN), 60, 'OnTimeB');
    await postDwellPings(apiCtx, bea.token, bea.techId, apptB, SITE_B, [4, 2, 1]);
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test("the owner's board shows 'Running late' on the late truck's card with its confidence breakdown; the neighbour's on-time card shows none (T2)", async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await openBoardAs(page, baseURL!, ownerA);
    const cardA = page.locator(`[data-testid="appointment-card"][data-appointment-id="${apptA}"]`);
    await expect(cardA).toBeVisible({ timeout: 20_000 });
    const badgeA = cardA.getByTestId('appointment-lateness-badge');
    await expect(badgeA).toHaveText('Running late');
    await expect(badgeA).toHaveAttribute(
      'title',
      /^Confidence \d+% — recency \d+%, GPS accuracy \d+%, movement \d+%$/,
    );
    // Only tenant A's card is on tenant A's board.
    await expect(page.locator(`[data-appointment-id="${apptB}"]`)).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/4.7-board-running-late-badge.png`, fullPage: true });
    expect(pageErrors).toEqual([]);

    // Ingestion is audited per tenant — the signal the board evaluated.
    expect(
      queryScalar(
        `SELECT COUNT(*) FROM audit_events WHERE tenant_id = '${ownerA.tenantId}' AND event_type = 'technician_location.batch_ingested';`,
      ),
    ).toBe('1');

    const bContext = await page.context().browser()!.newContext({ timezoneId: 'UTC' });
    const bPage = await bContext.newPage();
    try {
      await openBoardAs(bPage, baseURL!, ownerB);
      const cardB = bPage.locator(`[data-testid="appointment-card"][data-appointment-id="${apptB}"]`);
      await expect(cardB).toBeVisible({ timeout: 20_000 });
      await expect(cardB.getByTestId('appointment-lateness-badge')).toHaveCount(0);
      await expect(bPage.locator(`[data-appointment-id="${apptA}"]`)).toHaveCount(0);
      await bPage.screenshot({ path: `${REPORT_DIR}/4.7-board-neighbour-on-track.png`, fullPage: true });
    } finally {
      await bContext.close();
    }

    // A's answer is unchanged after B's board read.
    await page.reload();
    await expect(
      page.locator(`[data-testid="appointment-card"][data-appointment-id="${apptA}"]`).getByTestId(
        'appointment-lateness-badge',
      ),
    ).toHaveText('Running late', { timeout: 20_000 });
  });
});
