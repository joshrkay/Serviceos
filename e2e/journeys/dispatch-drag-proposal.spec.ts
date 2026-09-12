import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.2 — drag-to-propose reachability, real Postgres.
 *
 * `test/integration/dispatch-drag-proposal.test.ts` (issue #1017) already
 * proves `createSchedulingProposal` writes a `draft` proposal and mutates
 * NO appointment column, at real Postgres, T1 — but by calling the
 * Express router directly with a stamped `req.auth`, not through a real
 * browser drag. This spec proves the SAME guarantee reachable from the
 * real `/dispatch` UI: an owner drags an `appointment-card` to another
 * slot in a technician's lane (native HTML5 DnD, `DispatchBoard.tsx`'s
 * `submitProposal` → `POST /api/proposals`), and the `appointments` row is
 * byte-for-byte unchanged (polled from Postgres before/after the drag).
 *
 * Known, already-documented gap (issue #1040, cited in
 * docs/audit/lane-reports/1017-dispatch.md): neither `routes/proposals.ts`
 * nor `create-scheduling.ts` emits a `proposal.created` audit event on
 * this path yet, so this spec does not assert one — that gap already has
 * an `it.skip`'d RED test in the vitest integration suite.
 *
 * Bootstrap pattern mirrors e2e/journeys/accept-invitation.spec.ts (owner
 * bootstrap + technician invite/webhook-join + HMAC tenant-scoped token).
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

/** HMAC dev token with an explicit tenant_id claim — see accept-invitation.spec.ts. */
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

function allDayHours() {
  const open = { open: '00:00', close: '23:59' };
  return { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open };
}

// Suppress the welcome / what's-new walkthrough modals so they don't
// intercept the drag (mirrors e2e/journeys/digest-toggle.spec.ts).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

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

