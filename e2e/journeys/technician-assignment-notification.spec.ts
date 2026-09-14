import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.11 — "told when assigned", real Postgres, no DEV_AUTH_BYPASS (issue #1086).
 *
 * `test/integration/assignment-notifier-wiring.test.ts` already proves, by
 * calling `assignTechnician` directly against real Postgres: one commit
 * fires exactly one push + one SMS (when a delivery provider exists) plus
 * the `appointment.technician_assigned` audit event. This spec proves the
 * SAME commit reachable through the REAL owner-facing surfaces:
 *
 *   1. The OWNER drags an unassigned appointment onto Carlos's (empty) lane
 *      on the real `/dispatch` board (mirrors
 *      e2e/journeys/dispatch-drag-proposal.spec.ts's drag mechanics) — this
 *      creates a `reassign_appointment` proposal, exactly like every other
 *      drag on this board (nothing commits from a drag alone).
 *   2. The owner APPROVES that proposal on the real `/inbox` page (the
 *      `actOnProposal` → `POST /api/proposals/:id/approve` path) — THIS is
 *      what actually executes `ReassignAppointmentExecutionHandler` →
 *      `assignTechnician`, committing the assignment.
 *   3. Postgres proof: the `appointment.technician_assigned` audit row
 *      (actor = owner, metadata.technicianId = Carlos) and the assignment
 *      row itself now naming Carlos as primary technician.
 *   4. T2 — tenant B assigns ITS OWN technician in the same run; B's audit
 *      row is isolated from A's, and A's tenant carries zero rows
 *      referencing B's appointment.
 *
 * Honesty note (§12.4d): `assignTechnician`'s push goes through
 * `OwnerNotificationService.notifyUser`, which reads `device_tokens` — no
 * device token is registered for Carlos in this hermetic harness (that
 * would require a real push provider/APNs-FCM credential exchange this
 * lane cannot fake), so the push itself is NOT observable here; the SMS
 * leg additionally requires TWILIO_* credentials this harness deliberately
 * does not set (preamble: never set TWILIO_* for a non-phone spec). Both
 * paths are failure-isolated ("a notification problem never breaks the
 * assignment write" — appointments/assignment.ts) so their absence does
 * not affect the audit/assignment proof below, which IS the durable,
 * hermetically-provable guarantee. Flagged for Fable/Josh in the lane
 * report; this spec proves the audit + assignment rows, not the push/SMS
 * delivery itself.
 *
 * Runs under the `chromium-noauthbypass` Playwright project only (see
 * playwright.config.ts's NO_AUTH_BYPASS_SPECS / technician-day-view.spec.ts's
 * header comment for the full issue #1086 rationale).
 */

const API_URL =
  process.env.E2E_NOAUTHBYPASS_API_URL ?? process.env.E2E_API_URL ?? 'http://localhost:3002';

const REPORT_DIR = 'docs/audit/lane-reports/8-4-technician-surfaces';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Suppress the welcome / what's-new walkthrough modals so they don't
// intercept the drag (mirrors dispatch-drag-proposal.spec.ts).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

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

/**
 * Poll a scalar query until it matches `expected` or times out. Necessary
 * here because approval does NOT execute a proposal synchronously:
 * `proposals/actions.ts`'s `approveProposal` only flips status to 'approved'
 * (D9 undo window — UNDO_WINDOW_MS = 5000ms in proposals/lifecycle.ts); a
 * DETACHED 1-second execution sweep (app.ts's `runExecutionSweep` interval)
 * is what actually calls `ReassignAppointmentExecutionHandler` ->
 * `assignTechnician` once the undo window has closed. Reading the DB
 * immediately after a 200 from /approve races that sweep.
 */
async function pollUntil(sql: string, expected: string, timeoutMs = 12_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = queryScalar(sql);
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
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

async function bootstrapOwnerTenant(
  request: APIRequestContext,
  label: string,
): Promise<{ sub: string; authHeaders: Record<string, string>; token: string; tenantId: string }> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;

  const webhookRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const tenantId = queryScalarUntilNonEmpty(`SELECT tenant_id FROM users WHERE clerk_user_id = '${sub}' LIMIT 1;`);
  expect(tenantId, `${label}: real webhook must have created a users row for ${sub}`).toMatch(UUID_RE);

  const token = hmacToken(sub, tenantId, 'owner');
  const authHeaders = { Authorization: `Bearer ${token}` };

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status(), `${label} /api/me -> ${await meRes.text()}`).toBe(200);

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Assignment Notify E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { sub, authHeaders, token, tenantId };
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
  owner: { sub: string; authHeaders: Record<string, string>; token: string; tenantId: string };
  tech: { sub: string; token: string; techId: string };
  appointmentId: string;
  todayStr: string;
}

/**
 * Bootstraps one owner + one technician + ONE UNASSIGNED appointment for
 * today PLUS one ANCHOR appointment already assigned to that technician.
 *
 * The dispatch board only renders a technician's lane when they have at
 * least one appointment that day (dispatch/board-query.ts's
 * `technicianAppointments` map is built from EXISTING assignments — a
 * technician with zero appointments gets no lane at all, not an empty
 * one). Carlos needs a lane to drop onto, so he needs an anchor
 * appointment; the actual proof (an assignment committing + notifying)
 * targets the SEPARATE unassigned appointment dragged in afterward.
 */
async function seedUnassignedFixture(request: APIRequestContext, label: string): Promise<Fixture> {
  const owner = await bootstrapOwnerTenant(request, `${label}owner`);
  const tech = await inviteAndJoinTechnician(request, owner.authHeaders, owner.tenantId, `${label}tech`);

  const customer = await postJson(request, `${API_URL}/api/customers`, owner.authHeaders, {
    firstName: 'Assign',
    lastName: `${label.toUpperCase()} Customer ${Date.now()}`,
    primaryPhone: '555-0188',
    email: `assign-${label}+${Date.now()}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
    source: 'referral',
  });
  const location = await postJson(request, `${API_URL}/api/locations`, owner.authHeaders, {
    customerId: customer.id,
    label: 'Home',
    street1: `${label} Assignment Ave`,
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
  });
  const todayStr = new Date().toISOString().split('T')[0];

  // Anchor — already assigned to the tech, so their lane renders at all.
  await postJson(request, `${API_URL}/api/jobs`, owner.authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} anchor job (pre-assigned)`,
    priority: 'normal',
    scheduledStart: `${todayStr}T08:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: tech.techId,
  });

  const job = await postJson(request, `${API_URL}/api/jobs`, owner.authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} unassigned job`,
    priority: 'normal',
    scheduledStart: `${todayStr}T10:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    // Deliberately no technicianId — this appointment must land in the
    // board's unassigned queue.
  });

  const boardRes = await request.get(`${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`, {
    headers: owner.authHeaders,
  });
  expect(boardRes.ok(), `GET /api/dispatch/board (${label}) -> ${boardRes.status()}`).toBeTruthy();
  const board = (await boardRes.json()) as {
    unassignedAppointments: Array<{ id: string; jobId: string }>;
    technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string }> }>;
  };
  const appt = board.unassignedAppointments.find((a) => a.jobId === job.id);
  expect(appt, `${label}: seeded job must appear in the unassigned queue`).toBeTruthy();
  const lane = board.technicianLanes.find((l) => l.technicianId === tech.techId);
  expect(lane?.appointments.length, `${label}: the tech's lane must show the anchor appointment`).toBe(1);

  return { owner, tech, appointmentId: appt!.id, todayStr };
}

test.describe('technician assignment notification (4.11) — real Postgres, no DEV_AUTH_BYPASS (issue #1086)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres with --project=chromium-noauthbypass.',
  );

  test('owner drags + approves an assignment on the real board/inbox; appointment.technician_assigned audit fires; T2', async ({
    page,
    baseURL,
  }) => {
    // Two tenants' full drag+approve flow, EACH followed by a poll for the
    // D9 undo window (5s) to close and the 1s execution-sweep interval to
    // claim the proposal (see pollUntil's doc comment) — comfortably
    // exceeds Playwright's default 30s per-test timeout.
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const fixtureA = await seedUnassignedFixture(page.request, 'a');
    const fixtureB = await seedUnassignedFixture(page.request, 'b');

    async function assignViaBoardAndInbox(fixture: Fixture, tag: string) {
      await installClerkStub(page, {
        signedIn: true,
        sub: fixture.owner.sub,
        token: fixture.owner.token,
      });
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
      // Explicitly wait for the board fetch matching the fixture's date to
      // resolve, rather than racing `date-nav-picker`'s onChange re-fetch
      // against a fixed lane-visibility timeout.
      const boardRespPromise = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          new URL(r.url()).pathname === '/api/dispatch/board' &&
          new URL(r.url()).searchParams.get('date') === fixture.todayStr,
      );
      await page.getByTestId('date-nav-picker').fill(fixture.todayStr);
      await boardRespPromise;

      const lane = page.locator(
        `[data-testid="technician-lane"][data-technician-id="${fixture.tech.techId}"]`,
      );
      await expect(lane).toBeVisible({ timeout: 30_000 });
      // The tech's lane already holds its anchor appointment (seeded so the
      // lane renders at all — see seedUnassignedFixture's comment).
      await expect(lane.getByTestId('appointment-card')).toHaveCount(1, { timeout: 15_000 });

      const sourceCard = page
        .getByTestId('unassigned-queue-list')
        .getByTestId('appointment-card')
        .first();
      await expect(sourceCard).toBeVisible({ timeout: 15_000 });

      if (tag === 'a') {
        await page.screenshot({ path: `${REPORT_DIR}/4.11-before-drag.png`, fullPage: true });
      }

      // Drop onto the LAST gap (after the anchor appointment) — same
      // mechanic as dispatch-drag-proposal.spec.ts's dragEarlyCardAndConfirm.
      const targetGap = lane.getByTestId('technician-lane-gap').last();
      await sourceCard.dragTo(targetGap);

      const dialog = page.getByTestId('confirm-proposal-dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      const proposalPromise = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/proposals',
      );
      await page.getByTestId('confirm-proposal-confirm').click();
      const proposalRes = await proposalPromise;
      expect(proposalRes.status(), `POST /api/proposals (${tag}) -> ${proposalRes.status()}`).toBe(200);
      const proposal = (await proposalRes.json()) as {
        id: string;
        status: string;
        proposalType: string;
        payload: Record<string, unknown>;
      };
      expect(proposal.status, `${tag}'s drag-created proposal must land in draft`).toBe('draft');
      expect(proposal.proposalType).toBe('reassign_appointment');
      expect(proposal.payload.toTechnicianId, `${tag}'s proposal must target ITS OWN technician`).toBe(
        fixture.tech.techId,
      );

      // ── Approve on the real /inbox page. This only flips the proposal to
      //    'approved' (D9 undo window, proposals/lifecycle.ts
      //    UNDO_WINDOW_MS=5000) — the DETACHED 1-second execution sweep
      //    (app.ts's runExecutionSweep interval) is what actually calls
      //    ReassignAppointmentExecutionHandler -> assignTechnician once the
      //    undo window closes. The Postgres assertions below poll for
      //    that, rather than assuming synchronous commit. ─────────────────
      await page.goto('/inbox');
      const row = page.getByTestId('inbox-row').filter({ hasText: 'Reassign appointment' }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      const approvePromise = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === `/api/proposals/${proposal.id}/approve`,
      );
      await row.getByRole('button', { name: 'Approve' }).click();
      const approveRes = await approvePromise;
      expect(approveRes.status(), `POST /api/proposals/${proposal.id}/approve (${tag}) -> ${approveRes.status()}`).toBe(
        200,
      );
      const approveBody = (await approveRes.json().catch(() => null)) as { status?: string } | null;
      expect(approveBody?.status, `${tag}'s proposal must transition to approved`).toBe('approved');

      if (tag === 'a') {
        await page.screenshot({ path: `${REPORT_DIR}/4.11-after-approve.png`, fullPage: true });
      }

      return proposal;
    }

    await assignViaBoardAndInbox(fixtureA, 'a');
    await assignViaBoardAndInbox(fixtureB, 'b');

    expect(pageErrors, 'no uncaught page errors on the dispatch board / inbox').toEqual([]);

    // ── Postgres proof — the assignment actually committed, isolated per
    //    tenant. The execution sweep only claims an 'approved' proposal
    //    once the D9 undo window (5s) has closed, on its own 1s interval —
    //    poll rather than read once (see pollUntil's doc comment). Snapshots
    //    are taken AFTER the poll succeeds so the dumped evidence reflects
    //    the settled state, not a pre-sweep race. ───────────────────────────
    const auditA = await pollUntil(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' ` +
        `AND event_type = 'appointment.technician_assigned' AND entity_id = '${fixtureA.appointmentId}' ` +
        `AND metadata->>'technicianId' = '${fixtureA.tech.techId}';`,
      '1',
    );
    expect(auditA, 'A: exactly one technician_assigned audit row naming Carlos').toBe('1');

    const assignedTechA = await pollUntil(
      `SELECT technician_id FROM appointment_assignments WHERE appointment_id = '${fixtureA.appointmentId}' AND is_primary = true;`,
      fixtureA.tech.techId,
    );
    expect(assignedTechA, 'A: the appointment must actually be assigned to its OWN technician').toBe(
      fixtureA.tech.techId,
    );

    const auditB = await pollUntil(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureB.owner.tenantId}' ` +
        `AND event_type = 'appointment.technician_assigned' AND entity_id = '${fixtureB.appointmentId}' ` +
        `AND metadata->>'technicianId' = '${fixtureB.tech.techId}';`,
      '1',
    );
    expect(auditB, 'B: exactly one technician_assigned audit row naming ITS OWN technician').toBe('1');

    const crossTenantLeak = queryScalar(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' AND entity_id = '${fixtureB.appointmentId}';`,
    );
    expect(crossTenantLeak, 'A\'s tenant must have ZERO audit rows for B\'s appointment').toBe('0');

    // Snapshots taken LAST, after every poll above already confirmed the
    // settled state — avoids capturing a pre-sweep race in the evidence file.
    pollDbSnapshot(
      '4.11-technician-assigned-audit-a',
      `SELECT tenant_id, actor_id, actor_role, event_type, entity_id, metadata ` +
        `FROM audit_events WHERE tenant_id = '${fixtureA.owner.tenantId}' AND event_type = 'appointment.technician_assigned';`,
    );
    pollDbSnapshot(
      '4.11-assignment-row-a',
      `SELECT appointment_id, technician_id, is_primary ` +
        `FROM appointment_assignments WHERE appointment_id = '${fixtureA.appointmentId}';`,
    );
  });
});
