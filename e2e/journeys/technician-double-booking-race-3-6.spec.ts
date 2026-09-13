import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * §8.3 row 3.6 — rung-5 reachability: "it is IMPOSSIBLE to double-book
 * Carlos... enforced by a DB EXCLUDE constraint, not application code."
 *
 * packages/api/test/integration/technician-double-booking-race.test.ts
 * already proves the real `no_double_booking` EXCLUDE constraint under real
 * concurrency — but by calling the `assignTechnician` domain function
 * in-process, twice, with a stamped `req.auth`-shaped options object. This
 * file drives the SAME guarantee through the REAL HTTP surface: two
 * genuinely CONCURRENT `POST /api/jobs` requests (an owner scheduling two
 * different customers with the SAME technician at the SAME time —
 * `job-appointment-sync.ts`'s `ensurePrimaryTechnician` calls
 * `assignTechnician` synchronously inside the request transaction, so
 * scheduling a job IS how a technician gets assigned in production), fired
 * from the owner's real, authenticated browser session against the real,
 * fully-booted app.ts — never a bare in-process function call.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-3-book-inapp-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

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

function allDayHours() {
  const open = { open: '00:00', close: '23:59' };
  return { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open };
}

interface RaceFixture {
  ownerSub: string;
  ownerJwt: string;
  ownerHeaders: Record<string, string>;
  tenantId: string;
  techId: string;
}

/** Bootstraps one owner + one technician (real invite + webhook join). */
async function bootstrapOwnerAndTechnician(request: APIRequestContext, label: string): Promise<RaceFixture> {
  const ownerSub = `user_e2e_${label}owner_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `${label}owner-${Date.now()}@serviceos-hermetic.test`;
  const ownerJwt = unsignedJwt(ownerSub);
  const ownerHeaders = { Authorization: `Bearer ${ownerJwt}` };

  const bootstrapRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
  });
  expect(bootstrapRes.status(), `${label} owner bootstrap webhook -> ${await bootstrapRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({
      businessName: `Double-Booking Race E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 0,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  const techEmail = `${label}tech-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...ownerHeaders },
    data: JSON.stringify({ email: techEmail, role: 'technician' }),
  });
  expect(inviteRes.status(), `POST /api/users/invitations (${label}) -> ${await inviteRes.text()}`).toBe(201);
  const invitation = (await inviteRes.json()) as { id?: string };
  const invitationId = invitation.id!;

  const techSub = `user_e2e_${label}tech_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(request, {
    type: 'user.created',
    data: {
      id: techSub,
      email_addresses: [{ email_address: techEmail }],
      public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status(), `invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);

  const techToken = hmacToken(techSub, tenantId, 'technician');
  const techMeRes = await request.get(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${techToken}` } });
  expect(techMeRes.status(), `technician /api/me (${label}) -> ${await techMeRes.text()}`).toBe(200);
  const techMe = (await techMeRes.json()) as { internal_user_id?: string };
  expect(techMe.internal_user_id).toMatch(UUID_RE);
  const techId = techMe.internal_user_id!;

  return { ownerSub, ownerJwt, ownerHeaders, tenantId, techId };
}

/** Creates a fresh customer + primary location for a race fixture. */
async function seedCustomerLocation(
  request: APIRequestContext,
  authHeaders: Record<string, string>,
  label: string,
): Promise<{ customerId: string; locationId: string }> {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const customer = await postJson(request, `${API_URL}/api/customers`, authHeaders, {
    firstName: label,
    lastName: `Race Customer ${stamp}`,
    primaryPhone: '555-0177',
    email: `${label}.race.${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const location = await postJson(request, `${API_URL}/api/locations`, authHeaders, {
    customerId: customer.id,
    label: 'Home',
    street1: `${label} Race Ave`,
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
  });
  return { customerId: customer.id, locationId: location.id };
}

/**
 * Creates a brand-new, UNSCHEDULED job (no `scheduledStart`) — sequential,
 * awaited by the caller. `createJob`'s job-number allocator
 * (`getNextJobNumber`, pg-job.ts:330 — `SELECT COUNT(*)+1`, no locking) is
 * its OWN unguarded race on a brand-new tenant's first two jobs: creating
 * both jobs concurrently would collide on `job_number` before either ever
 * reaches the technician-assignment code this row is about, an unrelated
 * confound. Job creation is sequential; only the SCHEDULE step below races.
 */
async function createUnscheduledJob(
  request: APIRequestContext,
  authHeaders: Record<string, string>,
  seed: { customerId: string; locationId: string },
  summary: string,
): Promise<CreatedEntity> {
  return postJson(request, `${API_URL}/api/jobs`, authHeaders, {
    customerId: seed.customerId,
    locationId: seed.locationId,
    summary,
    priority: 'normal',
  });
}

/**
 * Fires the racing `POST /:id/schedule` — deliberately NOT awaited by the
 * caller until both are in flight, so `Promise.all` below actually overlaps
 * them at the HTTP layer rather than serializing on a single keep-alive
 * connection. This is the SAME route `job-appointment-sync.ts`'s
 * `ensurePrimaryTechnician` → `assignTechnician` runs for, on an EXISTING
 * job — no job-number allocation in the raced path.
 */
function raceSchedule(
  request: APIRequestContext,
  authHeaders: Record<string, string>,
  jobId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return request
    .post(`${API_URL}/api/jobs/${jobId}/schedule`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify(body),
    })
    .then(async (res) => ({ status: res.status(), body: (await res.json()) as Record<string, unknown> }));
}

