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
 * #1135 FIXED — this row's acceptance ("Given the chip row, when I tap
 * 10/20/30, then the chip row is the confirm — no second dialog — and a
 * delay notice is written") is now met. Previously
 * `packages/web/src/components/jobs/TechJobView.tsx`'s "Running behind?"
 * card only set local `isRunningBehind`/`delayMinutes` state; tapping a chip
 * never called `apiFetch`. The fix resolves the job's backing appointment
 * (`GET /api/appointments?jobId=`, since jobs don't carry an appointmentId
 * column) and, on chip tap, immediately posts
 * `POST /api/appointments/:id/running-late` with `{ delayMinutes }` —
 * optimistic chip selection, reverted with an error message on failure, no
 * second dialog. This spec proves that end-to-end at real Postgres: the tap
 * itself calls the route, the route's real audit row
 * (`appointment.running_late_triggered`) lands, and — because this fixture
 * gives the SAME technician a second, later appointment the same service
 * day (what `NextCustomerSelector` requires to find a notify target) — a
 * real `delay_notice_state` row lands too.
 *
 * T2 (#1193, map #995): tenant B has its OWN concurrent appointment at the
 * SAME service-day slot as tenant A's, and its OWN technician taps a
 * DIFFERENT delay chip (10, not A's 20) in a separate browser session. Each
 * tenant's `appointment.running_late_triggered` audit row and
 * `delay_notice_state` row carries exactly its OWN tapped delay — proven in
 * both directions (A's tap never touches B's rows, and B's tap never
 * changes or duplicates A's).
 *
 * `packages/api/test/integration/running-late.test.ts` already proves the
 * ROUTE's Postgres behavior in isolation (in-memory-repo unit coverage plus
 * a dedicated real-Postgres suite); this spec is the browser-reachability
 * leg — proving the CHIP ROW itself is what drives it.
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
  let owner: Awaited<ReturnType<typeof bootstrapOwnerTenant>>;
  let carlos: Awaited<ReturnType<typeof inviteAndJoinTechnician>>;
  let job: CreatedEntity;
  let appointmentId: string;
  let nextAppointmentId: string;
  let neighbour: Awaited<ReturnType<typeof bootstrapOwnerTenant>>;
  let neighbourTech: Awaited<ReturnType<typeof inviteAndJoinTechnician>>;
  let neighbourJob: CreatedEntity;
  let neighbourAppointmentId: string;
  let neighbourNextAppointmentId: string;

  async function appointmentIdForJob(authHeaders: Record<string, string>, jobId: string): Promise<string> {
    const res = await apiCtx.get(`${API_URL}/api/appointments?jobId=${jobId}`, { headers: authHeaders });
    expect(res.ok(), `GET /api/appointments?jobId=${jobId} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
    const list = (await res.json()) as CreatedEntity[];
    expect(list.length, `expected an appointment for job ${jobId}`).toBeGreaterThan(0);
    return list[0].id;
  }

  test.beforeAll(async () => {
    if (!canRun) return;
    apiCtx = await pwRequest.newContext();
    owner = await bootstrapOwnerTenant(apiCtx, 'chipowner');
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
    appointmentId = await appointmentIdForJob(owner.authHeaders, job.id);

    // `NextCustomerSelector` (delay-notifications.ts) resolves the delay
    // notice to Carlos's NEXT appointment later the SAME service day — not
    // the one the chip is tapped on — so a real `delay_notice_state` row
    // requires a second, later appointment for the SAME technician with an
    // SMS-reachable customer.
    const nextCustomer = await postJson(apiCtx, `${API_URL}/api/customers`, owner.authHeaders, {
      firstName: 'ChipRowNext',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '555-0177',
      email: `chiprownext+${Date.now()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const nextLocation = await postJson(apiCtx, `${API_URL}/api/locations`, owner.authHeaders, {
      customerId: nextCustomer.id,
      label: 'Home',
      street1: '9 Chip Row Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    const nextJob = await postJson(apiCtx, `${API_URL}/api/jobs`, owner.authHeaders, {
      customerId: nextCustomer.id,
      locationId: nextLocation.id,
      summary: 'Chip row NEXT test job',
      priority: 'normal',
      scheduledStart: `${todayStr}T14:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: carlos.techId,
    });
    nextAppointmentId = await appointmentIdForJob(owner.authHeaders, nextJob.id);

    // T2 — a neighbour tenant (B) with its OWN owner/technician/job at the
    // SAME service-day slot as tenant A's job, plus its OWN second/later
    // appointment (so `NextCustomerSelector` can resolve B's OWN
    // delay_notice_state target) — the tenant-B setup helpers already used
    // for the earlier T1 leg, now extended with B's own chip tap below.
    neighbour = await bootstrapOwnerTenant(apiCtx, 'chipneighbour');
    neighbourTech = await inviteAndJoinTechnician(apiCtx, neighbour.authHeaders, neighbour.tenantId, 'chipneighbourtech');
    const neighbourCustomer = await postJson(apiCtx, `${API_URL}/api/customers`, neighbour.authHeaders, {
      firstName: 'Neighbour',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '555-0188',
      email: `neighbour+${Date.now()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const neighbourLocation = await postJson(apiCtx, `${API_URL}/api/locations`, neighbour.authHeaders, {
      customerId: neighbourCustomer.id,
      label: 'Home',
      street1: '1 Neighbour Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    neighbourJob = await postJson(apiCtx, `${API_URL}/api/jobs`, neighbour.authHeaders, {
      customerId: neighbourCustomer.id,
      locationId: neighbourLocation.id,
      summary: 'Neighbour tenant job (own chip tap, T2)',
      priority: 'normal',
      scheduledStart: `${todayStr}T10:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: neighbourTech.techId,
    });
    neighbourAppointmentId = await appointmentIdForJob(neighbour.authHeaders, neighbourJob.id);

    const neighbourNextCustomer = await postJson(apiCtx, `${API_URL}/api/customers`, neighbour.authHeaders, {
      firstName: 'NeighbourNext',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '555-0199',
      email: `neighbournext+${Date.now()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const neighbourNextLocation = await postJson(apiCtx, `${API_URL}/api/locations`, neighbour.authHeaders, {
      customerId: neighbourNextCustomer.id,
      label: 'Home',
      street1: '2 Neighbour Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    const neighbourNextJob = await postJson(apiCtx, `${API_URL}/api/jobs`, neighbour.authHeaders, {
      customerId: neighbourNextCustomer.id,
      locationId: neighbourNextLocation.id,
      summary: 'Neighbour tenant NEXT job (own delay_notice_state target)',
      priority: 'normal',
      scheduledStart: `${todayStr}T14:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: neighbourTech.techId,
    });
    neighbourNextAppointmentId = await appointmentIdForJob(neighbour.authHeaders, neighbourNextJob.id);
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test('#1135 — tapping "Yes" then a delay chip (20) is the one-tap confirm: no second dialog, writes appointment.running_late_triggered + delay_notice_state; tenant B has its OWN concurrent appointment and taps a DIFFERENT chip (10) in a separate session — each tenant carries exactly its OWN delay (T2)', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

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

    // The chip tap IS the confirm — wait for the running-late response
    // triggered directly by the tap, with no intervening dialog.
    const runningLatePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /running-late/.test(new URL(r.url()).pathname),
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    // No second dialog appears between "Yes" and the delay chip.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '20', exact: true }).click();

    const res = await runningLatePromise;
    expect(res.status(), 'tapping the delay chip must call running-late and succeed').toBe(200);
    expect(new URL(res.request().url()).pathname).toBe(`/api/appointments/${appointmentId}/running-late`);
    expect(JSON.parse(res.request().postData() ?? '{}')).toEqual({ delayMinutes: 20 });

    // Still no dialog after the tap resolves.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.screenshot({
      path: `${REPORT_DIR}/4.6-chip-row-one-tap-confirm.png`,
      fullPage: true,
    });

    expect(pageErrors, 'no uncaught page errors on the tech job view').toEqual([]);

    // #1133 workaround — poll until the audit/state rows the request wrote
    // are visible (the transaction commits after the response is flushed).
    const auditCount = queryScalarUntilNonEmpty(
      `SELECT COUNT(*) FROM audit_events WHERE tenant_id = '${owner.tenantId}' ` +
        `AND entity_id = '${appointmentId}' AND event_type = 'appointment.running_late_triggered';`,
    );
    expect(auditCount, 'a running_late_triggered audit row must land for the tapped appointment').toBe('1');

    const auditMetadataDelay = queryScalar(
      `SELECT metadata->>'delayMinutes' FROM audit_events WHERE tenant_id = '${owner.tenantId}' ` +
        `AND entity_id = '${appointmentId}' AND event_type = 'appointment.running_late_triggered' LIMIT 1;`,
    );
    expect(auditMetadataDelay, 'the audit row must record the tapped delay (20 minutes)').toBe('20');

    // delay_notice_state is keyed by the NEXT appointment (the one being
    // notified about), not the one the chip was tapped on.
    const noticeRow = queryScalarUntilNonEmpty(
      `SELECT status || '|' || channel FROM delay_notice_state WHERE tenant_id = '${owner.tenantId}' ` +
        `AND appointment_id = '${nextAppointmentId}';`,
    );
    // Status may already have progressed past 'queued' to 'sent' by the
    // time this reads — the queue worker (transcription-worker) drains
    // delay_notice_delivery messages in the same process and can win the
    // race with this poll.
    expect(noticeRow, 'a delay_notice_state row must land for the next appointment the notice targets').toMatch(
      /^(queued|retrying|sent|fallback_in_app)\|(sms|in_app)$/,
    );

    // Isolation check #1 (A → B): tenant A's tap alone must not create any
    // running-late audit row for tenant B — checked BEFORE B taps anything.
    const neighbourAuditCountBeforeBTap = queryScalar(
      `SELECT COUNT(*) FROM audit_events WHERE tenant_id = '${neighbour.tenantId}' ` +
        `AND event_type = 'appointment.running_late_triggered';`,
    );
    expect(
      neighbourAuditCountBeforeBTap,
      "tenant A's chip tap must not create any running-late audit row for tenant B",
    ).toBe('0');

    // T2 — tenant B has its OWN concurrent appointment (same service-day
    // slot as A's) and its OWN technician taps a DIFFERENT delay chip (10,
    // not A's 20) in a SEPARATE browser session, reusing the exact same
    // chip-row flow driven above against B's own job/appointment.
    const neighbourContext = await page.context().browser()!.newContext();
    const neighbourPage = await neighbourContext.newPage();
    try {
      const neighbourPageErrors: string[] = [];
      neighbourPage.on('pageerror', (err) => neighbourPageErrors.push(err.message));

      await installClerkStub(neighbourPage, {
        signedIn: true,
        sub: neighbourTech.sub,
        token: neighbourTech.token,
      });
      await neighbourPage.addInitScript(
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
      await blockExternalHosts(neighbourPage, baseURL!);
      await neighbourPage.goto(`/jobs/${neighbourJob.id}?view=tech`);

      await expect(neighbourPage.getByText('Running behind?', { exact: true })).toBeVisible({ timeout: 15_000 });

      const neighbourRunningLatePromise = neighbourPage.waitForResponse(
        (r) => r.request().method() === 'POST' && /running-late/.test(new URL(r.url()).pathname),
        { timeout: 10_000 },
      );
      await neighbourPage.getByRole('button', { name: 'Yes', exact: true }).click();
      await expect(neighbourPage.getByRole('dialog')).toHaveCount(0);
      // A DIFFERENT chip than tenant A's (20) — 10, not 20.
      await neighbourPage.getByRole('button', { name: '10', exact: true }).click();

      const neighbourRes = await neighbourRunningLatePromise;
      expect(neighbourRes.status(), "tenant B's chip tap must call running-late and succeed").toBe(200);
      expect(new URL(neighbourRes.request().url()).pathname).toBe(
        `/api/appointments/${neighbourAppointmentId}/running-late`,
      );
      expect(JSON.parse(neighbourRes.request().postData() ?? '{}')).toEqual({ delayMinutes: 10 });

      await neighbourPage.screenshot({
        path: `${REPORT_DIR}/4.6-chip-row-tenant-b-different-chip.png`,
        fullPage: true,
      });

      expect(neighbourPageErrors, "no uncaught page errors on tenant B's tech job view").toEqual([]);
    } finally {
      await neighbourContext.close();
    }

    // #1133 workaround — poll until tenant B's own rows land.
    const neighbourAuditCountAfterBTap = queryScalarUntilNonEmpty(
      `SELECT COUNT(*) FROM audit_events WHERE tenant_id = '${neighbour.tenantId}' ` +
        `AND entity_id = '${neighbourAppointmentId}' AND event_type = 'appointment.running_late_triggered';`,
    );
    expect(
      neighbourAuditCountAfterBTap,
      "a running_late_triggered audit row must land for tenant B's own appointment",
    ).toBe('1');

    const neighbourAuditMetadataDelay = queryScalar(
      `SELECT metadata->>'delayMinutes' FROM audit_events WHERE tenant_id = '${neighbour.tenantId}' ` +
        `AND entity_id = '${neighbourAppointmentId}' AND event_type = 'appointment.running_late_triggered' LIMIT 1;`,
    );
    expect(
      neighbourAuditMetadataDelay,
      "tenant B's audit row must record ITS OWN tapped delay (10 minutes)",
    ).toBe('10');

    const neighbourNoticeRow = queryScalarUntilNonEmpty(
      `SELECT status || '|' || channel FROM delay_notice_state WHERE tenant_id = '${neighbour.tenantId}' ` +
        `AND appointment_id = '${neighbourNextAppointmentId}';`,
    );
    expect(
      neighbourNoticeRow,
      "a delay_notice_state row must land for tenant B's OWN next appointment",
    ).toMatch(/^(queued|retrying|sent|fallback_in_app)\|(sms|in_app)$/);

    // Isolation check #2 (B → A): tenant B's own tap (delay 10) must not
    // change or duplicate tenant A's own row — A still carries exactly ITS
    // OWN tapped delay (20), one row, unaffected by B's concurrent tap.
    const ownerAuditCountAfterBTap = queryScalar(
      `SELECT COUNT(*) FROM audit_events WHERE tenant_id = '${owner.tenantId}' ` +
        `AND entity_id = '${appointmentId}' AND event_type = 'appointment.running_late_triggered';`,
    );
    expect(
      ownerAuditCountAfterBTap,
      "tenant A's audit row count must stay exactly 1 after tenant B's own tap",
    ).toBe('1');

    const ownerAuditMetadataDelayAfterBTap = queryScalar(
      `SELECT metadata->>'delayMinutes' FROM audit_events WHERE tenant_id = '${owner.tenantId}' ` +
        `AND entity_id = '${appointmentId}' AND event_type = 'appointment.running_late_triggered' LIMIT 1;`,
    );
    expect(
      ownerAuditMetadataDelayAfterBTap,
      "tenant A's audit row must still carry ITS OWN delay (20), not tenant B's (10)",
    ).toBe('20');
  });
});
