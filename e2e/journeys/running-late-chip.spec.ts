import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.6 — "running late in one tap" (the chip row), real Postgres, no
 * DEV_AUTH_BYPASS (issue #1086).
 *
 * §12.4d honesty — this row's acceptance ("Given the chip row, when I tap
 * 10/20/30, then the chip row is the confirm — no second dialog — and a
 * delay notice is written") is NOT met by the product. Two facts, read
 * directly off the running code:
 *
 *   1. The ONLY "chip row" in the app matching that description is
 *      `packages/web/src/components/jobs/TechJobView.tsx`'s "Running
 *      behind?" card (`isRunningBehind`/`delayMinutes` state, declared
 *      lines 684-685; the Yes/No + 10/15/20/60 buttons, lines ~1085-1123).
 *      Neither `isRunningBehind` nor `delayMinutes` is read ANYWHERE else
 *      in the file — `advanceStatus()` (the only function that calls the
 *      API on this screen, lines 808-843) never references them. Tapping
 *      a chip only changes local component state; it never calls
 *      `apiFetch`, never reaches `/api/appointments/:id/running-late`, and
 *      writes NOTHING to Postgres. This spec proves that with a live
 *      network capture: tapping "Yes" then "20" in Carlos's real browser
 *      session produces ZERO matching network requests.
 *   2. The ONE technician-facing surface that actually calls
 *      `POST /api/appointments/:id/running-late` is
 *      `packages/web/src/pages/technician/TechnicianDayView.tsx`'s GPS
 *      auto-detection heuristic (`markRunningLate`, lines 533-554),
 *      reached only through its own two-step delay-prompt dialog
 *      (`technician-day-delay-prompt` -> tap "Accept",
 *      `technician-day-delay-accept`, lines 679-707) — the opposite of
 *      "no second dialog", and not reachable by a deliberate one-tap
 *      chip at all. `packages/api/test/integration/running-late.test.ts`
 *      already proves the ROUTE's real Postgres behavior (audit row +
 *      consent-gated `delay_notice_state` row) once that dialog's Accept
 *      is reached; this spec does not re-prove the route (out of E2E
 *      browser-reachability scope) — it proves the CHIP ROW specifically
 *      is dead UI, and pins the gap. Flagged for Fable/Josh — see the lane
 *      report. Nothing here is faked: no SQL writes, no invented pass.
 *
 * Runs under the `chromium-noauthbypass` Playwright project only (see
 * playwright.config.ts's NO_AUTH_BYPASS_SPECS / technician-day-view.spec.ts's
 * header comment for the full issue #1086 rationale) — reused here only for
 * a hermetic real-Postgres owner/technician bootstrap, not because the
 * SEC-22 gap this issue is about applies to this route.
 */

const API_URL =
  process.env.E2E_NOAUTHBYPASS_API_URL ?? process.env.E2E_API_URL ?? 'http://localhost:3002';

const REPORT_DIR = 'docs/audit/lane-reports/8-4-technician-surfaces';

// Suppress the welcome / what's-new walkthrough modals so they don't cover
// the job view in the screenshot (mirrors dispatch-drag-proposal.spec.ts).
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

function allDayHours() {
  const open = { open: '00:00', close: '23:59' };
  return { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open };
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
      businessName: `Running Late Chip E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
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

test.describe('running-late chip row (4.6) — real Postgres, no DEV_AUTH_BYPASS (issue #1086)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres with --project=chromium-noauthbypass.',
  );

  let apiCtx: APIRequestContext;
  let carlos: Awaited<ReturnType<typeof inviteAndJoinTechnician>>;
  let job: CreatedEntity;

  test.beforeAll(async () => {
    if (!canRun) return;
    apiCtx = await pwRequest.newContext();
    const owner = await bootstrapOwnerTenant(apiCtx, 'chipowner');
    carlos = await inviteAndJoinTechnician(apiCtx, owner.authHeaders, owner.tenantId, 'chiptech');

    const customer = await postJson(apiCtx, `${API_URL}/api/customers`, owner.authHeaders, {
      firstName: 'ChipRow',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '555-0166',
      email: `chiprow+${Date.now()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const location = await postJson(apiCtx, `${API_URL}/api/locations`, owner.authHeaders, {
      customerId: customer.id,
      label: 'Home',
      street1: '4 Chip Row Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    const todayStr = new Date().toISOString().split('T')[0];
    job = await postJson(apiCtx, `${API_URL}/api/jobs`, owner.authHeaders, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Chip row test job',
      priority: 'normal',
      scheduledStart: `${todayStr}T10:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: carlos.techId,
    });
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test('tapping "Yes" then a delay chip (20) never calls any API — the chip row is decorative, dead UI', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const apiRequestsSeen: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/')) apiRequestsSeen.push(`${req.method()} ${url}`);
    });

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
    await page.goto(`/jobs/${job.id}?view=tech`);

    const runningBehindLabel = page.getByText('Running behind?', { exact: true });
    await expect(runningBehindLabel).toBeVisible({ timeout: 15_000 });

    // Snapshot every /api/ request fired just to LOAD the screen, so the
    // post-tap comparison below only counts NEW requests caused by the taps.
    const requestsBeforeTap = apiRequestsSeen.length;

    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByRole('button', { name: '20', exact: true }).click();

    // Give any async handler a real chance to fire before asserting absence.
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: `${REPORT_DIR}/4.6-chip-row-no-api-call.png`,
      fullPage: true,
    });

    const requestsAfterTap = apiRequestsSeen.slice(requestsBeforeTap);
    const delayRelated = requestsAfterTap.filter(
      (r) => /running-late|en-route|delay/.test(r),
    );
    expect(
      delayRelated,
      'tapping the "Running behind?" chip row must not call any delay/running-late/en-route ' +
        `endpoint today (it does not wire to anything) — saw: ${JSON.stringify(requestsAfterTap)}`,
    ).toEqual([]);

    expect(pageErrors, 'no uncaught page errors on the tech job view').toEqual([]);
  });

  test('KNOWN GAP — tapping a delay chip should be the one-tap confirm that writes a running-late notice', async ({
    page,
    baseURL,
  }) => {
    // Desired behavior per the §8.4 PRD row (acceptance: "Given the chip
    // row, when I tap 10/20/30, then the chip row is the confirm — no
    // second dialog — and a delay notice is written"). Root cause, read
    // directly off the running code (this is a PRODUCT gap, not a test
    // artifact — out of scope for this TEST-ONLY lane to fix):
    //
    //   packages/web/src/components/jobs/TechJobView.tsx:684-685 declares
    //   `isRunningBehind` / `delayMinutes`; the chip buttons at
    //   ~1085-1123 only call `setIsRunningBehind` / `setDelayMinutes`.
    //   Neither state variable is read anywhere else in the file —
    //   `advanceStatus()` (the file's ONLY function that calls `apiFetch`,
    //   lines 808-843) never references them, and there is no other
    //   effect/handler in the file that does either. A tap changes local
    //   UI state and nothing else.
    //
    //   The only technician-facing UI that DOES call
    //   `POST /api/appointments/:id/running-late` is
    //   packages/web/src/pages/technician/TechnicianDayView.tsx:533
    //   `markRunningLate()`, invoked from `sendDelayNotification()` (:556)
    //   — itself only reachable via the GPS-triggered
    //   `technician-day-delay-prompt` dialog's Accept button (:679-707,
    //   `technician-day-delay-accept`). That IS a second dialog (the GPS
    //   heuristic prompt, then Accept), the opposite of "no second
    //   dialog", and it is not a deliberate one-tap chip at all.
    //
    // `packages/api/test/integration/running-late.test.ts` already proves
    // the route itself (real Postgres: `appointment.running_late_triggered`
    // audit + consent-gated `delay_notice_state` row) once THAT dialog's
    // Accept is reached — this lane does not re-prove the route. Filed for
    // Fable/Josh to ticket; not filed by this lane per §12.4d.
    test.fail(
      true,
      'KNOWN PRODUCT GAP: TechJobView.tsx\'s "Running behind?" chip row ' +
        '(delayMinutes/isRunningBehind, lines 684-685, 1085-1123) is never read by any ' +
        'handler — tapping a chip calls no API and writes nothing. See the comment above.',
    );

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
    await page.goto(`/jobs/${job.id}?view=tech`);
    await expect(page.getByText('Running behind?', { exact: true })).toBeVisible({ timeout: 15_000 });

    // Desired: tapping "Yes" then "20" fires POST .../running-late.
    // Actual (today): nothing calls it, so this times out — the natural
    // failure `test.fail()` above expects.
    const runningLatePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /running-late/.test(new URL(r.url()).pathname),
      { timeout: 5_000 },
    );
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByRole('button', { name: '20', exact: true }).click();

    const res = await runningLatePromise;
    expect(res.status(), 'once fixed, tapping a delay chip should call running-late and succeed').toBe(200);
  });
});
