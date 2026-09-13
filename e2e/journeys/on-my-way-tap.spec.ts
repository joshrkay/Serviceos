import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.5 — "on my way" tap, real Postgres, no DEV_AUTH_BYPASS (issue #1086).
 *
 * `TechnicianDayView.tsx`'s `sendOnMyWay()` is a REAL, wired affordance (the
 * "technician-day-on-my-way" button) that POSTs
 * `/api/dispatch/appointments/:id/en-route` — unlike the 4.6 chip row (see
 * running-late-chip.spec.ts), this one actually calls the API. This spec
 * proves the one audited act it fires ("on my way" is "the human acting
 * directly, not an AI proposal" — dispatch/routes.ts's own doc comment)
 * reachable from Carlos's real browser session:
 *
 *   1. Tapping the button fires exactly one
 *      `appointment.en_route_triggered` audit row with a TECH actor
 *      (actor_id = Carlos's Clerk sub, actor_role = 'technician' — the
 *      DB-authoritative role, not merely the token's claim).
 *   2. It also writes the customer ETA dispatch row — `delay_notice_state`,
 *      keyed `${appointmentId}:en_route`, consent-gated (the fixture
 *      customer has smsConsent=true so it queues over sms; a non-consenting
 *      customer's tenant B counterpart is a separate leg, out of scope here
 *      — see running-late-chip.spec.ts for that gating leg).
 *   3. T2 — tenant B's technician taps their OWN appointment in the SAME
 *      run and gets their OWN isolated rows; tenant A's rows are untouched.
 *
 * Runs under the `chromium-noauthbypass` Playwright project only (see
 * playwright.config.ts's NO_AUTH_BYPASS_SPECS / technician-day-view.spec.ts's
 * header comment for the full issue #1086 rationale).
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

async function postSignedWebhook(request: APIRequestContext, body: Record<string, unknown>) {
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

/** Tab-delimited multi-column single-row read (mirrors onboarding-identity.spec.ts's queryOne). */
function queryOne(sql: string): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const out = execFileSync('psql', [databaseUrl, '-t', '-A', '-F', '\t', '-c', sql], {
    encoding: 'utf8',
  }).trim();
  return out || null;
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

function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

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

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `On My Way E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
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

interface Fixture {
  owner: { sub: string; authHeaders: Record<string, string>; tenantId: string };
  tech: { sub: string; token: string; techId: string };
  appointment: CreatedEntity;
  customerName: string;
}

async function seedFixture(
  request: APIRequestContext,
  label: string,
  timezone: string,
): Promise<Fixture> {
  const owner = await bootstrapOwnerTenant(request, `${label}owner`);
  const tech = await inviteAndJoinTechnician(request, owner.authHeaders, owner.tenantId, `${label}tech`);

  const customerName = `OnMyWay ${label.toUpperCase()} ${Date.now()}`;
  const customer = await postJson(request, `${API_URL}/api/customers`, owner.authHeaders, {
    firstName: 'OnMyWay',
    lastName: `${label.toUpperCase()} ${Date.now()}`,
    primaryPhone: '555-0199',
    email: `onmyway-${label}+${Date.now()}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
    source: 'referral',
  });
  const location = await postJson(request, `${API_URL}/api/locations`, owner.authHeaders, {
    customerId: customer.id,
    label: 'Home',
    street1: `${label} On My Way Ave`,
    city: 'Chicago',
    state: 'IL',
    postalCode: '60601',
    isPrimary: true,
  });
  const today = todayInTz(timezone);
  const startIso = tenantWallClockToUtc(today, '14:00', timezone).toISOString();
  const job = await postJson(request, `${API_URL}/api/jobs`, owner.authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} on-my-way job`,
    priority: 'normal',
    scheduledStart: startIso,
    durationMin: 60,
    timezone,
    technicianId: tech.techId,
  });
  // #1133 workaround — read-after-write race on the job/appointment sync.
  const appointment = queryScalarUntilNonEmpty(
    `SELECT a.id FROM appointments a WHERE a.job_id = '${job.id}' LIMIT 1;`,
  );
  expect(appointment, `${label}: appointment must exist for job ${job.id}`).toMatch(UUID_RE);

  return { owner, tech, appointment: { id: appointment }, customerName: customer.firstName as string };
}

test.describe('on-my-way tap (4.5) — real Postgres, no DEV_AUTH_BYPASS (issue #1086)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres with --project=chromium-noauthbypass.',
  );

  test('Carlos taps "on my way"; one appointment.en_route_triggered audit (TECH actor) + a customer ETA dispatch row; T2', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const fixtureA = await seedFixture(page.request, 'a', 'America/Chicago');
    const fixtureB = await seedFixture(page.request, 'b', 'America/Chicago');

    // ── Carlos (tenant A) taps "on my way" from his real day view. ─────────
    await installClerkStub(page, { signedIn: true, sub: fixtureA.tech.sub, token: fixtureA.tech.token });
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
    await expect(page.getByTestId('technician-day-error')).toHaveCount(0, { timeout: 15_000 });

    const cardA = page.getByTestId('technician-day-appointment').first();
    await expect(cardA).toBeVisible({ timeout: 15_000 });

    const enRouteResPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/en-route'),
    );
    await cardA.getByTestId('technician-day-on-my-way').click();
    const enRouteRes = await enRouteResPromise;
    expect(enRouteRes.status(), `POST .../en-route (A) -> ${enRouteRes.status()}`).toBe(202);
    const enRouteBody = (await enRouteRes.json()) as { notified?: boolean };
    expect(enRouteBody.notified, 'A\'s consenting customer must be notified').toBe(true);

    await expect(cardA.getByTestId('technician-day-on-my-way')).toContainText('Customer notified', {
      timeout: 15_000,
    });
    await page.screenshot({ path: `${REPORT_DIR}/4.5-on-my-way-tap-notified.png`, fullPage: true });

    // ── T2 — tenant B's technician taps their OWN appointment in the SAME
    //    run, through their OWN session. ────────────────────────────────────
    await installClerkStub(page, { signedIn: true, sub: fixtureB.tech.sub, token: fixtureB.tech.token });
    await page.goto('/technician/day');
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });
    const cardB = page.getByTestId('technician-day-appointment').first();
    await expect(cardB).toBeVisible({ timeout: 15_000 });
    const enRouteResBPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/en-route'),
    );
    await cardB.getByTestId('technician-day-on-my-way').click();
    const enRouteResB = await enRouteResBPromise;
    expect(enRouteResB.status(), `POST .../en-route (B) -> ${enRouteResB.status()}`).toBe(202);

    expect(pageErrors, 'no uncaught page errors on the technician day view').toEqual([]);

    // ── Postgres proof — audit + dispatch rows, PER TENANT, isolated. ──────
    pollDbSnapshot(
      '4.5-en-route-audit-a',
      `SELECT tenant_id, actor_id, actor_role, event_type, entity_type, entity_id ` +
        `FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' AND event_type = 'appointment.en_route_triggered';`,
    );
    pollDbSnapshot(
      '4.5-delay-notice-state-a',
      `SELECT idempotency_key, tenant_id, appointment_id, status, channel ` +
        `FROM delay_notice_state WHERE tenant_id = '${fixtureA.owner.tenantId}';`,
    );

    const auditA = queryScalar(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' ` +
        `AND event_type = 'appointment.en_route_triggered' AND entity_id = '${fixtureA.appointment.id}' ` +
        `AND actor_id = '${fixtureA.tech.sub}' AND actor_role = 'technician';`,
    );
    expect(auditA, 'A: exactly one en_route_triggered audit row with the TECH as actor').toBe('1');

    // §12.4d honesty — the ETA dispatch row IS created (proving the tap
    // reaches the coordinator), but it deterministically settles at
    // 'failed' rather than 'sent': see the KNOWN GAP test below for the
    // confirmed product bug (dispatch_analytics' CHECK constraint doesn't
    // list 'en_route_notice_sent'/'en_route_notice_failed', so recording
    // analytics for EVERY en-route delivery throws, which the delivery
    // worker's own catch handler then records as a delivery failure). This
    // assertion accepts 'failed' as a real, reproducible state — not
    // invented around — and pins the exact cause via last_error.
    const stateRow = queryOne(
      `SELECT status, last_error FROM delay_notice_state WHERE idempotency_key = '${fixtureA.appointment.id}:en_route' ` +
        `AND tenant_id = '${fixtureA.owner.tenantId}';`,
    );
    expect(stateRow, 'A: a delay_notice_state row must exist for the en-route notice').toBeTruthy();
    const [stateA, lastErrorA] = (stateRow ?? '\t').split('\t');
    expect(
      ['queued', 'sent', 'fallback_in_app', 'failed'],
      `A: delay_notice_state status -> ${stateA}`,
    ).toContain(stateA);
    if (stateA === 'failed') {
      expect(
        lastErrorA,
        'A: if failed, it must be the KNOWN dispatch_analytics CHECK-constraint bug, not something else',
      ).toContain('dispatch_analytics_event_type_check');
    }

    const auditB = queryScalar(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureB.owner.tenantId}' ` +
        `AND event_type = 'appointment.en_route_triggered' AND entity_id = '${fixtureB.appointment.id}' ` +
        `AND actor_id = '${fixtureB.tech.sub}' AND actor_role = 'technician';`,
    );
    expect(auditB, 'B: exactly one en_route_triggered audit row with ITS OWN tech as actor').toBe('1');

    const crossTenantLeak = queryScalar(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' AND entity_id = '${fixtureB.appointment.id}';`,
    );
    expect(crossTenantLeak, 'A\'s tenant must have ZERO audit rows for B\'s appointment').toBe('0');

    const stateRowB = queryOne(
      `SELECT status, last_error FROM delay_notice_state WHERE idempotency_key = '${fixtureB.appointment.id}:en_route' ` +
        `AND tenant_id = '${fixtureB.owner.tenantId}';`,
    );
    expect(stateRowB, 'B: a delay_notice_state row must exist for ITS OWN en-route notice').toBeTruthy();
    const [stateB, lastErrorB] = (stateRowB ?? '\t').split('\t');
    expect(
      ['queued', 'sent', 'fallback_in_app', 'failed'],
      `B: delay_notice_state status -> ${stateB}`,
    ).toContain(stateB);
    if (stateB === 'failed') {
      expect(
        lastErrorB,
        'B: if failed, it must be the KNOWN dispatch_analytics CHECK-constraint bug, not something else',
      ).toContain('dispatch_analytics_event_type_check');
    }
  });

  test('KNOWN GAP — en-route delivery should record analytics + settle "sent", not fail on a schema mismatch', () => {
    // PRODUCT BUG (not a test artifact — out of scope for this TEST-ONLY
    // lane to fix): packages/api/src/notifications/delay-notifications.ts
    // (the delay-delivery queue worker) calls
    // `captureDispatchEvent(deps.analyticsRepo, tenantId,
    // 'en_route_notice_sent', ...)` on the success path (line 546) and
    // `'en_route_notice_failed'` on the failure path (line 569). But the
    // `dispatch_analytics.event_type` CHECK constraint
    // (packages/api/src/db/schema.ts, migration '105_create_dispatch_analytics',
    // ~line 2775) only allows: 'assigned', 'reassigned', 'rescheduled',
    // 'canceled', 'conflict_detected', 'delay_notice_sent',
    // 'delay_notice_failed' — NEITHER en_route_notice_* value is listed.
    // Every "on my way" delivery therefore throws
    // `new row for relation "dispatch_analytics" violates check constraint
    // "dispatch_analytics_event_type_check"` the instant it tries to
    // record analytics — which happens INSIDE the same try/catch as the
    // delivery itself, so the catch handler overwrites the just-set 'sent'
    // status back to 'failed' (see the test above: the delay_notice_state
    // row is real and reachable, but always ends up 'failed' with this
    // exact last_error, never 'sent'). This is 100% reproducible, not
    // flaky — confirmed via two independent tenants in the test above.
    // Flagged for Fable/Josh to ticket; not filed by this lane per §12.4d.
    test.fail(
      true,
      'KNOWN PRODUCT BUG: dispatch_analytics_event_type_check does not list en_route_notice_sent/' +
        'en_route_notice_failed, so every "on my way" delivery fails at the analytics-recording step. ' +
        'See the comment above this test for file:line and the exact error.',
    );
    // Real assertion, not a contrived placeholder: the test above already
    // drove TWO real en-route deliveries (tenants A and B) against this
    // same Postgres instance. If the bug were fixed, at least one
    // 'en_route_notice_sent' row would exist in dispatch_analytics by now.
    const sentCount = queryScalar(
      `SELECT count(*) FROM dispatch_analytics WHERE event_type = 'en_route_notice_sent';`,
    );
    expect(
      Number(sentCount || '0'),
      'once fixed, at least the two en-route deliveries above should have recorded analytics',
    ).toBeGreaterThan(0);
  });
});
