import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { runDailyDigestSweep } from '../../packages/api/src/workers/daily-digest-worker';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgDailyDigestRepository } from '../../packages/api/src/digest/pg-daily-digest';
import { PgDispatchRepository } from '../../packages/api/src/notifications/dispatch-repository';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';
import { PgLocationRepository } from '../../packages/api/src/locations/pg-location';
import { PgPaymentRepository } from '../../packages/api/src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../packages/api/src/estimates/pg-estimate';
import { PgAppointmentRepository } from '../../packages/api/src/appointments/pg-appointment';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgFeedbackResponseRepository } from '../../packages/api/src/feedback/pg-feedback-response';
import { PgCorrectionLessonRepository } from '../../packages/api/src/learning/corrections/pg-correction-lesson';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { createLogger } from '../../packages/api/src/logging/logger';
import type { DigestComputeDeps } from '../../packages/api/src/digest/digest-service';

/**
 * 9.6 — Daily digest client control.
 *
 * `digestEnabled` / `digestTime` / `digestChannel` were already fully wired
 * server-side (PUT /api/settings, PgSettingsRepository — map #995's
 * correction: "not unlit-able, needs no write path"). The gap was purely
 * "no client control" (gap shape 4): nothing in packages/web/src or
 * packages/mobile/src referenced `digestEnabled`. This spec proves an owner
 * can flip the new "Daily digest" toggle in Settings and have it durably
 * persist through the real API against real Postgres.
 *
 * Bootstrap pattern mirrors e2e/journeys/signup-to-first-estimate.hermetic.spec.ts.
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

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

// Suppress the welcome / what's-new walkthrough modals so they don't
// intercept the toggle click (mirrors the hermetic Journey-1 spec).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

test.describe('digest toggle (9.6) — real Postgres', () => {
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

  test('an owner flips the Daily digest toggle in Settings and it persists through PUT /api/settings', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Bootstrap the owner's tenant (hermetic webhook, DEV_AUTH_BYPASS) ────
    const ownerSub = `user_e2e_digest_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `owner-${Date.now()}@serviceos-hermetic.test`;
    const jwt = unsignedJwt(ownerSub);
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    const svixId = `evt_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    const webhookRes = await page.request.post(`${API_URL}/webhooks/clerk`, {
      headers: {
        'content-type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
      },
      data: rawBody,
    });
    expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id).toMatch(UUID_RE);

    // Clear the onboarding soft gate — /settings is not on the approval-queue
    // allowlist, so an incomplete identity step would bounce to /onboarding.
    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName: 'Digest Toggle E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // Sanity: today's default is digestEnabled: false (never set for a fresh tenant).
    const before = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(before.ok()).toBeTruthy();
    const beforeBody = (await before.json()) as { digestEnabled?: boolean };
    expect(beforeBody.digestEnabled ?? false).toBe(false);

    // ── Bind the browser session to this real tenant owner ─────────────────
    await installClerkStub(page, { signedIn: true, sub: ownerSub, token: jwt });
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

    await page.goto('/settings');
    const toggle = page.locator(
      'xpath=//p[normalize-space(text())="Daily digest"]/ancestor::div[contains(@class,"justify-between")][1]//button',
    );
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings',
    );
    await toggle.click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/settings -> ${putRes.status()}`).toBeLessThan(300);

    // ── Read back through the REAL API — the durable proof, not just the
    //    optimistic client-side toggle state. ──────────────────────────────
    const after = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(after.ok()).toBeTruthy();
    const afterBody = (await after.json()) as { digestEnabled?: boolean };
    expect(afterBody.digestEnabled).toBe(true);

    expect(pageErrors, 'no uncaught page errors while flipping the digest toggle').toEqual([]);
  });
});

/**
 * 9.6 rung-5 reachability — the digest CONTENT, not just the switch.
 *
 * The toggle spec above proves the client control persists through the real
 * API. It never proves an owner can actually SEE a digest: it flips the
 * setting and stops. This block goes the rest of the way, entirely through
 * shipped surfaces:
 *
 *   1. A normally-provisioned owner enables the digest from Settings (same
 *      UI control as above).
 *   2. The day's activity — a completed job — happens through the real,
 *      authenticated API (POST /api/customers, /api/locations, /api/jobs,
 *      /api/jobs/:id/transition) — no SQL, no fixture shortcut.
 *   3. The sweep runs the way the product's ops path runs it: this file
 *      imports `runDailyDigestSweep` — the SAME function app.ts's
 *      leader-locked `setInterval` invokes — and calls it directly against
 *      the real Postgres the API webServer is also pointed at (real Pg
 *      repos throughout, exactly as app.ts wires them; see
 *      test/integration/daily-digest-send-9-6.test.ts for the same pattern
 *      at the Vitest layer). This is a worker tick, not an admin route —
 *      there is no HTTP endpoint that fires the sweep early, and waiting out
 *      the real 15-minute interval in CI is not viable.
 *   4. The owner opens `/digest` in a real browser and sees the count from
 *      step 2 — while a neighbour tenant's OWN activity (a different job
 *      count) never appears on this tenant's page (T2).
 */
