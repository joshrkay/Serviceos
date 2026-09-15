import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 4.3 — concurrent-drag presence, reached in TWO REAL BROWSERS (issue #1017).
 *
 * `packages/api/test/integration/dispatch-presence-redis.test.ts` already
 * proves the presence store's take/hold/release/TTL-expiry/tenant-isolation
 * semantics against a REAL Redis testcontainer, and the revision-token
 * (`If-Match`/`appointmentVersion`) ordering guarantee against REAL
 * Postgres — but both by calling stores/routes directly, not through the
 * real `/dispatch` UI. This spec proves the SAME hold is reachable from two
 * real, independent browser sessions: dragging a card in one browser makes
 * the OTHER browser's board render the "X is moving this" chip
 * (`packages/web/src/components/dispatch/AppointmentCard.tsx:187-193`,
 * `data-testid="appointment-editing-chip"`), and releasing the drag clears
 * it — end to end through the real HTTP presence fallback
 * (`PUT/DELETE /api/dispatch/presence`), the real SSE board stream
 * (`GET /api/dispatch/board/events`), and a real board refetch that embeds
 * `findEditingOnAppointment` (`presence-store.ts`) into the appointment.
 *
 * Transport note (see the lane report for the full trace): this repo's
 * client-gateway WebSocket presence transport is OFF by default
 * (`CLIENT_WS_GATEWAY_ENABLED` unset — app.ts:4499), so `useDispatchPresence`
 * runs its HTTP-fallback branch here — a real PUT fires IMMEDIATELY on drag
 * start (the effect's dependency array includes the dragged appointment id,
 * so the effect re-runs and sends before the 30s poll interval), and
 * `useDispatchBoardStream` treats `presence_updated` as `!presenceViaWs` and
 * refetches the board on it. This is the genuinely-reachable path in the
 * default environment; it is HTTP+SSE, not the WS gateway.
 *
 * Redis: the API webServer for this spec is started with `REDIS_URL`
 * pointing at a real `redis:7-alpine` testcontainer (see the lane report for
 * the exact command) — `initDispatchPresenceStore(process.env.REDIS_URL)`
 * (app.ts:4950) selects `RedisDispatchPresenceStore` for the single api
 * process both browsers talk to. This is a SINGLE api process, so it does
 * not exercise cross-replica Redis sharing (the vitest integration file
 * does, with two separate ioredis connections) — it proves the real Redis
 * codepath is what answers the browser, not the in-memory fallback.
 *
 * Bootstrap pattern mirrors e2e/journeys/accept-invitation.spec.ts (owner
 * bootstrap + invite/webhook-join + HMAC tenant-scoped token) and
 * e2e/journeys/dispatch-drag-proposal.spec.ts (drag mechanics, screenshot
 * evidence convention). The second board user here is a SECOND OWNER
 * (role: 'owner'), invited through the real `/api/users/invitations` +
 * webhook-join flow — not a technician — per this row's ask.
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

/** Direct SQL seed for the technician — no browser session of theirs is ever
 *  used in this spec, so a real invitation/webhook round trip for them would
 *  only add noise (the SECOND owner, the one this row asks for, IS seeded
 *  through the real invitation flow below). Mirrors the direct-SQL technician
 *  insert in test/integration/dispatch-drag-proposal.test.ts's
 *  seedTenantFixture, just over psql instead of a Pg repo. */
function insertTechnicianDirect(tenantId: string, techId: string, label: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (E2E_USE_TEST_DB=true path)');
  execFileSync('psql', [
    databaseUrl,
    '-c',
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ('${techId}', '${tenantId}', '${techId}', '${label}-presence-tech@example.com', 'technician');`,
  ]);
}

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

interface PresenceFixture {
  owner1Sub: string;
  owner1Jwt: string;
  owner1Headers: Record<string, string>;
  owner2Sub: string;
  tenantId: string;
  techId: string;
  appointmentId: string;
  todayStr: string;
}

/** Bootstraps tenant `label` with owner 1 (webhook bootstrap), owner 2
 *  (REAL invitation + webhook-join, role: 'owner' — this row's ask), a
 *  directly-seeded technician, and one appointment on that technician's
 *  lane. */
async function seedTenantWithTwoOwners(
  page: import('@playwright/test').Page,
  label: string,
): Promise<PresenceFixture> {
  const owner1Sub = `user_e2e_${label}pres1_${randomUUID().replace(/-/g, '')}`;
  const owner1Email = `${label}pres1-${Date.now()}@serviceos-hermetic.test`;
  const owner1Jwt = unsignedJwt(owner1Sub);
  const owner1Headers = { Authorization: `Bearer ${owner1Jwt}` };

  const bootstrapRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: owner1Sub, email_addresses: [{ email_address: owner1Email }] },
  });
  expect(bootstrapRes.status(), `${label} owner1 bootstrap -> ${await bootstrapRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: owner1Headers });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...owner1Headers },
    data: JSON.stringify({
      businessName: `Presence E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  // ── Second OWNER, via the REAL invitation flow (not a technician) ────────
  const owner2Email = `${label}pres2-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...owner1Headers },
    data: JSON.stringify({ email: owner2Email, role: 'owner' }),
  });
  expect(inviteRes.status(), `POST /api/users/invitations (${label}, role owner) -> ${await inviteRes.text()}`).toBe(201);
  const invitation = (await inviteRes.json()) as { id?: string };
  const invitationId = invitation.id!;

  const owner2Sub = `user_e2e_${label}pres2_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: {
      id: owner2Sub,
      email_addresses: [{ email_address: owner2Email }],
      public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'owner' },
    },
  });
  expect(joinRes.status(), `owner2 invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);
  const joinBody = (await joinRes.json()) as { joined?: string };
  expect(joinBody.joined, 'owner2 must join the SAME tenant as owner1').toBe(tenantId);

  const techId = randomUUID();
  insertTechnicianDirect(tenantId, techId, label);

  const stamp = Date.now();
  const customer = await postJson(page, `${API_URL}/api/customers`, owner1Headers, {
    firstName: label,
    lastName: `Presence Customer ${stamp}`,
    primaryPhone: '555-0199',
    email: `${label}.presence.customer+${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
    source: 'referral',
  });
  const location = await postJson(page, `${API_URL}/api/locations`, owner1Headers, {
    customerId: customer.id,
    label: 'Home',
    street1: '3 Presence Test Ave',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
  });
  const todayStr = new Date().toISOString().split('T')[0];
  // TWO appointments in the lane (mirrors dispatch-drag-proposal.spec.ts's
  // seedOwnerTechAndTwoAppointments): with only ONE card in a lane, dragging
  // it to the lane's own trailing gap is a same-position no-op
  // (DispatchBoard.tsx's `isSameLaneNoOp` short-circuits it with a toast and
  // never opens the confirm dialog) — a second, later appointment makes the
  // drag a genuine reorder so the drop actually opens the dialog we dismiss.
  const jobEarly = await postJson(page, `${API_URL}/api/jobs`, owner1Headers, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} presence test — earlier slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T09:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });
  await postJson(page, `${API_URL}/api/jobs`, owner1Headers, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} presence test — later slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T13:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });

  const boardRes = await page.request.get(
    `${API_URL}/api/dispatch/board?date=${todayStr}&timezone=Etc/UTC`,
    { headers: owner1Headers },
  );
  expect(boardRes.ok(), `GET /api/dispatch/board (${label}) -> ${boardRes.status()}`).toBeTruthy();
  const board = (await boardRes.json()) as {
    technicianLanes: Array<{ technicianId: string; appointments: Array<{ id: string; jobId: string }> }>;
  };
  const lane = board.technicianLanes.find((l) => l.technicianId === techId);
  expect(lane, `${label}'s technician lane must exist`).toBeTruthy();
  expect(lane!.appointments.length, `${label}'s lane must have exactly the two seeded appointments`).toBe(2);
  const earlyAppt = lane!.appointments.find((a) => a.jobId === jobEarly.id);
  expect(earlyAppt, `${label}'s earlier appointment must be on the board`).toBeTruthy();
  const appointmentId = earlyAppt!.id;

  return { owner1Sub, owner1Jwt, owner1Headers, owner2Sub, tenantId, techId, appointmentId, todayStr };
}

async function openDispatchBoardAs(
  targetPage: import('@playwright/test').Page,
  baseURL: string,
  sub: string,
  token: string,
  techId: string,
  todayStr: string,
): Promise<import('@playwright/test').Locator> {
  await installClerkStub(targetPage, { signedIn: true, sub, token });
  await targetPage.addInitScript(
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
  await blockExternalHosts(targetPage, baseURL);
  await targetPage.goto('/dispatch');
  await expect(targetPage.getByTestId('dispatch-board')).toBeVisible({ timeout: 30_000 });
  await targetPage.getByTestId('date-nav-picker').fill(todayStr);
  await expect(targetPage.getByTestId('date-nav-picker')).toHaveValue(todayStr);
  const lane = targetPage.locator(`[data-testid="technician-lane"][data-technician-id="${techId}"]`);
  // Multiple concurrent browser contexts against one dev-mode server (this
  // Mac also runs other lanes' agents concurrently) can leave the FIRST
  // board fetch (the browser's local-date default, wrong when local tz !=
  // UTC — see dispatch-drag-proposal.spec.ts's identical note) racing the
  // fill()-triggered refetch; a plain reload forces one clean fetch for the
  // date already in the input if the lane still hasn't appeared shortly
  // after the fill.
  try {
    await expect(lane).toBeVisible({ timeout: 20_000 });
  } catch {
    await targetPage.reload();
    await expect(targetPage.getByTestId('dispatch-board')).toBeVisible({ timeout: 30_000 });
    // selectedDate is component state, not persisted — a reload resets it to
    // the browser's local "today" default, so the date must be re-filled.
    await targetPage.getByTestId('date-nav-picker').fill(todayStr);
    await expect(targetPage.getByTestId('date-nav-picker')).toHaveValue(todayStr);
    await expect(lane).toBeVisible({ timeout: 30_000 });
  }
  await expect(lane.getByTestId('appointment-card')).toHaveCount(2, { timeout: 15_000 });
  return lane;
}

test.describe('dispatch presence (4.3) — real Redis-backed API, two real browsers', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres (+ REDIS_URL pointed at a real ' +
      'redis:7-alpine testcontainer for the api process — see the lane report for the exact ' +
      'command): leave E2E_BASE_URL unset, set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container.',
  );

  test('user 2 sees user 1 holding the card while dragging; releasing clears it; T2 — tenant B never sees it', async ({
    page,
    context,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: owner 1 (drags) + owner 2 (watches), same tenant ──────────
    const fixtureA = await seedTenantWithTwoOwners(page, 'a');

    const owner2Context = await context.browser()!.newContext();
    const owner2Page = await owner2Context.newPage();
    const owner2Token = hmacToken(fixtureA.owner2Sub, fixtureA.tenantId, 'owner');

    // ── Tenant B: a passive owner on their OWN, entirely separate board —
    //    the T2 bystander, seeded with its own divergent tenant/appointment. ─
    const bContext = await context.browser()!.newContext();
    const bPage = await bContext.newPage();
    const fixtureB = await seedTenantWithTwoOwners(bPage, 'b');

    const laneOwner1 = await openDispatchBoardAs(
      page,
      baseURL!,
      fixtureA.owner1Sub,
      fixtureA.owner1Jwt,
      fixtureA.techId,
      fixtureA.todayStr,
    );
    const laneOwner2 = await openDispatchBoardAs(
      owner2Page,
      baseURL!,
      fixtureA.owner2Sub,
      owner2Token,
      fixtureA.techId,
      fixtureA.todayStr,
    );
    const laneTenantB = await openDispatchBoardAs(
      bPage,
      baseURL!,
      fixtureB.owner1Sub,
      fixtureB.owner1Jwt,
      fixtureB.techId,
      fixtureB.todayStr,
    );

    // Scope to the SPECIFIC (earlier) appointment being dragged — the lane
    // has two cards now (a same-lane single-card drop is a no-op, see the
    // seed helper's comment), so an unscoped `appointment-card` locator
    // would be ambiguous.
    const card1 = laneOwner1.locator(
      `[data-testid="appointment-card"][data-appointment-id="${fixtureA.appointmentId}"]`,
    );
    const card2 = laneOwner2.locator(
      `[data-testid="appointment-card"][data-appointment-id="${fixtureA.appointmentId}"]`,
    );
    const cardB = laneTenantB.locator(
      `[data-testid="appointment-card"][data-appointment-id="${fixtureB.appointmentId}"]`,
    );
    const chip2 = card2.getByTestId('appointment-editing-chip');
    const chipB = cardB.getByTestId('appointment-editing-chip');

    await expect(chip2, 'before any drag: owner 2 sees no held indicator').toHaveCount(0);
    await expect(chipB, 'tenant B starts with no held indicator either').toHaveCount(0);

    await owner2Page.screenshot({
      path: 'docs/audit/lane-reports/8-4-presence/1-before-drag-owner2-view.png',
      fullPage: true,
    });

    // ── User 1 starts dragging: mousedown + move over a drop target, but NOT
    //    released yet. This fires the real `dragstart` (AppointmentCard.tsx),
    //    which calls `setDragSource` (DispatchBoard.tsx), which
    //    `useDispatchPresence` picks up immediately (its HTTP-fallback effect
    //    depends on the dragged appointment id) and PUTs
    //    `/api/dispatch/presence` with `mode: 'dragging'`. ────────────────────
    const gap1 = laneOwner1.getByTestId('technician-lane-gap').last();
    await card1.hover();
    await page.mouse.down();
    await gap1.hover();

    // ── Owner 2's board learns of the hold via the real SSE stream
    //    (`presence_updated` → refetch, since CLIENT_WS_GATEWAY_ENABLED is
    //    unset by default) and renders the chip. ─────────────────────────────
    await expect(
      chip2,
      'owner 2 must see the held indicator on the SAME card while owner 1 is mid-drag',
    ).toBeVisible({ timeout: 20_000 });
    await expect(chip2).toContainText('is moving this');

    await owner2Page.screenshot({
      path: 'docs/audit/lane-reports/8-4-presence/2-during-drag-owner2-sees-held.png',
      fullPage: true,
    });

    // ── T2, asserted WHILE the hold is live: tenant B's owner, on their own
    //    entirely different board/tenant/appointment, sees nothing. ─────────
    await expect(
      chipB,
      'T2 — tenant B must NEVER see tenant A\'s hold, even while it is live',
    ).toHaveCount(0);
    await bPage.screenshot({
      path: 'docs/audit/lane-reports/8-4-presence/3-tenant-b-unaffected-during-hold.png',
      fullPage: true,
    });

    // ── User 1 releases (drop). The board's drop handler clears dragSource
    //    immediately (DispatchBoard.tsx handleDropOnGap) and opens the
    //    confirm-proposal dialog; dismiss it without confirming — this spec
    //    is about presence, not proposal creation (row 4.2's job). ──────────
    await page.mouse.up();
    const dialog = page.getByTestId('confirm-proposal-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('confirm-proposal-cancel').click();
    await expect(dialog).toBeHidden();

    // ── Owner 2's indicator clears. ──────────────────────────────────────────
    await expect(
      chip2,
      'the held indicator must clear on owner 2\'s board once owner 1 releases',
    ).toBeHidden({ timeout: 20_000 });

    await owner2Page.screenshot({
      path: 'docs/audit/lane-reports/8-4-presence/4-after-release-cleared.png',
      fullPage: true,
    });

    await owner2Context.close();
    await bContext.close();

    expect(pageErrors, 'no uncaught page errors during the presence journey').toEqual([]);
  });
});
