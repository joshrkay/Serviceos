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
 * Also proves **T2** (non-interference, not just T1 isolation): BOTH
 * tenants perform their OWN drag in the SAME run, and each tenant's own
 * inbox and appointment row are correct regardless of the other tenant's
 * concurrent activity — not just "B never sees A's data" with B a passive
 * bystander.
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

interface TenantDragFixture {
  ownerSub: string;
  ownerJwt: string;
  ownerHeaders: Record<string, string>;
  tenantId: string;
  techId: string;
  jobEarly: CreatedEntity;
  earlyAppt: { id: string; jobId: string; scheduledStart: string; scheduledEnd: string; status: string };
  todayStr: string;
}

/** Bootstraps one owner + one technician + two appointments in the same lane. */
async function seedOwnerTechAndTwoAppointments(
  page: import('@playwright/test').Page,
  label: string,
): Promise<TenantDragFixture> {
  const ownerSub = `user_e2e_${label}owner_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `${label}owner-${Date.now()}@serviceos-hermetic.test`;
  const ownerJwt = unsignedJwt(ownerSub);
  const ownerHeaders = { Authorization: `Bearer ${ownerJwt}` };

  const bootstrapRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
  });
  expect(bootstrapRes.status(), `${label} owner bootstrap webhook -> ${await bootstrapRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({
      businessName: `Drag Proposal E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  const techEmail = `${label}tech-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({ email: techEmail, role: 'technician' }),
  });
  expect(inviteRes.status(), `POST /api/users/invitations (${label}) -> ${await inviteRes.text()}`).toBe(201);
  const invitation = (await inviteRes.json()) as { id?: string };
  const invitationId = invitation.id!;

  const techSub = `user_e2e_${label}tech_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: {
      id: techSub,
      email_addresses: [{ email_address: techEmail }],
      public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status(), `invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);

  const techToken = hmacToken(techSub, tenantId, 'technician');
  const techMeRes = await page.request.get(`${API_URL}/api/me`, {
    headers: { Authorization: `Bearer ${techToken}` },
  });
  expect(techMeRes.status(), `technician /api/me (${label}) -> ${await techMeRes.text()}`).toBe(200);
  const techMe = (await techMeRes.json()) as { internal_user_id?: string };
  expect(techMe.internal_user_id).toMatch(UUID_RE);
  const techId = techMe.internal_user_id!;

  const stamp = Date.now();
  const customer = await postJson(page, `${API_URL}/api/customers`, ownerHeaders, {
    firstName: label,
    lastName: `Drag Customer ${stamp}`,
    primaryPhone: '555-0199',
    email: `${label}.drag.customer+${stamp}@example.com`,
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
    summary: `${label} drag test — earlier slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T09:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });
  await postJson(page, `${API_URL}/api/jobs`, ownerHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} drag test — later slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T13:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });

  const boardBeforeRes = await page.request.get(
    `${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`,
    { headers: ownerHeaders },
  );
  expect(boardBeforeRes.ok()).toBeTruthy();
  const boardBefore = (await boardBeforeRes.json()) as {
    technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; jobId: string; scheduledStart: string; scheduledEnd: string; status: string }> }>;
  };
  const laneBefore = boardBefore.technicianLanes.find((l) => l.technicianId === techId);
  expect(laneBefore, `${label}'s technician lane must exist on the board`).toBeTruthy();
  expect(laneBefore!.appointments.length, `${label}'s lane must have both seeded appointments`).toBe(2);
  const earlyAppt = laneBefore!.appointments.find((a) => a.jobId === jobEarly.id)!;
  expect(earlyAppt).toBeTruthy();

  return { ownerSub, ownerJwt, ownerHeaders, tenantId, techId, jobEarly, earlyAppt, todayStr };
}

/** Drags the fixture's earlier card to the end of the same lane and confirms the proposal dialog. */
async function dragEarlyCardAndConfirm(
  page: import('@playwright/test').Page,
  baseURL: string,
  fixture: TenantDragFixture,
  beforeDragScreenshotPath?: string,
): Promise<{ id: string; status: string; proposalType: string; payload: Record<string, unknown> }> {
  await installClerkStub(page, { signedIn: true, sub: fixture.ownerSub, token: fixture.ownerJwt });
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
  await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
  // Codex review (dispatch-board.spec.ts finding, same assumption here):
  // DispatchBoard.tsx defaults `selectedDate` from the browser's LOCAL date
  // parts, while `fixture.todayStr` is the UTC calendar date the jobs were
  // seeded against — those only coincide on a UTC-clocked runner. Pin the
  // board to the fixture's date explicitly rather than relying on that.
  await page.getByTestId('date-nav-picker').fill(fixture.todayStr);

  const lane = page.locator(`[data-testid="technician-lane"][data-technician-id="${fixture.techId}"]`);
  await expect(lane).toBeVisible({ timeout: 15_000 });
  const cards = lane.getByTestId('appointment-card');
  await expect(cards).toHaveCount(2, { timeout: 15_000 });

  // Screenshot AFTER the board has actually loaded the two cards — taking
  // it any earlier (e.g. before this navigation) would capture a blank
  // initial document, making the "before" audit evidence meaningless.
  if (beforeDragScreenshotPath) {
    await page.screenshot({ path: beforeDragScreenshotPath, fullPage: true });
  }

  const sourceCard = cards.first(); // earliest (09:00) — sorted by scheduledStart
  const lastGap = lane.getByTestId('technician-lane-gap').last();
  await sourceCard.dragTo(lastGap);

  const dialog = page.getByTestId('confirm-proposal-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  const proposalPromise = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/proposals',
  );
  await page.getByTestId('confirm-proposal-confirm').click();
  const proposalRes = await proposalPromise;
  expect(proposalRes.status(), `POST /api/proposals -> ${proposalRes.status()}`).toBe(200);
  return (await proposalRes.json()) as { id: string; status: string; proposalType: string; payload: Record<string, unknown> };
}

/**
 * Reads the FULL appointments row (every column) as a single delimited
 * string, for byte-for-byte before/after equality — not just the two
 * fields (scheduledStart, status) the API happens to expose. Also writes
 * the pretty-printed form to the report's snapshot file, so the report
 * evidence and the assertion come from the same read.
 */
function snapshotFullAppointmentRow(label: string, appointmentId: string): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return '';
  const prettyOut = execFileSync(
    'psql',
    [databaseUrl, '-c', `SELECT * FROM appointments WHERE id = '${appointmentId}';`],
    { encoding: 'utf8' },
  );
  writeFileSync(`docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`, prettyOut);
  return execFileSync(
    'psql',
    [databaseUrl, '-t', '-A', '-F', '|', '-c', `SELECT * FROM appointments WHERE id = '${appointmentId}';`],
    { encoding: 'utf8' },
  ).trim();
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

  test('BOTH tenants drag a card in the same run — each gets a draft proposal, own appointment unchanged, own inbox only', async ({
    page,
    context,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: owner + technician + two appointments ─────────────────────
    const fixtureA = await seedOwnerTechAndTwoAppointments(page, 'a');
    const rowABefore = snapshotFullAppointmentRow('4.2-drag-proposal-appointment-a-before', fixtureA.earlyAppt.id);

    // ── Tenant B, SAME run: its OWN owner + technician + two appointments —
    //    not a passive bystander, it performs its own drag below. ───────────
    const bContext = await context.browser()!.newContext();
    const bPage = await bContext.newPage();
    const fixtureB = await seedOwnerTechAndTwoAppointments(bPage, 'b');
    const rowBBefore = snapshotFullAppointmentRow('4.2-drag-proposal-appointment-b-before', fixtureB.earlyAppt.id);

    // ── Browser reachability: EACH tenant drags its own card, isolated
    //    browser contexts, in the same run. The "before" screenshot is taken
    //    INSIDE dragEarlyCardAndConfirm once the board has actually loaded
    //    the two cards — not here, before /dispatch has even been visited. ──
    const proposalA = await dragEarlyCardAndConfirm(
      page,
      baseURL!,
      fixtureA,
      'docs/audit/lane-reports/owner-surfaces-r5/4.2-drag-proposal-before-drag.png',
    );
    expect(proposalA.status, 'A\'s drag-created proposal must land in draft').toBe('draft');
    expect(proposalA.proposalType).toBe('reschedule_appointment');
    // ── Codex review: a wrong appointmentId or a no-op destination time
    //    would still satisfy every assertion above. Assert the payload
    //    actually targets the DRAGGED appointment, at a genuinely
    //    different time (the final gap, not a no-op), for the same
    //    duration as the original slot. ───────────────────────────────────
    expect(proposalA.payload.appointmentId, 'A\'s proposal payload must target the dragged appointment').toBe(
      fixtureA.earlyAppt.id,
    );
    // Codex review round 4: `not.toBe` + duration-preserved would still pass
    // for ANY other one-hour slot (e.g. 10:00-11:00), not just the ACTUAL
    // final gap the drag targeted. The lane holds two 60-min appointments
    // (09:00 and 13:00-14:00 UTC); dragging the 09:00 card to the lane's
    // LAST gap packs it immediately after the 13:00-14:00 appointment ends
    // (DispatchBoard.tsx's `computeProposedSlot`, insertIndex >= lane
    // length -> `pack(lastEnd)`) — assert that EXACT destination.
    const aExpectedFinalGapStart = `${fixtureA.todayStr}T14:00:00.000Z`;
    const aExpectedFinalGapEnd = `${fixtureA.todayStr}T15:00:00.000Z`;
    expect(
      proposalA.payload.newScheduledStart,
      'A\'s proposal must target the ACTUAL final gap (right after the 13:00-14:00 appointment), not just any other time',
    ).toBe(aExpectedFinalGapStart);
    expect(proposalA.payload.newScheduledEnd, 'A\'s proposed end must preserve the dragged appointment\'s duration').toBe(
      aExpectedFinalGapEnd,
    );
    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.2-drag-proposal-after-drag.png',
      fullPage: true,
    });

    const proposalB = await dragEarlyCardAndConfirm(bPage, baseURL!, fixtureB);
    expect(proposalB.status, 'B\'s drag-created proposal must land in draft').toBe('draft');
    expect(proposalB.proposalType).toBe('reschedule_appointment');
    expect(proposalB.payload.appointmentId, 'B\'s proposal payload must target the dragged appointment').toBe(
      fixtureB.earlyAppt.id,
    );
    const bExpectedFinalGapStart = `${fixtureB.todayStr}T14:00:00.000Z`;
    const bExpectedFinalGapEnd = `${fixtureB.todayStr}T15:00:00.000Z`;
    expect(
      proposalB.payload.newScheduledStart,
      'B\'s proposal must target the ACTUAL final gap (right after the 13:00-14:00 appointment), not just any other time',
    ).toBe(bExpectedFinalGapStart);
    expect(proposalB.payload.newScheduledEnd, 'B\'s proposed end must preserve the dragged appointment\'s duration').toBe(
      bExpectedFinalGapEnd,
    );
    await bPage.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/4.2-drag-proposal-tenant-b-after-drag.png',
      fullPage: true,
    });
    await bContext.close();

    // ── T2 — each tenant's appointment row is unchanged regardless of the
    //      OTHER tenant's concurrent drag. Compare the FULL row (every
    //      column via `SELECT *`), not just the two fields the board API
    //      happens to expose — a regression touching scheduled_end,
    //      timezone, hold_pending_approval, etc. would otherwise stay
    //      undetected. ─────────────────────────────────────────────────────
    const rowAAfter = snapshotFullAppointmentRow('4.2-drag-proposal-appointment-a-after', fixtureA.earlyAppt.id);
    const rowBAfter = snapshotFullAppointmentRow('4.2-drag-proposal-appointment-b-after', fixtureB.earlyAppt.id);
    expect(rowAAfter, 'A\'s appointment row must be BYTE-FOR-BYTE unchanged (every column) after the drag').toBe(
      rowABefore,
    );
    expect(rowBAfter, 'B\'s appointment row must be BYTE-FOR-BYTE unchanged (every column) after the drag').toBe(
      rowBBefore,
    );

    for (const fixture of [fixtureA, fixtureB]) {
      const boardAfterRes = await page.request.get(
        `${API_URL}/api/dispatch/board?date=${fixture.todayStr}&timezone=Etc/UTC`,
        { headers: fixture.ownerHeaders },
      );
      const boardAfter = (await boardAfterRes.json()) as {
        technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; jobId: string; scheduledStart: string; status: string }> }>;
      };
      const laneAfter = boardAfter.technicianLanes.find((l) => l.technicianId === fixture.techId);
      const earlyApptAfter = laneAfter!.appointments.find((a) => a.jobId === fixture.jobEarly.id)!;
      expect(
        earlyApptAfter.scheduledStart,
        `${fixture.ownerSub}'s appointment start must NOT change, regardless of the other tenant's concurrent drag`,
      ).toBe(fixture.earlyAppt.scheduledStart);
      expect(earlyApptAfter.status, `${fixture.ownerSub}'s appointment status must NOT change`).toBe(
        fixture.earlyAppt.status,
      );
    }

    // ── T2 — each tenant's inbox holds EXACTLY its own one proposal. ────────
    const inboxARes = await page.request.get(`${API_URL}/api/proposals/inbox`, { headers: fixtureA.ownerHeaders });
    expect(inboxARes.ok(), `GET /api/proposals/inbox (A) -> ${inboxARes.status()}`).toBeTruthy();
    const inboxA = (await inboxARes.json()) as { data: Array<{ proposal: { id: string } }> };
    expect(inboxA.data.some((p) => p.proposal.id === proposalA.id), 'A\'s proposal must be in A\'s inbox').toBe(true);
    expect(inboxA.data.some((p) => p.proposal.id === proposalB.id), 'B\'s proposal must NEVER be in A\'s inbox').toBe(
      false,
    );
    // ── Codex review: `.some()` alone doesn't prove EXACTLY one proposal
    //    exists — these are freshly seeded tenants with no other proposal
    //    activity, so the inbox must hold precisely the one drag produced. ──
    expect(inboxA.data.length, 'A\'s inbox must hold EXACTLY one proposal (this drag\'s)').toBe(1);
    expect(inboxA.data[0].proposal.id, 'A\'s sole inbox entry must be this drag\'s proposal').toBe(proposalA.id);

    const inboxBRes = await page.request.get(`${API_URL}/api/proposals/inbox`, { headers: fixtureB.ownerHeaders });
    expect(inboxBRes.ok(), `GET /api/proposals/inbox (B) -> ${inboxBRes.status()}`).toBeTruthy();
    const inboxB = (await inboxBRes.json()) as { data: Array<{ proposal: { id: string } }> };
    expect(inboxB.data.some((p) => p.proposal.id === proposalB.id), 'B\'s proposal must be in B\'s inbox').toBe(true);
    expect(inboxB.data.some((p) => p.proposal.id === proposalA.id), 'A\'s proposal must NEVER be in B\'s inbox').toBe(
      false,
    );
    expect(inboxB.data.length, 'B\'s inbox must hold EXACTLY one proposal (this drag\'s)').toBe(1);
    expect(inboxB.data[0].proposal.id, 'B\'s sole inbox entry must be this drag\'s proposal').toBe(proposalB.id);

    expect(pageErrors, 'no uncaught page errors during the drag-to-propose journey').toEqual([]);
  });
});
