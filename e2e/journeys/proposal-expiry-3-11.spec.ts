import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { runProposalExpirySweep } from '../../packages/api/src/workers/proposal-expiry-worker';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { createProposal } from '../../packages/api/src/proposals/proposal';
import { listAllTenantIds } from '../../packages/api/src/tenants/list-tenant-ids';
import { createLogger } from '../../packages/api/src/logging/logger';

/**
 * §8.3 row 3.11 — rung-5 reachability: "stale schedule proposals expire, so
 * I'm not approving yesterday's plan" — and "can be re-proposed."
 *
 * packages/api/test/integration/proposal-expiry-sweep-3-11.test.ts already
 * proves `runProposalExpirySweep` at real Postgres (T2: a neighbour tenant's
 * fresh proposal is spared) — but every proposal there is seeded directly
 * through `createProposal`/`proposalRepo.create`, backdating `createdAt`,
 * never through the real drag/approve surface, and no browser ever sees the
 * result.
 *
 * This file: a REAL owner drags a real appointment card on the real
 * `/dispatch` board (the exact mechanism e2e/journeys/dispatch-drag-proposal
 * .spec.ts proves for row 4.2), producing a genuine `reschedule_appointment`
 * draft with the product's real 48h clock. `runProposalExpirySweep` (the
 * SAME function app.ts's setInterval invokes) is called directly against
 * the real Postgres the API webServer is pointed at, with an injected clock
 * just past that REAL expiry (waiting out 48h in CI is not viable — same
 * reasoning as this suite's other sweep-reachability specs). The owner then
 * reloads the real `/inbox` page and sees the card move into the "Expired
 * schedule proposals" section, clicks the real "Re-propose" button, and a
 * fresh draft with a new 48h clock appears back in the ordinary list.
 *
 * T2 — a neighbour tenant's OWN fresh schedule proposal (seeded via the same
 * production `createProposal` domain function with an explicit far-future
 * expiry, mirroring the underlying integration test's own technique) is
 * swept in the SAME pass and is provably untouched, reachable on ITS OWN
 * real `/inbox` page.
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

interface OwnerFixture {
  ownerSub: string;
  ownerJwt: string;
  ownerHeaders: Record<string, string>;
  tenantId: string;
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<OwnerFixture> {
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
      businessName: `Proposal Expiry E2E ${label.toUpperCase()}`,
      businessHours: allDayHours(),
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'Etc/UTC',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { ownerSub, ownerJwt, ownerHeaders, tenantId };
}

/** Owner + technician + two appointments today, mirroring
 *  dispatch-drag-proposal.spec.ts's fixture exactly. */
async function seedOwnerTechAndTwoAppointments(
  request: APIRequestContext,
  label: string,
): Promise<OwnerFixture & { techId: string; jobEarly: CreatedEntity; todayStr: string }> {
  const owner = await bootstrapOwner(request, label);

  const techEmail = `${label}tech-${Date.now()}@serviceos-hermetic.test`;
  const inviteRes = await request.post(`${API_URL}/api/users/invitations`, {
    headers: { 'content-type': 'application/json', ...owner.ownerHeaders },
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
      public_metadata: { invitation_id: invitationId, tenant_id: owner.tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status(), `invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);

  const techToken = hmacToken(techSub, owner.tenantId, 'technician');
  const techMeRes = await request.get(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${techToken}` } });
  expect(techMeRes.status(), `technician /api/me (${label}) -> ${await techMeRes.text()}`).toBe(200);
  const techMe = (await techMeRes.json()) as { internal_user_id?: string };
  expect(techMe.internal_user_id).toMatch(UUID_RE);
  const techId = techMe.internal_user_id!;

  const stamp = Date.now();
  const customer = await postJson(request, `${API_URL}/api/customers`, owner.ownerHeaders, {
    firstName: label,
    lastName: `Expiry Customer ${stamp}`,
    primaryPhone: '555-0166',
    email: `${label}.expiry.customer+${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const location = await postJson(request, `${API_URL}/api/locations`, owner.ownerHeaders, {
    customerId: customer.id,
    label: 'Home',
    street1: `${label} Expiry Test Ave`,
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    isPrimary: true,
  });
  const todayStr = new Date().toISOString().split('T')[0];
  const jobEarly = await postJson(request, `${API_URL}/api/jobs`, owner.ownerHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} expiry test — earlier slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T09:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });
  await postJson(request, `${API_URL}/api/jobs`, owner.ownerHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} expiry test — later slot`,
    priority: 'normal',
    scheduledStart: `${todayStr}T13:00:00.000Z`,
    durationMin: 60,
    timezone: 'Etc/UTC',
    technicianId: techId,
  });

  return { ...owner, techId, jobEarly, todayStr };
}

