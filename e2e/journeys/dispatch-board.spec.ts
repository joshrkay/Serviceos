import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * The E2E_USE_TEST_DB global-teardown TRUNCATEs every table once this
 * Playwright process exits, so a snapshot must be polled to a file DURING
 * the run rather than inspected afterward from another shell.
 */
function pollDbSnapshot(label: string, sql: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
    writeFileSync(`docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`, out);
  } catch (err) {
    writeFileSync(
      `docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`,
      `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 4.1 — dispatch board reachability, real Postgres.
 *
 * `GET /api/dispatch/board` derives tenant_id exclusively from the verified
 * session (packages/api/src/dispatch/routes.ts SEC-21) and
 * `getDispatchBoardData` scopes every read by that tenant_id
 * (test/integration/dispatch.test.ts's "rejects cross-tenant access to
 * board data" proves this at the function level). This spec proves the
 * SAME guarantee reachable from the real browser at `/dispatch`: an owner
 * sees today's jobs and not tomorrow's, and a second tenant in the SAME
 * run never appears in the first tenant's board — T2 (non-interference),
 * not just T1 (isolation) — per docs/PRD-v5-as-built.md §8.0.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts /
 * signup-to-first-estimate.hermetic.spec.ts. Both tenants use timezone
 * 'Etc/UTC' so "today"/"tomorrow" bucketing needs no DST arithmetic —
 * dispatch.test.ts's own cross-tenant test uses the same UTC-calendar-day
 * convention (`new Date().toISOString().split('T')[0]`).
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

async function postSignedWebhook(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
}

interface CreatedEntity {
  id: string;
  [k: string]: unknown;
}

async function postJson(
  page: import('@playwright/test').Page,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<CreatedEntity> {
  const res = await page.request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CreatedEntity;
}

async function bootstrapOwnerTenant(
  page: import('@playwright/test').Page,
  label: string,
): Promise<{ sub: string; jwt: string; authHeaders: Record<string, string>; tenantId: string }> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const webhookRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status(), `/api/me failed for ${label}: ${await meRes.text()}`).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Dispatch Board E2E ${label.toUpperCase()}`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { sub, jwt, authHeaders, tenantId };
}

async function seedJobAt(
  page: import('@playwright/test').Page,
  authHeaders: Record<string, string>,
  label: string,
  scheduledStartIso: string,
): Promise<CreatedEntity> {
  const stamp = Date.now();
  const customer = await postJson(page, `${API_URL}/api/customers`, authHeaders, {
    firstName: label,
    lastName: `Customer ${stamp}`,
    primaryPhone: '555-0142',
    email: `${label}.customer+${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
    source: 'referral',
  });
  const location = await postJson(page, `${API_URL}/api/locations`, authHeaders, {
    customerId: customer.id,
    label: 'Home',
    street1: '1 Board Test Ave',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
  });
  const job = await postJson(page, `${API_URL}/api/jobs`, authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} dispatch board job`,
    problemDescription: 'Dispatch board reachability seed job',
    priority: 'normal',
    scheduledStart: scheduledStartIso,
    durationMin: 60,
    timezone: 'Etc/UTC',
  });
  return job;
}

function isoDateOnly(d: Date): string {
  return d.toISOString().split('T')[0];
}

test.describe('dispatch board (4.1) — real Postgres', () => {
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

  test('owner A sees only today\'s jobs on the real /dispatch board; owner B never appears', async ({
    page,
    context,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const now = new Date();
    const todayStr = isoDateOnly(now);
    const tomorrowStr = isoDateOnly(new Date(now.getTime() + 24 * 3_600_000));

    // ── Tenant A: two jobs today, one tomorrow ──────────────────────────────
    const ownerA = await bootstrapOwnerTenant(page, 'ownera');
    const jobA1 = await seedJobAt(page, ownerA.authHeaders, 'A1', `${todayStr}T09:00:00.000Z`);
    const jobA2 = await seedJobAt(page, ownerA.authHeaders, 'A2', `${todayStr}T14:00:00.000Z`);
    const jobA3Tomorrow = await seedJobAt(page, ownerA.authHeaders, 'A3', `${tomorrowStr}T12:00:00.000Z`);

    // ── Tenant B, same run: one job today ───────────────────────────────────
    const ownerB = await bootstrapOwnerTenant(page, 'ownerb');
    const jobB1 = await seedJobAt(page, ownerB.authHeaders, 'B1', `${todayStr}T10:00:00.000Z`);

    // ── API-level proof: A's board for today has A's 2 jobs, not tomorrow's,
    //    and not tenant B's — the T2 (non-interference) leg. ────────────────
    const boardARes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`,
      { headers: ownerA.authHeaders },
    );
    expect(boardARes.ok(), `GET board (A) -> ${boardARes.status()}`).toBeTruthy();
    const boardA = (await boardARes.json()) as {
      unassignedAppointments: Array<{ jobId: string }>;
      technicianLanes: Array<{ appointments: Array<{ jobId: string }> }>;
    };
    const boardAJobIds = new Set([
      ...boardA.unassignedAppointments.map((a) => a.jobId),
      ...boardA.technicianLanes.flatMap((l) => l.appointments.map((a) => a.jobId)),
    ]);
    expect(boardAJobIds.has(jobA1.id), 'today job A1 must be on A\'s board').toBe(true);
    expect(boardAJobIds.has(jobA2.id), 'today job A2 must be on A\'s board').toBe(true);
    expect(boardAJobIds.has(jobA3Tomorrow.id), 'tomorrow\'s job A3 must NOT be on today\'s board').toBe(false);
    expect(boardAJobIds.has(jobB1.id), 'tenant B\'s job must never appear on A\'s board').toBe(false);
    expect(boardAJobIds.size, 'A\'s board for today must show exactly the 2 seeded jobs').toBe(2);

    // ── Browser reachability: owner A's real /dispatch page ─────────────────
    await installClerkStub(page, { signedIn: true, sub: ownerA.sub, token: ownerA.jwt });
    await blockExternalHosts(page, baseURL!);
    await page.goto('/dispatch');
    await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('dispatch-board-loading')).toHaveCount(0, { timeout: 15_000 });

    const cardsA = page.getByTestId('appointment-card');
    await expect(cardsA).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(`[data-appointment-id]`).filter({ hasText: '' })).toBeTruthy();

    // Screenshot BEFORE reload.
    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.1-dispatch-board-owner-a-before-reload.png',
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await expect(cardsA).toHaveCount(2, { timeout: 15_000 });
    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.1-dispatch-board-owner-a-after-reload.png',
      fullPage: true,
    });

    // ── Browser reachability: owner B, SAME run, isolated browser context ──
    const bContext = await context.browser()!.newContext();
    const bPage = await bContext.newPage();
    await installClerkStub(bPage, { signedIn: true, sub: ownerB.sub, token: ownerB.jwt });
    await blockExternalHosts(bPage, baseURL!);
    await bPage.goto('/dispatch');
    await expect(bPage.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await expect(bPage.getByTestId('appointment-card')).toHaveCount(1, { timeout: 15_000 });
    await bContext.close();

    pollDbSnapshot(
      '4.1-dispatch-board-appointments',
      `SELECT left(j.tenant_id::text,8) AS tenant, a.job_id, a.scheduled_start, a.status ` +
        `FROM appointments a JOIN jobs j ON j.id = a.job_id ` +
        `WHERE j.tenant_id IN ('${ownerA.tenantId}','${ownerB.tenantId}') ORDER BY 1, 3;`,
    );

    expect(pageErrors, 'no uncaught page errors on the dispatch board').toEqual([]);
  });
});
