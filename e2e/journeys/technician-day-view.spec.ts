import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.4 — technician day view reachability, real Postgres, harness issue #1086
 * CLOSED.
 *
 * `test/integration/dispatch-technician-day-window.test.ts` already proves
 * `getDayBoundaries` includes a 23:00-local appointment for a
 * negative-UTC-offset tenant, and `technician-location-authz.test.ts`
 * proves `PgTechnicianLocationAuthorizer` refuses a cross-tenant technician
 * id — both at the function level, real Postgres, T1. This spec proves the
 * SAME two guarantees reachable through the real running app: Carlos
 * (tenant A, role technician) opens `/technician/day` and sees only his own
 * appointments, including one scheduled at 23:00 America/Los_Angeles local
 * time on the tenant's calendar date; and a forged request substituting
 * tenant B's technician id — issued from Carlos's own authenticated session
 * — is refused with 403 (the SEC-22 guard in packages/api/src/dispatch/routes.ts).
 *
 * ISSUE #1086 (harness, not product): every OTHER real-Postgres Playwright
 * project in this repo (`chromium`'s legacy pair, `chromium-devauth`) forces
 * `DEV_AUTH_BYPASS=true` on its api webServer so the owner's unsigned-JWT
 * bootstrap works. But `app.ts` only wires the DB-authoritative
 * authorization loader (the one that fills `req.auth.canonicalUserId`) when
 * `pool && !isDevAuthBypassEnabled()` — so under those projects
 * canonicalUserId is NEVER populated, and the SEC-22 guard in this exact
 * route (`technicianId !== req.auth!.canonicalUserId`) is vacuously true for
 * ANY id, including a technician's own. This file now runs EXCLUSIVELY under
 * the `chromium-noauthbypass` Playwright project (playwright.config.ts;
 * technician-day-view.spec.ts is excluded from `chromium`'s testIgnore and
 * listed in NO_AUTH_BYPASS_SPECS) — that project's api webServer does not
 * set DEV_AUTH_BYPASS, so the real loader IS wired. Since the unsigned-JWT
 * bypass shortcut is unavailable there, the OWNER's session is now also an
 * HMAC-signed token (see bootstrapOwnerTenant below) — nothing in this file
 * depends on DEV_AUTH_BYPASS anymore.
 *
 * Bootstrap pattern mirrors e2e/journeys/accept-invitation.spec.ts (owner
 * bootstrap + technician invite/webhook-join + HMAC tenant-scoped token).
 */

const API_URL =
  process.env.E2E_NOAUTHBYPASS_API_URL ?? process.env.E2E_API_URL ?? 'http://localhost:3002';

const REPORT_DIR = 'docs/audit/lane-reports/8-4-technician-surfaces';

// Suppress the welcome / what's-new walkthrough modals so they don't cover
// the day view in the screenshot (mirrors dispatch-drag-proposal.spec.ts).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * HMAC-SHA256 dev token carrying an EXPLICIT tenant_id claim, verified by
 * verifyClerkSession's CLERK_DEV_HMAC_TOKENS path (packages/api/src/auth/clerk.ts
 * decodeClerkToken). Signed with '' to match `CLERK_SECRET_KEY ?? ''` when
 * the API runs with no real Clerk secret configured. Used for BOTH the owner
 * and the technician in this file — see the issue #1086 comment above for
 * why the owner can no longer use the unsigned-JWT DEV_AUTH_BYPASS shortcut.
 */
function hmacToken(sub: string, tenantId: string, role: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub,
    sid: `e2e-session-${sub}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', Buffer.from('')).update(input).digest('base64url');
  return `${input}.${sig}`;
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

/** Read-only psql SELECT — no writes, no bypass. Mirrors queryOne/queryScalar
 * in e2e/journeys/onboarding-identity.spec.ts and accept-invitation.spec.ts. */
function queryScalar(sql: string): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return '';
  return execFileSync('psql', [databaseUrl, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

/**
 * #1133 workaround: the request transaction commits on `res.finish`, AFTER
 * the HTTP response is already flushed to the client — a read fired
 * immediately after a 200/201 can race the commit and see nothing yet.
 * Retries a scalar read for up to ~2s until it's non-empty.
 */
function queryScalarUntilNonEmpty(sql: string, timeoutMs = 2000): string {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = queryScalar(sql);
    if (last) return last;
  }
  return last;
}

function pollDbSnapshot(label: string, sql: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
    writeFileSync(`${REPORT_DIR}/${label}.snapshot.txt`, out);
  } catch (err) {
    writeFileSync(
      `${REPORT_DIR}/${label}.snapshot.txt`,
      `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function allDayHours() {
  const open = { open: '00:00', close: '23:59' };
  return { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open };
}

/**
 * Tenant-local wall-clock -> UTC instant, mirroring
 * packages/web/src/utils/formatInTenantTz.ts's `tenantWallClockToUtc`
 * (duplicated here rather than imported across the web/e2e package
 * boundary — pure Intl-based arithmetic, no React).
 */
function tenantWallClockToUtc(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = time.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ts: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const rendered = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return rendered - ts;
  };
  let ts = wallClockAsUtc - offsetAt(wallClockAsUtc);
  ts = wallClockAsUtc - offsetAt(ts);
  return new Date(ts);
}