test.describe('proposal expiry sweep (3.11) — real Postgres', () => {
  const canRun =
    // A LOCALHOST E2E_BASE_URL means a self-managed, dedicated-port
    // webServer pair (this lane's own workaround for sibling lanes
    // squatting the default port 5173 on a shared Mac) — not a remote
    // deployed environment, so it does not disqualify a run.
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to run the expiry sweep).',
  );

  test('a real drag-created schedule proposal expires on the real inbox and can be re-proposed; a neighbour tenant\'s fresh proposal is spared (T2)', async ({
    page,
    context,
    baseURL,
  }: { page: Page; context: import('@playwright/test').BrowserContext; baseURL?: string }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: real owner + technician + two appointments. ──────────────
    const fixtureA = await seedOwnerTechAndTwoAppointments(page.request, 'a');

    // ── Real owner browser drags a card on the real /dispatch board — the
    //    SAME mechanism row 4.2 proves — producing a genuine draft schedule
    //    proposal with the product's real 48h clock. ────────────────────────
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
    await page.getByTestId('date-nav-picker').fill(fixtureA.todayStr);
    const lane = page.locator(`[data-testid="technician-lane"][data-technician-id="${fixtureA.techId}"]`);
    await expect(lane).toBeVisible({ timeout: 15_000 });
    await expect(lane.getByTestId('appointment-card')).toHaveCount(2, { timeout: 15_000 });
    const sourceCard = lane.getByTestId('appointment-card').first();
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
    const proposalA = (await proposalRes.json()) as { id: string; status: string; expiresAt?: string };
    expect(proposalA.status).toBe('draft');
    expect(proposalA.expiresAt, 'a schedule proposal must carry an expiry').toBeTruthy();
    const expiresAtA = new Date(proposalA.expiresAt!);

    // ── The real /inbox shows it as an ordinary pending row BEFORE expiry. ──
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-row')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('expired-section')).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.11-inbox-before-expiry.png'), fullPage: true });

    // ── Tenant B: a T2 neighbour with its OWN fresh schedule proposal,
    //    seeded via the SAME production `createProposal` domain function
    //    with an explicit far-future expiry (mirrors the underlying
    //    integration test's own seeding technique — not raw SQL). ──────────
    const ownerB = await bootstrapOwner(page.request, 'b');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let proposalBId!: string;
    try {
      const proposalRepo = new PgProposalRepository(pool);
      const auditRepo = new PgAuditRepository(pool);

      const farFutureExpiry = new Date(expiresAtA.getTime() + 200 * 60 * 60 * 1000); // +200h past A's expiry
      const baseB = createProposal({
        tenantId: ownerB.tenantId,
        proposalType: 'reschedule_appointment',
        payload: { note: '3.11 T2 fixture — must survive the sweep' },
        summary: 'Neighbour tenant fresh schedule proposal',
        createdBy: ownerB.ownerSub,
      });
      const proposalB = await proposalRepo.create({
        ...baseB,
        status: 'draft',
        expiresAt: farFutureExpiry,
      });
      proposalBId = proposalB.id;

      // ── The production sweep, called directly (a worker tick, not an
      //    admin route), with an injected clock 1 minute past tenant A's
      //    REAL 48h expiry — and the REAL tenant enumerator. ────────────────
      const now = new Date(expiresAtA.getTime() + 60_000);
      const sweepResult = await runProposalExpirySweep({
        proposalRepo,
        auditRepo,
        listTenantIds: () => listAllTenantIds(pool),
        logger: createLogger({ service: 'e2e-proposal-expiry', environment: 'test', level: 'error' }),
        now: () => now,
      });
      expect(sweepResult.expired, `sweep result -> ${JSON.stringify(sweepResult)}`).toBeGreaterThanOrEqual(1);
      expect(sweepResult.failed).toBe(0);

      // ── Durable proof: tenant A's proposal is expired with its audit row;
      //    tenant B's is untouched, zero audit rows. ─────────────────────────
      const afterA = await proposalRepo.findById(fixtureA.tenantId, proposalA.id);
      expect(afterA?.status).toBe('expired');
      const eventsA = await auditRepo.findByEntity(fixtureA.tenantId, 'proposal', proposalA.id);
      expect(eventsA.some((e) => e.eventType === 'proposal.expired')).toBe(true);

      const afterB = await proposalRepo.findById(ownerB.tenantId, proposalBId);
      expect(afterB?.status).toBe('draft');
      const eventsB = await auditRepo.findByEntity(ownerB.tenantId, 'proposal', proposalBId);
      expect(eventsB).toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── Real owner browser, reloaded: the card moved to "Expired schedule
    //    proposals". ─────────────────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('expired-section')).toBeVisible({ timeout: 15_000 });
    const expiredRow = page.getByTestId('expired-row');
    await expect(expiredRow).toHaveCount(1);
    await expect(page.getByTestId('inbox-row')).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.11-inbox-after-expiry.png'), fullPage: true });

    // ── Click the real "Re-propose" button — a fresh draft with a NEW 48h
    //    clock is created. The client optimistically hides the clicked card
    //    (InboxPage.tsx's `repropose()`), but that is a one-shot UI nicety,
    //    not a durable contract: the ORIGINAL source proposal stays
    //    genuinely, permanently 'expired' in the DB (re-proposing mints a
    //    new draft; it never un-expires or deletes the source — comment on
    //    `reproposeProposal`, proposals/actions.ts), so the very next
    //    fetch/poll/reload legitimately shows it in the expired section
    //    again. The durable proof is the NEW draft appearing in the
    //    ordinary list AFTER a reload — not the old card's momentary
    //    disappearance. ───────────────────────────────────────────────────
    const reproposePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/re-propose'),
    );
    await expiredRow.getByRole('button', { name: /re-propose/i }).click();
    const reproposeRes = await reproposePromise;
    expect(reproposeRes.status(), `POST .../re-propose -> ${reproposeRes.status()}`).toBe(201);
    const reproposed = (await reproposeRes.json()) as { id: string; status: string; expiresAt?: string };
    expect(reproposed.id).not.toBe(proposalA.id);
    expect(reproposed.status).toBe('draft');
    expect(reproposed.expiresAt, 'the re-proposed draft must carry a FRESH expiry').toBeTruthy();
    expect(new Date(reproposed.expiresAt!).getTime()).toBeGreaterThan(expiresAtA.getTime());

    await page.reload({ waitUntil: 'domcontentloaded' });
    // Durable proof the new draft is really in the ordinary pending feed
    // (not just the in-memory optimistic client state): the real
    // GET /api/proposals/inbox the reloaded page itself fetches.
    const inboxAfterRes = await page.request.get(`${API_URL}/api/proposals/inbox`, {
      headers: fixtureA.ownerHeaders,
    });
    const inboxAfter = (await inboxAfterRes.json()) as { data: Array<{ proposal: { id: string } }> };
    expect(
      inboxAfter.data.some((p) => p.proposal.id === reproposed.id),
      'the re-proposed draft must be in the real inbox response',
    ).toBe(true);
    await expect(page.getByTestId('inbox-row')).toHaveCount(1, { timeout: 15_000 });
    // The ORIGINAL source is still (legitimately, permanently) expired —
    // re-proposing supersedes it, it does not delete or un-expire it.
    await expect(page.getByTestId('expired-row')).toHaveCount(1);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.11-inbox-after-repropose.png'), fullPage: true });

    // The original expired source is untouched by the re-propose (terminal).
    const finalPool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const proposalRepo = new PgProposalRepository(finalPool);
      const originalAfterRepropose = await proposalRepo.findById(fixtureA.tenantId, proposalA.id);
      expect(originalAfterRepropose?.status).toBe('expired');
    } finally {
      await finalPool.end().catch(() => undefined);
    }

    // ── Tenant B's OWN real /inbox, in a fresh browser context: its fresh
    //    proposal is still an ordinary pending row, never expired. ─────────
    const bContext = await context.browser()!.newContext();
    const bPage = await bContext.newPage();
    await installClerkStub(bPage, { signedIn: true, sub: ownerB.ownerSub, token: ownerB.ownerJwt });
    await blockExternalHosts(bPage, baseURL!);
    await bPage.goto('/inbox');
    await expect(bPage.getByTestId('inbox-row')).toHaveCount(1, { timeout: 15_000 });
    await expect(bPage.getByTestId('expired-section')).toHaveCount(0);
    await bPage.screenshot({ path: join(SCREENSHOT_DIR, '3.11-inbox-tenant-b-untouched.png'), fullPage: true });
    await bContext.close();

    expect(pageErrors, 'no uncaught page errors during the proposal-expiry journey').toEqual([]);
  });
});