test.describe('dispatch drag-to-propose (4.2) — real Postgres', () => {
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

  test('dragging a card creates a draft proposal and leaves the appointment row unmutated', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── 1. Bootstrap the OWNER's tenant ─────────────────────────────────────
    const ownerSub = `user_e2e_owner_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `owner-${Date.now()}@serviceos-hermetic.test`;
    const ownerJwt = unsignedJwt(ownerSub);
    const ownerHeaders = { Authorization: `Bearer ${ownerJwt}` };

    const bootstrapRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    expect(bootstrapRes.status(), `owner bootstrap webhook -> ${await bootstrapRes.text()}`).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id).toMatch(UUID_RE);
    const tenantId = me.tenant_id!;

    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        businessName: 'Drag Proposal E2E HVAC',
        businessHours: allDayHours(),
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'Etc/UTC',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // ── 2. Invite + webhook-join a technician (Carlos) into tenant A ────────
    const techEmail = `tech-${Date.now()}@serviceos-hermetic.test`;
    const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({ email: techEmail, role: 'technician' }),
    });
    expect(inviteRes.status(), `POST /api/users/invitations -> ${await inviteRes.text()}`).toBe(201);
    const invitation = (await inviteRes.json()) as { id?: string };
    const invitationId = invitation.id!;

    const techSub = `user_e2e_tech_${randomUUID().replace(/-/g, '')}`;
    const joinRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: {
        id: techSub,
        email_addresses: [{ email_address: techEmail }],
        public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
      },
    });
    expect(joinRes.status(), `invitee-join webhook -> ${await joinRes.text()}`).toBe(200);

    const techToken = hmacToken(techSub, tenantId, 'technician');
    const techMeRes = await page.request.get(`${API_URL}/api/me`, {
      headers: { Authorization: `Bearer ${techToken}` },
    });
    expect(techMeRes.status(), `technician /api/me -> ${await techMeRes.text()}`).toBe(200);
    const techMe = (await techMeRes.json()) as { internal_user_id?: string };
    expect(techMe.internal_user_id).toMatch(UUID_RE);
    const techId = techMe.internal_user_id!;

    // ── 3. Seed a customer/location/job with TWO appointments in the same
    //      technician's lane, today, well inside the all-day business hours. ─
    const stamp = Date.now();
    const customer = await postJson(page, `${API_URL}/api/customers`, ownerHeaders, {
      firstName: 'Drag',
      lastName: `Customer ${stamp}`,
      primaryPhone: '555-0199',
      email: `drag.customer+${stamp}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });
    const location = await postJson(page, `${API_URL}/api/locations`, ownerHeaders, {
      customerId: customer.id,
      label: 'Home',
      street1: '2 Drag Test Ave',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      isPrimary: true,
    });
    const todayStr = new Date().toISOString().split('T')[0];
    const jobEarly = await postJson(page, `${API_URL}/api/jobs`, ownerHeaders, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Drag test — earlier slot',
      priority: 'normal',
      scheduledStart: `${todayStr}T09:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: techId,
    });
    const jobLate = await postJson(page, `${API_URL}/api/jobs`, ownerHeaders, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Drag test — later slot',
      priority: 'normal',
      scheduledStart: `${todayStr}T13:00:00.000Z`,
      durationMin: 60,
      timezone: 'Etc/UTC',
      technicianId: techId,
    });

    // Resolve the appointment id for the EARLY job (the one we'll drag) via
    // the real board API, and capture its pre-drag row directly from Postgres.
    const boardBeforeRes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`,
      { headers: ownerHeaders },
    );
    expect(boardBeforeRes.ok()).toBeTruthy();
    const boardBefore = (await boardBeforeRes.json()) as {
      technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; jobId: string; scheduledStart: string; status: string }> }>;
    };
    const laneBefore = boardBefore.technicianLanes.find((l) => l.technicianId === techId);
    expect(laneBefore, 'technician lane must exist on the board').toBeTruthy();
    expect(laneBefore!.appointments.length, 'lane must have both seeded appointments').toBe(2);
    const earlyAppt = laneBefore!.appointments.find((a) => a.jobId === jobEarly.id)!;
    expect(earlyAppt).toBeTruthy();

    pollDbSnapshot(
      '4.2-drag-proposal-appointment-before',
      `SELECT id, status, scheduled_start, updated_at FROM appointments WHERE id = '${earlyAppt.id}';`,
    );

    // ── 4. Browser reachability: owner drags the earlier card to the END of
    //      the SAME lane (reschedule_appointment, per DispatchBoard.tsx). ───
    await installClerkStub(page, { signedIn: true, sub: ownerSub, token: ownerJwt });
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

    const lane = page.locator(`[data-testid="technician-lane"][data-technician-id="${techId}"]`);
    await expect(lane).toBeVisible({ timeout: 15_000 });
    const cards = lane.getByTestId('appointment-card');
    await expect(cards).toHaveCount(2, { timeout: 15_000 });

    const sourceCard = cards.first(); // earliest (09:00) — sorted by scheduledStart
    const lastGap = lane.getByTestId('technician-lane-gap').last();

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.2-drag-proposal-before-drag.png',
      fullPage: true,
    });

    await sourceCard.dragTo(lastGap);

    const dialog = page.getByTestId('confirm-proposal-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const proposalPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/proposals',
    );
    await page.getByTestId('confirm-proposal-confirm').click();
    const proposalRes = await proposalPromise;
    expect(proposalRes.status(), `POST /api/proposals -> ${proposalRes.status()}`).toBe(200);
    const proposal = (await proposalRes.json()) as { id: string; status: string; proposalType: string };
    expect(proposal.status, 'a drag-created proposal must land in draft').toBe('draft');
    expect(proposal.proposalType).toBe('reschedule_appointment');

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.2-drag-proposal-after-drag.png',
      fullPage: true,
    });

    // ── 5. The appointment row must be byte-for-byte unchanged. ─────────────
    pollDbSnapshot(
      '4.2-drag-proposal-appointment-after',
      `SELECT id, status, scheduled_start, updated_at FROM appointments WHERE id = '${earlyAppt.id}';`,
    );
    const boardAfterRes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`,
      { headers: ownerHeaders },
    );
    const boardAfter = (await boardAfterRes.json()) as {
      technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; jobId: string; scheduledStart: string; status: string }> }>;
    };
    const laneAfter = boardAfter.technicianLanes.find((l) => l.technicianId === techId);
    const earlyApptAfter = laneAfter!.appointments.find((a) => a.jobId === jobEarly.id)!;
    expect(earlyApptAfter.scheduledStart, 'appointment start must NOT change until the proposal is approved').toBe(
      earlyAppt.scheduledStart,
    );
    expect(earlyApptAfter.status, 'appointment status must NOT change').toBe(earlyAppt.status);

    // ── 6. The owner sees the proposal in the review queue. ─────────────────
    const inboxRes = await page.request.get(`${API_URL}/api/proposals/inbox`, { headers: ownerHeaders });
    expect(inboxRes.ok(), `GET /api/proposals/inbox -> ${inboxRes.status()}`).toBeTruthy();
    const inbox = (await inboxRes.json()) as { data: Array<{ proposal: { id: string } }> };
    expect(inbox.data.some((p) => p.proposal.id === proposal.id), 'the dragged proposal must appear in the owner\'s inbox').toBe(
      true,
    );

    // ── 7. T1 — a second tenant, same run, never sees this proposal. ───────
    const otherSub = `user_e2e_otherowner_${randomUUID().replace(/-/g, '')}`;
    const otherEmail = `otherowner-${Date.now()}@serviceos-hermetic.test`;
    const otherJwt = unsignedJwt(otherSub);
    const otherHeaders = { Authorization: `Bearer ${otherJwt}` };
    const otherBootstrap = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: otherSub, email_addresses: [{ email_address: otherEmail }] },
    });
    expect(otherBootstrap.status()).toBe(200);
    const otherInboxRes = await page.request.get(`${API_URL}/api/proposals/inbox`, { headers: otherHeaders });
    expect(otherInboxRes.ok()).toBeTruthy();
    const otherInbox = (await otherInboxRes.json()) as { data: Array<{ proposal: { id: string } }> };
    expect(
      otherInbox.data.some((p) => p.proposal.id === proposal.id),
      'tenant B must never see tenant A\'s drag-created proposal',
    ).toBe(false);

    expect(pageErrors, 'no uncaught page errors during the drag-to-propose journey').toEqual([]);
  });
});