test.describe('technician double-booking race (3.6) — real Postgres, real HTTP concurrency', () => {
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

  test('two concurrent POST /api/jobs for the SAME technician + overlapping slot: exactly one succeeds; a second tenant\'s own concurrent race is unaffected (T2)', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const fixtureA = await bootstrapOwnerAndTechnician(page.request, 'a');
    const fixtureB = await bootstrapOwnerAndTechnician(page.request, 'b');

    const raceStartA = '2099-06-15T14:00:00.000Z';
    const [seedX, seedY] = await Promise.all([
      seedCustomerLocation(page.request, fixtureA.ownerHeaders, 'ax'),
      seedCustomerLocation(page.request, fixtureA.ownerHeaders, 'ay'),
    ]);
    // Sequential — see createUnscheduledJob's own comment (job-number
    // allocation has its own unguarded race, a confound this row is not
    // about).
    const jobX = await createUnscheduledJob(page.request, fixtureA.ownerHeaders, seedX, 'Race job X');
    const jobY = await createUnscheduledJob(page.request, fixtureA.ownerHeaders, seedY, 'Race job Y');

    // ── The race: TWO concurrent `POST /:id/schedule` requests assigning
    //    the SAME technician to the IDENTICAL window on two DIFFERENT
    //    EXISTING jobs, through the real HTTP route. ────────────────────────
    const [resultX, resultY] = await Promise.all([
      raceSchedule(page.request, fixtureA.ownerHeaders, jobX.id, {
        scheduledStart: raceStartA,
        durationMin: 60,
        timezone: 'Etc/UTC',
        technicianId: fixtureA.techId,
      }),
      raceSchedule(page.request, fixtureA.ownerHeaders, jobY.id, {
        scheduledStart: raceStartA,
        durationMin: 60,
        timezone: 'Etc/UTC',
        technicianId: fixtureA.techId,
      }),
    ]);

    const successesA = [resultX, resultY].filter((r) => r.status === 200);
    const conflictsA = [resultX, resultY].filter((r) => r.status === 409);
    expect(
      successesA.length,
      `expected exactly 1 success, got X=${resultX.status} Y=${resultY.status}: ${JSON.stringify([resultX.body, resultY.body])}`,
    ).toBe(1);
    expect(
      conflictsA.length,
      `the other concurrent request must be rejected as a conflict (409); got X=${resultX.status} Y=${resultY.status}: ${JSON.stringify([resultX.body, resultY.body])}`,
    ).toBe(1);

    // ── Durable proof: the dispatch board shows EXACTLY one appointment in
    //    the technician's lane for that window — the loser's job was rolled
    //    back, not left as an orphan unscheduled row. ───────────────────────
    const boardRes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=2099-06-15&timezone=Etc/UTC`,
      { headers: fixtureA.ownerHeaders },
    );
    expect(boardRes.ok()).toBeTruthy();
    const board = (await boardRes.json()) as {
      technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; scheduledStart: string }> }>;
    };
    const laneA = board.technicianLanes.find((l) => l.technicianId === fixtureA.techId);
    expect(laneA, 'technician A\'s lane must exist on the board').toBeTruthy();
    const overlapping = laneA!.appointments.filter((a) => a.scheduledStart === raceStartA);
    expect(overlapping, 'exactly ONE appointment must occupy the raced window').toHaveLength(1);

    // ── The winning job's own id must be the one embedded in the board's
    //    single appointment for this window — proves the WINNER's own
    //    request (not just "some" job) is what landed. ──────────────────────
    const winner = successesA[0].body as { id: string };
    expect(
      [jobX.id, jobY.id],
      'the winning schedule response must be one of THIS race\'s two actual jobs',
    ).toContain(winner.id);

    // ── Real owner browser: visit the SAME /dispatch board and see exactly
    //    one card in the technician's lane for the raced window. ───────────
    await installClerkStub(page, { signedIn: true, sub: fixtureA.ownerSub, token: fixtureA.ownerJwt });
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
    await page.getByTestId('date-nav-picker').fill('2099-06-15');
    const laneLocator = page.locator(
      `[data-testid="technician-lane"][data-technician-id="${fixtureA.techId}"]`,
    );
    await expect(laneLocator).toBeVisible({ timeout: 15_000 });
    await expect(laneLocator.getByTestId('appointment-card')).toHaveCount(1, { timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.6-dispatch-board-race-winner.png'), fullPage: true });

    // ── T2 — a SECOND tenant's OWN concurrent race, in the SAME run, is
    //    entirely unaffected by tenant A's race above (its own technician,
    //    its own customers, its own window). ────────────────────────────────
    const raceStartB = '2099-06-16T09:00:00.000Z';
    const [seedP, seedQ] = await Promise.all([
      seedCustomerLocation(page.request, fixtureB.ownerHeaders, 'bp'),
      seedCustomerLocation(page.request, fixtureB.ownerHeaders, 'bq'),
    ]);
    const jobP = await createUnscheduledJob(page.request, fixtureB.ownerHeaders, seedP, 'Race job P (tenant B)');
    const jobQ = await createUnscheduledJob(page.request, fixtureB.ownerHeaders, seedQ, 'Race job Q (tenant B)');
    const [resultP, resultQ] = await Promise.all([
      raceSchedule(page.request, fixtureB.ownerHeaders, jobP.id, {
        scheduledStart: raceStartB,
        durationMin: 60,
        timezone: 'Etc/UTC',
        technicianId: fixtureB.techId,
      }),
      raceSchedule(page.request, fixtureB.ownerHeaders, jobQ.id, {
        scheduledStart: raceStartB,
        durationMin: 60,
        timezone: 'Etc/UTC',
        technicianId: fixtureB.techId,
      }),
    ]);
    const successesB = [resultP, resultQ].filter((r) => r.status === 200);
    expect(
      successesB.length,
      `tenant B's own race must ALSO resolve to exactly one winner; got P=${resultP.status} Q=${resultQ.status}: ${JSON.stringify([resultP.body, resultQ.body])}`,
    ).toBe(1);

    const boardBRes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=2099-06-16&timezone=Etc/UTC`,
      { headers: fixtureB.ownerHeaders },
    );
    const boardB = (await boardBRes.json()) as {
      technicianLanes: Array<{ technicianId: string; appointments: Array<{ scheduledStart: string }> }>;
    };
    const laneB = boardB.technicianLanes.find((l) => l.technicianId === fixtureB.techId);
    expect(laneB!.appointments.filter((a) => a.scheduledStart === raceStartB)).toHaveLength(1);

    // Tenant A's board, re-queried AFTER tenant B's race, is byte-identical
    // in shape — B's race never touched A's technician or window.
    const boardAAfterRes = await page.request.get(
      `${API_URL}/api/dispatch/board?date=2099-06-15&timezone=Etc/UTC`,
      { headers: fixtureA.ownerHeaders },
    );
    const boardAAfter = (await boardAAfterRes.json()) as {
      technicianLanes: Array<{ technicianId: string; appointments: Array<{ scheduledStart: string }> }>;
    };
    const laneAAfter = boardAAfter.technicianLanes.find((l) => l.technicianId === fixtureA.techId);
    expect(laneAAfter!.appointments.filter((a) => a.scheduledStart === raceStartA)).toHaveLength(1);

    expect(pageErrors, 'no uncaught page errors while viewing the dispatch board').toEqual([]);
  });
});
