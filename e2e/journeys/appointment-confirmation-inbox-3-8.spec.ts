import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { createProposal } from '../../packages/api/src/proposals/proposal';
import { transitionProposal } from '../../packages/api/src/proposals/lifecycle';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';

/**
 * §8.3 row 3.8 — rung-5 REACHABILITY for "As M, I want my customer to get a
 * confirmation when I approve, so they don't call back to check."
 *
 * `packages/api/test/integration/appointment-confirmation-dispatch-3-8.test.ts`
 * proves at real Postgres (T1·T3) that an approved `create_appointment`,
 * executed through the production execution registry, writes an
 * `appointment_confirmation` row to `message_dispatches` — including the
 * #1077 no-provider case, which now records a `failed` / `provider: none` row
 * instead of skipping silently. Every approval there is a direct executor
 * call. What it never does is the thing the story names: the OWNER approving,
 * on the real Inbox, in a real browser.
 *
 * This spec: two real owners sign up (Clerk webhook + onboarding identity),
 * each creates a real customer / location / job through the authenticated API,
 * and each has a `create_appointment` proposal waiting for review (seeded via
 * the production `createProposal` constructor + `PgProposalRepository` — the
 * in-app drafting path needs a model, which this hermetic run does not have).
 * Owner A opens `/inbox`, sees the card and clicks Approve. The running API's
 * own executor books the appointment and writes the confirmation row for A's
 * customer — whatever delivery mode this API booted in, the row exists and
 * says what happened to it.
 *
 * T1: owner B's waiting card is never on A's Inbox; B ends with no appointment
 * and no confirmation row; A's rows are A's only.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';
const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-3-book-inapp-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: 'dev-session', role: 'owner' })}.x`;
}
function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

interface Owner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<Owner> {
  const sub = `user_e2e_confirm_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-confirm-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 'user.created', data: { id: sub, email_addresses: [{ email_address: email }] } });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Confirmation 3.8 ${label.toUpperCase()} Co`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId: me.tenant_id!, sub, jwt, authHeaders };
}

async function postJson(
  request: APIRequestContext,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<{ id: string }> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

/** A real customer (reachable by SMS) + location + job, through the API — no SQL. */
async function seedJob(request: APIRequestContext, owner: Owner, label: string, phone: string): Promise<string> {
  const customer = await postJson(request, `${API_URL}/api/customers`, owner.authHeaders, {
    firstName: label,
    lastName: `Confirm Customer ${randomUUID().slice(0, 6)}`,
    primaryPhone: phone,
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const location = await postJson(request, `${API_URL}/api/locations`, owner.authHeaders, {
    customerId: customer.id,
    street1: `${label} Confirm Ave`,
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  });
  const job = await postJson(request, `${API_URL}/api/jobs`, owner.authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} furnace tune-up`,
    priority: 'normal',
  });
  return job.id;
}

/** A create_appointment proposal waiting for the owner's review. */
async function seedReadyProposal(pool: Pool, owner: Owner, jobId: string, start: Date): Promise<string> {
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  let proposal = createProposal({
    tenantId: owner.tenantId,
    proposalType: 'create_appointment',
    payload: {
      jobId,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      timezone: 'America/Chicago',
      summary: 'Furnace tune-up',
    },
    summary: 'Book the furnace tune-up',
    createdBy: owner.sub,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', owner.sub);
  await new PgProposalRepository(pool).create(proposal);
  return proposal.id;
}

test.describe('3.8 reachability — the owner approves a booking on the real Inbox and the customer confirmation row is written', () => {
  const canRun =
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to seed the proposals).',
  );

  test('owner A approves on /inbox → one appointment, appointment.created audited, and an appointment_confirmation row for A\'s customer; owner B is untouched (T1)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const ownerA = await bootstrapOwner(request, 'a');
    const ownerB = await bootstrapOwner(request, 'b');
    const phoneA = '+15125550281';
    const phoneB = '+15125550282';
    const jobA = await seedJob(request, ownerA, 'Alpha', phoneA);
    const jobB = await seedJob(request, ownerB, 'Bravo', phoneB);

    const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    start.setUTCHours(16, 0, 0, 0);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const proposalA = await seedReadyProposal(pool, ownerA, jobA, start);
      const proposalB = await seedReadyProposal(pool, ownerB, jobB, start);

      // ── Owner A reaches the card on the REAL Inbox and approves it there. ──
      await installClerkStub(page, { signedIn: true, sub: ownerA.sub, token: ownerA.jwt });
      await page.addInitScript(
        ({ welcomeKey, whatsNewKey }) => {
          try {
            localStorage.setItem(welcomeKey, '1');
            localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
          } catch {
            /* private mode */
          }
        },
        { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
      );
      await blockExternalHosts(page, baseURL!);
      await page.goto('/inbox');
      const crashed = page.getByText('Something went wrong');
      if (await crashed.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await page.reload();
      }
      // Exactly one card: A's. B's waiting card never shows here (T1).
      await expect(page.getByTestId('inbox-row')).toHaveCount(1, { timeout: 15_000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, '3.8-01-booking-on-inbox.png') });

      const approvePromise = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${proposalA}/approve`,
      );
      await page.getByRole('button', { name: /^approve$/i }).click();
      const approveRes = await approvePromise;
      expect(approveRes.status(), `POST approve -> ${approveRes.status()}`).toBeLessThan(300);
      await expect(page.getByTestId('inbox-row')).toHaveCount(0);
      await page.screenshot({ path: join(SCREENSHOT_DIR, '3.8-02-approved.png') });

      // ── The API's own executor books it — poll the real rows. ─────────────
      await expect
        .poll(
          async () =>
            (await pool.query(`SELECT id FROM appointments WHERE tenant_id = $1 AND job_id = $2`, [ownerA.tenantId, jobA]))
              .rows.length,
          { timeout: 30_000, message: 'the approved booking never became an appointment' },
        )
        .toBe(1);
      const appointmentId = (
        await pool.query<{ id: string }>(`SELECT id FROM appointments WHERE tenant_id = $1 AND job_id = $2`, [ownerA.tenantId, jobA])
      ).rows[0].id;

      // The row the story is about: the customer's confirmation, on the channel
      // the customer is reachable by, addressed to A's customer only.
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                `SELECT id FROM message_dispatches WHERE tenant_id = $1 AND entity_type = 'appointment_confirmation' AND entity_id = $2`,
                [ownerA.tenantId, appointmentId],
              )
            ).rows.length,
          { timeout: 15_000, message: 'no appointment_confirmation row was written' },
        )
        .toBeGreaterThan(0);
      const { rows: confirmations } = await pool.query<{ channel: string; recipient: string; status: string; provider: string }>(
        `SELECT channel, recipient, status, provider FROM message_dispatches
          WHERE tenant_id = $1 AND entity_type = 'appointment_confirmation' AND entity_id = $2`,
        [ownerA.tenantId, appointmentId],
      );
      const sms = confirmations.filter((r) => r.channel === 'sms');
      expect(sms, `confirmation rows: ${JSON.stringify(confirmations)}`).toHaveLength(1);
      expect(sms[0].recipient).toBe(phoneA);
      // Never "sent" through a provider this API doesn't have — the row says
      // what happened (#1077: `failed` / `provider: none` with no provider).
      console.log(`[3.8] confirmation rows for A: ${JSON.stringify(confirmations)}`);

      const audits = await new PgAuditRepository(pool).findByEntity(ownerA.tenantId, 'appointment', appointmentId);
      expect(audits.filter((a) => a.eventType === 'appointment.created')).toHaveLength(1);

      // ── T1 — owner B: still only a waiting card, no appointment, no row;
      //    A's confirmation is not visible under B's tenant. ────────────────
      const bProposal = await pool.query<{ status: string }>(`SELECT status FROM proposals WHERE id = $1`, [proposalB]);
      expect(bProposal.rows[0].status).toBe('ready_for_review');
      expect(
        (await pool.query(`SELECT id FROM appointments WHERE tenant_id = $1`, [ownerB.tenantId])).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            `SELECT id FROM message_dispatches WHERE tenant_id = $1 AND entity_type = 'appointment_confirmation'`,
            [ownerB.tenantId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            `SELECT id FROM message_dispatches WHERE entity_id = $1 AND tenant_id <> $2`,
            [appointmentId, ownerA.tenantId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await pool.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors across the 3.8 flow').toEqual([]);
  });
});