/** Today's calendar date in `timezone`, as YYYY-MM-DD. */
function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

/**
 * Bootstraps a fresh owner tenant through the REAL Clerk webhook, then mints
 * the owner an HMAC-signed session token (issue #1086 — no DEV_AUTH_BYPASS
 * available in this project, so the old unsigned-JWT shortcut cannot work).
 * The webhook itself creates the tenant + the owner's `users` row
 * (webhooks/routes.ts's "create the OWNER's membership row" insert); the
 * tenant id is read back with a read-only SQL SELECT (no writes) so the
 * HMAC token can carry the real `tenant_id` claim `decodeClerkToken`/
 * `resolveAuthorization` require.
 */
async function bootstrapOwnerTenant(
  request: APIRequestContext,
  label: string,
): Promise<{ sub: string; authHeaders: Record<string, string>; tenantId: string }> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;

  const webhookRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const tenantId = queryScalarUntilNonEmpty(`SELECT tenant_id FROM users WHERE clerk_user_id = '${sub}' LIMIT 1;`);
  expect(tenantId, `${label}: real webhook must have created a users row for ${sub}`).toMatch(UUID_RE);

  const authHeaders = { Authorization: `Bearer ${hmacToken(sub, tenantId, 'owner')}` };

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status(), `${label} /api/me -> ${await meRes.text()}`).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id, `${label}: the DB-authoritative loader must resolve the SAME tenant`).toBe(tenantId);

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Technician Day E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Los_Angeles',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { sub, authHeaders, tenantId };
}