const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/close-9-6');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/** Tenant-local "HH:MM" for `instant` in `timezone` — used to set
 *  `digestTime` to "right now" so the sweep (run seconds later) finds it due
 *  without waiting out the real 15-minute production interval. */
function localHHMM(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.hour}:${m.minute}`;
}

/** Real Pg repos throughout — the same construction as
 *  test/integration/daily-digest-send-9-6.test.ts and app.ts's own wiring. */
function realComputeDeps(pool: Pool, settingsRepo: PgSettingsRepository): DigestComputeDeps {
  return {
    paymentRepo: new PgPaymentRepository(pool),
    invoiceRepo: new PgInvoiceRepository(pool),
    estimateRepo: new PgEstimateRepository(pool),
    jobRepo: new PgJobRepository(pool),
    appointmentRepo: new PgAppointmentRepository(pool),
    proposalRepo: new PgProposalRepository(pool),
    customerRepo: new PgCustomerRepository(pool),
    settingsRepo,
    feedbackResponseRepo: new PgFeedbackResponseRepository(pool),
    correctionLessonRepo: new PgCorrectionLessonRepository(pool),
    auditRepo: new PgAuditRepository(pool),
  };
}

interface BootstrappedOwner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

test.describe('digest reachability (9.6, rung 5) — real Postgres, hermetic browser', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to run the digest sweep).',
  );

  async function bootstrapOwner(request: APIRequestContext, label: string): Promise<BootstrappedOwner> {
    const sub = `user_e2e_digest_reach_${label}_${randomUUID().replace(/-/g, '')}`;
    const email = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
    const jwt = unsignedJwt(sub);
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    const svixId = `evt_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      type: 'user.created',
      data: { id: sub, email_addresses: [{ email_address: email }] },
    });
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
    const tenantId = me.tenant_id!;

    const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName: `Digest Reach ${label} HVAC`,
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    return { tenantId, sub, jwt, authHeaders };
  }

  /** Real activity through the real, authenticated API — `count` completed
   *  jobs so each tenant's digest carries an observably different number. */
  async function createCompletedJobs(
    request: APIRequestContext,
    owner: BootstrappedOwner,
    count: number,
  ): Promise<void> {
    const customerRes = await request.post(`${API_URL}/api/customers`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({ firstName: 'Digest', lastName: 'Reach', preferredChannel: 'phone' }),
    });
    expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
    const customer = (await customerRes.json()) as { id: string };

    const locationRes = await request.post(`${API_URL}/api/locations`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({
        customerId: customer.id,
        street1: '9 Digest Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      }),
    });
    expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
    const location = (await locationRes.json()) as { id: string };

    for (let i = 0; i < count; i++) {
      const jobRes = await request.post(`${API_URL}/api/jobs`, {
        headers: { 'content-type': 'application/json', ...owner.authHeaders },
        data: JSON.stringify({
          customerId: customer.id,
          locationId: location.id,
          summary: `Digest reach fixture job ${i + 1}`,
        }),
      });
      expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
      const job = (await jobRes.json()) as { id: string };

      // JOB_STATUS_TRANSITIONS (job-lifecycle.ts) only allows one hop at a
      // time: new -> scheduled -> in_progress -> completed.
      for (const status of ['scheduled', 'in_progress', 'completed']) {
        const transitionRes = await request.post(`${API_URL}/api/jobs/${job.id}/transition`, {
          headers: { 'content-type': 'application/json', ...owner.authHeaders },
          data: JSON.stringify({ status }),
        });
        expect(transitionRes.ok(), `transition job to ${status} -> ${transitionRes.status()} ${await transitionRes.text()}`).toBeTruthy();
      }
    }
  }

  test('an owner enables the digest, real activity happens, the sweep runs, and the digest content is reached on /digest — a neighbour tenant\'s activity never appears (T2)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Two tenants: the owner under test, and a neighbour whose OWN
    //    activity must never leak into the owner's digest. ─────────────────
    const owner = await bootstrapOwner(request, 'owner');
    const neighbour = await bootstrapOwner(request, 'neighbour');

    // ── Step 1: enable the digest from the shipped Settings UI ─────────────
    await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
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

    await page.goto('/settings');
    const toggle = page.locator(
      'xpath=//p[normalize-space(text())="Daily digest"]/ancestor::div[contains(@class,"justify-between")][1]//button',
    );
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings',
    );
    await toggle.click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/settings -> ${putRes.status()}`).toBeLessThan(300);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '01-digest-enabled.png') });

    // digestTime = right now (tenant-local), so the sweep run a few seconds
    // from now finds it due without waiting out the real 15-minute cadence.
    const nowForDueMatch = new Date();
    const digestTimeRes = await request.put(`${API_URL}/api/settings`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({
        digestTime: localHHMM(nowForDueMatch, 'America/Chicago'),
        digestChannel: 'sms',
        // sendDigestSms refuses to send with no owner_phone (stored-only,
        // by design) — a normally-provisioned owner has one on file.
        ownerPhone: '+15125550100',
      }),
    });
    expect(digestTimeRes.ok(), `PUT /api/settings (digestTime) -> ${digestTimeRes.status()}`).toBeTruthy();
    // Neighbour also opted in — its activity must still never surface here.
    const neighbourSettingsRes = await request.put(`${API_URL}/api/settings`, {
      headers: { 'content-type': 'application/json', ...neighbour.authHeaders },
      data: JSON.stringify({
        digestEnabled: true,
        digestChannel: 'sms',
        digestTime: localHHMM(nowForDueMatch, 'America/Chicago'),
        ownerPhone: '+15125550101',
      }),
    });
    expect(neighbourSettingsRes.ok()).toBeTruthy();

    // ── Step 2: the day's activity, through the real API ────────────────────
    // The owner: ONE completed job. The neighbour: TWO — a different number,
    // so the digest content itself (not just tenant scoping) is checkable.
    await createCompletedJobs(request, owner, 1);
    await createCompletedJobs(request, neighbour, 2);

    // ── Step 3: the sweep runs — the same function the ops path's
    //    leader-locked setInterval calls, invoked directly (a worker tick,
    //    not an admin route) against the SAME Postgres the API is on. ──────
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const settingsRepo = new PgSettingsRepository(pool);
      const digestRepo = new PgDailyDigestRepository(pool);
      const dispatchRepo = new PgDispatchRepository(pool);
      const sweepResult = await runDailyDigestSweep({
        settingsRepo,
        digestRepo,
        computeDeps: realComputeDeps(pool, settingsRepo),
        listTenantIds: async () => [owner.tenantId, neighbour.tenantId],
        delivery: new InMemoryDeliveryProvider(),
        dispatchRepo,
        publicBaseUrl: baseURL ?? 'http://localhost:5173',
        logger: createLogger({ service: 'e2e-digest-reach', environment: 'test', level: 'error' }),
      });
      expect(sweepResult.sent, `digest sweep sent count -> ${JSON.stringify(sweepResult)}`).toBe(2);

      // Poll rows mid-run — evidence, not the assertion itself (the browser
      // check below is). Read-only, mirrors e2e/journeys/public-invoice-pay-link.spec.ts.
      const ownerDigestRow = await digestRepo.findByTenantAndDate(
        owner.tenantId,
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(nowForDueMatch),
      );
      expect(ownerDigestRow).not.toBeNull();
      expect(ownerDigestRow!.payload.jobsCompletedCount).toBe(1);
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── Step 4: the owner reaches the digest CONTENT on the shipped surface ─
    await page.goto('/digest');
    await expect(page.getByText('Jobs completed', { exact: true })).toBeVisible({ timeout: 15_000 });
    // "Jobs completed" section: the owner's OWN count (1), never the
    // neighbour's (2) — T2, proven in the browser, not just at the DB.
    const jobsCompletedCard = page
      .locator('h2', { hasText: 'Jobs completed' })
      .locator('xpath=following-sibling::div[1]');
    await expect(jobsCompletedCard).toHaveText('1');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '02-digest-content-reached.png'), fullPage: true });

    expect(pageErrors, 'no uncaught page errors while viewing the digest').toEqual([]);
  });
});
