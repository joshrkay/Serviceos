import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { PgFeedbackRequestRepository } from '../../packages/api/src/feedback/pg-feedback-request';
import { createFeedbackRequest } from '../../packages/api/src/feedback/feedback-request';

/**
 * 9.3 — rung-5 REACHABILITY for the review-gating rating split.
 *
 * `test/integration/feedback-review-gating.test.ts` already proves the
 * rating>=4 gate against real Postgres, but through a hand-built express app
 * driven by supertest — never a real browser rendering the SHIPPED customer
 * page (`/feedback/:token`, packages/web/src/components/customer/
 * FeedbackPage.tsx) or the owner's REAL private view
 * (`/settings/feedback`, FeedbackDashboard.tsx, the "routed to me privately"
 * half of the story that DOES exist in code — see that file's header for
 * what does NOT: no push/SMS/email to the owner, pinned there as it.fails
 * and tracked as #1071, not re-pinned here).
 *
 * This spec drives the REAL customer-facing page for a 3★ (unhappy) and a
 * 5★ (happy) response, and the REAL owner dashboard, with a second tenant
 * (T2) whose own review-URL config never leaks.
 *
 * The `feedback_requests` row itself is seeded via the SAME repository +
 * domain constructor (`createFeedbackRequest` / `PgFeedbackRequestRepository`)
 * the real 24h review-request sweep (row 9.2) uses to mint one — no route
 * exists to mint one directly, and no live LLM/third-party is needed here,
 * so this is the accepted seed point (mirrors `feedback-review-gating.test.ts`).
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';
const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface BootstrappedOwner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<BootstrappedOwner> {
  const sub = `user_e2e_feedback93_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-93-${label}-${Date.now()}@serviceos-hermetic.test`;
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
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Feedback 9.3 ${label} Co`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

async function createJob(request: APIRequestContext, owner: BootstrappedOwner): Promise<string> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...owner.authHeaders },
    data: JSON.stringify({ firstName: 'Rating', lastName: 'Gate', preferredChannel: 'sms' }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...owner.authHeaders },
    data: JSON.stringify({ customerId: customer.id, street1: '1 Gate Rd', city: 'Austin', state: 'TX', postalCode: '78701' }),
  });
  expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...owner.authHeaders },
    data: JSON.stringify({ customerId: customer.id, locationId: location.id, summary: '9.3 fixture job' }),
  });
  expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };
  return job.id;
}

test.describe('9.3 reachability — public feedback rating gate + owner private view (T2)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to mint feedback_requests).',
  );

  test('3★ gets no review links (public page); 5★ gets the configured links; a neighbour with no URLs gets none on a 5★ (T2); the owner sees both of THEIR OWN responses privately, never the neighbour\'s', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'owner');
    const neighbour = await bootstrapOwner(request, 'neighbour');

    const settingsRes = await request.put(`${API_URL}/api/settings`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({
        googleReviewUrl: 'https://g.page/r/feedback-93-owner',
        yelpReviewUrl: 'https://www.yelp.com/biz/feedback-93-owner',
      }),
    });
    expect(settingsRes.ok(), `PUT /api/settings (owner review URLs) -> ${settingsRes.status()}`).toBeTruthy();
    // Neighbour deliberately configures NO review URLs.

    const jobUnhappy = await createJob(request, owner);
    const jobHappy = await createJob(request, owner);
    const jobNeighbour = await createJob(request, neighbour);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let tokenUnhappy: string;
    let tokenHappy: string;
    let tokenNeighbour: string;
    try {
      const requestRepo = new PgFeedbackRequestRepository(pool);
      const reqUnhappy = await requestRepo.create(createFeedbackRequest({ tenantId: owner.tenantId, jobId: jobUnhappy }));
      const reqHappy = await requestRepo.create(createFeedbackRequest({ tenantId: owner.tenantId, jobId: jobHappy }));
      const reqNeighbour = await requestRepo.create(
        createFeedbackRequest({ tenantId: neighbour.tenantId, jobId: jobNeighbour }),
      );
      tokenUnhappy = reqUnhappy.token;
      tokenHappy = reqHappy.token;
      tokenNeighbour = reqNeighbour.token;
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── Unauthenticated customer browser — no Clerk stub needed for a
    //    public route, but block external hosts for hermeticity. ──────────
    await blockExternalHosts(page, baseURL!);

    // 3★: no review buttons.
    await page.goto(`/feedback/${tokenUnhappy}`);
    await expect(page.getByTestId('star-rating')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '3 stars' }).click();
    await page.getByPlaceholder(/tell us about your experience/i).fill('Not thrilled with the wait.');
    await page.getByRole('button', { name: /submit feedback/i }).click();
    await expect(page.getByText('Thank you!')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /leave a google review/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /leave a yelp review/i })).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-3-01-three-star-no-links.png') });

    // 5★: the owner's configured links appear.
    await page.goto(`/feedback/${tokenHappy}`);
    await expect(page.getByTestId('star-rating')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '5 stars' }).click();
    await page.getByPlaceholder(/tell us about your experience/i).fill('Fantastic work, on time.');
    await page.getByRole('button', { name: /submit feedback/i }).click();
    await expect(page.getByText('Thank you!')).toBeVisible({ timeout: 15_000 });
    const googleLink = page.getByRole('link', { name: /leave a google review/i });
    await expect(googleLink).toBeVisible();
    await expect(googleLink).toHaveAttribute('href', 'https://g.page/r/feedback-93-owner');
    const yelpLink = page.getByRole('link', { name: /leave a yelp review/i });
    await expect(yelpLink).toBeVisible();
    await expect(yelpLink).toHaveAttribute('href', 'https://www.yelp.com/biz/feedback-93-owner');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-3-02-five-star-links.png') });

    // T2: neighbour tenant, 5★, but NO review URLs configured — no links,
    // and definitely never the owner's.
    await page.goto(`/feedback/${tokenNeighbour}`);
    await expect(page.getByTestId('star-rating')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '5 stars' }).click();
    await page.getByRole('button', { name: /submit feedback/i }).click();
    await expect(page.getByText('Thank you!')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /leave a google review/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /leave a yelp review/i })).toHaveCount(0);

    // ── The owner's PRIVATE view: /settings/feedback shows both of their
    //    own responses (including the 3★ that got no public link), and
    //    never the neighbour's (T2, second leg). ──────────────────────────
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
    await page.goto('/settings/feedback');
    await expect(page.getByTestId('average-rating')).toBeVisible({ timeout: 15_000 });
    // (3 + 5) / 2 = 4.0 — both of the owner's own responses, nothing else.
    await expect(page.getByTestId('average-rating')).toHaveText('4.0');
    await expect(page.getByText('Not thrilled with the wait.')).toBeVisible();
    await expect(page.getByText('Fantastic work, on time.')).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-3-03-owner-private-view.png'), fullPage: true });

    expect(pageErrors, 'no uncaught page errors across the 9.3 flow').toEqual([]);
  });
});