async function inviteAndJoinTechnician(
  request: APIRequestContext,
  ownerHeaders: Record<string, string>,
  tenantId: string,
  label: string,
): Promise<{ sub: string; token: string; techId: string }> {
  const techEmail = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({ email: techEmail, role: 'technician' }),
  });
  expect(inviteRes.status(), `POST /api/users/invitations (${label}) -> ${await inviteRes.text()}`).toBe(201);
  const invitation = (await inviteRes.json()) as { id?: string };
  const invitationId = invitation.id!;

  const techSub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: {
      id: techSub,
      email_addresses: [{ email_address: techEmail }],
      public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status(), `invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);

  const token = hmacToken(techSub, tenantId, 'technician');
  const techMeRes = await request.get(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  expect(techMeRes.status(), `technician /api/me (${label}) -> ${await techMeRes.text()}`).toBe(200);
  const techMe = (await techMeRes.json()) as { internal_user_id?: string };
  expect(techMe.internal_user_id).toMatch(UUID_RE);

  return { sub: techSub, token, techId: techMe.internal_user_id! };
}

test.describe('technician day view (4.4) — real Postgres, no DEV_AUTH_BYPASS (issue #1086)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container. Run with --project=chromium-noauthbypass.',
  );

  let apiCtx: APIRequestContext;
  let laToday: string;
  let ownerA: Awaited<ReturnType<typeof bootstrapOwnerTenant>>;
  let carlos: Awaited<ReturnType<typeof inviteAndJoinTechnician>>;
  let techB: Awaited<ReturnType<typeof inviteAndJoinTechnician>>;
  let lateJob: CreatedEntity;

  test.beforeAll(async () => {
    if (!canRun) return;
    apiCtx = await pwRequest.newContext();
    laToday = todayInTz('America/Los_Angeles');

    // ── Tenant A: Carlos with a 23:00-local appointment ─────────────────────
    ownerA = await bootstrapOwnerTenant(apiCtx, 'ownera');
    carlos = await inviteAndJoinTechnician(apiCtx, ownerA.authHeaders, ownerA.tenantId, 'carlos');

    const customer = await postJson(apiCtx, `${API_URL}/api/customers`, ownerA.authHeaders, {
      firstName: 'LateNight',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '555-0177',
      email: `latenight+${Date.now()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const location = await postJson(apiCtx, `${API_URL}/api/locations`, ownerA.authHeaders, {
      customerId: customer.id,
      label: 'Home',
      street1: '3 Late Night Ave',
      city: 'Los Angeles',
      state: 'CA',
      postalCode: '90001',
      isPrimary: true,
    });
    const lateStartIso = tenantWallClockToUtc(laToday, '23:00', 'America/Los_Angeles').toISOString();
    lateJob = await postJson(apiCtx, `${API_URL}/api/jobs`, ownerA.authHeaders, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Carlos late-night job',
      priority: 'normal',
      scheduledStart: lateStartIso,
      durationMin: 60,
      timezone: 'America/Los_Angeles',
      technicianId: carlos.techId,
    });

    // ── Tenant B, same run: its own technician, never visible to Carlos ────
    const ownerB = await bootstrapOwnerTenant(apiCtx, 'ownerb');
    techB = await inviteAndJoinTechnician(apiCtx, ownerB.authHeaders, ownerB.tenantId, 'techb');

    pollDbSnapshot(
      '4.4-technician-day-appointment',
      `SELECT a.id, a.scheduled_start, a.timezone, aa.technician_id ` +
        `FROM appointments a JOIN appointment_assignments aa ON aa.appointment_id = a.id ` +
        `WHERE a.job_id = '${lateJob.id}';`,
    );
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test('Carlos\'s OWN request succeeds now that canonicalUserId is DB-resolved (issue #1086 closed for this route)', async () => {
    const carlosHeaders = { Authorization: `Bearer ${carlos.token}` };
    const ownRequestRes = await apiCtx.get(
      `${API_URL}/api/dispatch/technician/${carlos.techId}/appointments?date=${laToday}`,
      { headers: carlosHeaders },
    );
    expect(
      ownRequestRes.status(),
      `Carlos's own request -> ${ownRequestRes.status()}: ${await ownRequestRes.text()}`,
    ).toBe(200);
    const ownBody = (await ownRequestRes.json()) as { appointments: Array<{ jobId: string }> };
    expect(
      ownBody.appointments.some((a) => a.jobId === lateJob.id),
      'the 23:00-local job must be on Carlos\'s OWN day, read through Carlos\'s OWN session',
    ).toBe(true);
  });

  test('Carlos sees only his own day in the real browser, including a 23:00-local appointment; tenant B\'s technician id is refused', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── The 4xx refusal: Carlos's OWN session requesting tenant B's
    //    technician id — the story's explicit ask (SEC-22). ─────────────────
    const carlosHeaders = { Authorization: `Bearer ${carlos.token}` };
    const forgedRes = await page.request.get(
      `${API_URL}/api/dispatch/technician/${techB.techId}/appointments?date=${laToday}`,
      { headers: carlosHeaders },
    );
    expect(forgedRes.status(), 'a technician requesting another tenant\'s technician id must be refused').toBe(403);
    const forgedBody = (await forgedRes.json()) as { error?: string };
    expect(forgedBody.error).toBe('FORBIDDEN');

    // ── Browser reachability: Carlos's real /technician/day page, now
    //    actually rendering his appointments (issue #1086 closed). ─────────
    await installClerkStub(page, { signedIn: true, sub: carlos.sub, token: carlos.token });
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
    await page.goto('/technician/day');
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('technician-day-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('technician-day-error')).toHaveCount(0, { timeout: 15_000 });

    const appointmentCard = page.getByTestId('technician-day-appointment').first();
    await expect(appointmentCard).toBeVisible({ timeout: 15_000 });
    await expect(appointmentCard.getByTestId('technician-day-customer')).toContainText('LateNight');
    // 23:00-local boundary — the card must show the tenant-local wall-clock
    // time, not a UTC-shifted one.
    await expect(appointmentCard.getByTestId('technician-day-time')).toContainText('11:00');

    await page.screenshot({
      path: `${REPORT_DIR}/4.4-technician-day-own-appointments.png`,
      fullPage: true,
    });

    expect(pageErrors, 'no uncaught page errors on the technician day view').toEqual([]);
  });
});
