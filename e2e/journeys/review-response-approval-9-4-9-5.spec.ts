import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgReviewRepository } from '../../packages/api/src/reputation/pg-review';
import { PgServiceCreditRepository } from '../../packages/api/src/reputation/pg-service-credit';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { buildReviewResponseProposal } from '../../packages/api/src/reputation/build-proposal';
import { NEUTRAL_BRAND_VOICE } from '../../packages/api/src/reputation/brand-voice';
import { createProposal } from '../../packages/api/src/proposals/proposal';
import type { Review } from '../../packages/api/src/reputation/review';
import type { MatchedCustomer } from '../../packages/api/src/reputation/match-customer';
import type { LLMGateway } from '../../packages/api/src/ai/gateway/gateway';
import type { CustomerLoader } from '../../packages/api/src/reputation/match-customer';

/**
 * §8.9 rows 9.4 / 9.5 — rung-5 REACHABILITY for the review-response draft
 * awaiting approval, and the service-credit cap ("omitted, not zeroed").
 *
 * Both rows' remaining gap is the SAME one: the owner-facing browser leg.
 * 9.4's classification/matching/drafting is already proven at real Postgres
 * (test/integration/google-reviews-matching.test.ts, T1) and its sweep half
 * (finding NEW reviews) is blocked on a live Google Business Profile
 * connection (#1000, parked — not attempted here). 9.5's cap arithmetic is
 * already proven at real Postgres (test/integration/service-credit-cap-9-5.test.ts,
 * PROVEN-REAL-DB, T1). Neither test ever rendered the drafted proposal on the
 * REAL owner Inbox (`packages/web/src/components/inbox/ReviewResponseReview.tsx`)
 * or drove a REAL Approve click through it — this file does both, per the
 * §8.9 task note: "reach the surface and read back what exists". The
 * sweep-discovery gap (#1000) and the missing audit event on the sweep half
 * (a separate Opus lane's fix in flight) are NOT touched here.
 *
 * The review + its proposal are seeded via the SAME orchestrator function
 * (`buildReviewResponseProposal`) app.ts's real Google-reviews sweep calls,
 * with only the two LLM draft calls + classifier/matcher stubbed (the SAME
 * seam `service-credit-cap-9-5.test.ts` already stubs — a real model call is
 * out of scope per #1119). `PgServiceCreditRepository` is REAL throughout,
 * so the $80-already-issued cap that omits the credit is real Postgres
 * arithmetic, not a fixture.
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
const DOLLARS_50 = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BootstrappedOwner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<BootstrappedOwner> {
  const sub = `user_e2e_reviewresp_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-rr-${label}-${Date.now()}@serviceos-hermetic.test`;
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
      businessName: `Review Response 9.4/9.5 ${label} Co`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

async function signInAs(page: import('@playwright/test').Page, owner: BootstrappedOwner) {
  await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
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
}

test.describe('9.4/9.5 reachability — review-response draft on the real Inbox, credit cap omission on the real card', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to seed the review + proposal).',
  );

  test('owner reaches the review-response draft on the real Inbox, the capped credit never renders, approve executes for real, no credit row is created — a neighbour sees none of it (T2)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'owner');
    const neighbour = await bootstrapOwner(request, 'neighbour');

    // Real customer, through the real authenticated API — the matched
    // reviewer the private follow-up targets.
    const customerRes = await request.post(`${API_URL}/api/customers`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({ firstName: 'Review', lastName: 'Responder', email: 'review.responder@example.com', preferredChannel: 'email' }),
    });
    expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
    const customer = (await customerRes.json()) as { id: string };

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let proposalId: string;
    try {
      const reviewRepo = new PgReviewRepository(pool);
      const creditRepo = new PgServiceCreditRepository(pool);
      const proposalRepo = new PgProposalRepository(pool);

      // Prior $80 issued in the last 12 months — a $50 tier now overflows the
      // $100 cap (the SAME arithmetic service-credit-cap-9-5.test.ts pins).
      // The FK anchor proposal is a throwaway 'review_response_proposal' row.
      const anchor = await proposalRepo.create(
        createProposal({
          tenantId: owner.tenantId,
          proposalType: 'review_response_proposal',
          payload: { note: 'FK anchor for a prior credit' },
          summary: 'Prior credit anchor',
          createdBy: owner.sub,
        }),
      );
      // Terminal status so this throwaway FK-anchor row (service_credits.
      // proposal_id only needs it to EXIST) never appears in the owner's
      // real Inbox next to the actual review-response draft this spec is
      // about — GET /api/proposals/inbox lists 'draft' rows too.
      await proposalRepo.updateStatus(owner.tenantId, anchor.id, 'rejected');
      await creditRepo.create({
        tenantId: owner.tenantId,
        customerId: customer.id,
        amountCents: 8000,
        reviewId: null,
        proposalId: anchor.id,
        issuedAt: new Date(Date.now() - 30 * DAY_MS),
      });

      const now = new Date();
      const review: Review = {
        id: randomUUID(),
        tenantId: owner.tenantId,
        externalReviewId: `accounts/a/locations/l/reviews/${randomUUID()}`,
        locationId: 'accounts/a/locations/l',
        reviewerDisplayName: 'Review Responder',
        reviewerProfileUrl: null,
        rating: 2,
        commentText: 'The technician never showed up for the window I was given.',
        createTime: now,
        updateTime: null,
        firstFetchedAt: now,
        lastFetchedAt: now,
      };
      const { review: persistedReview } = await reviewRepo.upsert(review);

      const matched: MatchedCustomer = {
        customerId: customer.id,
        firstName: 'Review',
        lastName: 'Responder',
        lastVisitAt: new Date(Date.now() - 5 * DAY_MS),
        matchScore: 0.99,
      };
      const payload = await buildReviewResponseProposal(persistedReview, {
        // Real model call is out of scope (#1119) — only the two draft calls
        // + classifier/matcher are stubbed; the credit leg (the thing this
        // spec is actually proving) runs against the REAL repository above.
        llmGateway: {} as unknown as LLMGateway,
        customerLoader: {} as unknown as CustomerLoader,
        brandVoiceLoader: { load: async () => NEUTRAL_BRAND_VOICE },
        serviceCreditRepo: creditRepo,
        classifier: async () => ({ classification: 'specific_complaint', confidence: 0.95, source: 'llm' as const }),
        matcher: async () => matched,
        draftPublic: async () => 'We are sorry we missed your appointment window — this is not how we operate.',
        draftPrivate: async () => 'Please let us make this right; reply here and we will schedule you first.',
      });
      expect(payload.serviceCredit).toBeNull(); // the cap omission this row exists for

      const proposal = createProposal({
        tenantId: owner.tenantId,
        proposalType: 'review_response_proposal',
        payload: payload as unknown as Record<string, unknown>,
        summary: 'Respond to the 2-star review',
        createdBy: owner.sub,
      });
      await proposalRepo.create(proposal);
      await proposalRepo.updateStatus(owner.tenantId, proposal.id, 'ready_for_review');
      proposalId = proposal.id;
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── The neighbour's Inbox never sees tenant A's draft (T2, leg 1). ─────
    await blockExternalHosts(page, baseURL!);
    await signInAs(page, neighbour);
    await page.goto('/inbox');
    await page.waitForTimeout(1_500); // settle past initial pollers
    await expect(page.getByText(/never showed up for the window/i)).toHaveCount(0);

    // ── The owner reaches the draft on the REAL Inbox. ──────────────────────
    // Scoped to the inbox row carrying the review-response card: the seeded
    // FK-anchor proposal (a throwaway 'draft_estimate'-less row created only
    // to satisfy service_credits' FK to proposals(id)) also lands in
    // 'draft' status and the inbox lists drafts too, so an unscoped
    // getByRole('button', {name: 'Approve'}) resolves to more than one
    // element (strict-mode violation) — the anchor row has its own Approve
    // button. Scoping to the row containing review-response-review targets
    // the real draft this row is actually about.
    await signInAs(page, owner);
    await page.goto('/inbox');
    await expect(page.getByTestId('review-response-review')).toBeVisible({ timeout: 15_000 });
    const reviewRow = page.getByTestId('inbox-row').filter({ has: page.getByTestId('review-response-review') });
    await expect(page.getByTestId('review-public-draft')).toContainText('sorry we missed your appointment window');
    await expect(page.getByTestId('review-private-draft')).toContainText('let us make this right');
    // The capped credit never renders — no toggle, no dollar amount, no
    // "service credit" text anywhere on the card at all.
    await expect(page.getByText(/service credit/i)).toHaveCount(0);
    await expect(page.getByTestId('review-nothing-selected')).toHaveCount(0); // public+private preselected
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-4-9-5-01-draft-on-inbox.png'), fullPage: true });

    // Deselect "Post public reply" before approving: this hermetic
    // environment has no real Google Business connection for this tenant,
    // and ReviewResponseExecutionHandler.executePublicResponse (review-
    // response-handler.ts:263-268) correctly treats "resolver wired but no
    // per-tenant credential" as a hard sub-action failure (ok:false) — which
    // fails the WHOLE execution, not just that component (review-response-
    // handler.ts:228-235). That is a live-third-party leg out of scope here
    // (parked, like #1000) — deselecting is the real "mix-and-match" review
    // affordance the card exists for (per its own header comment), not a
    // workaround. The private follow-up (no messageDelivery wired in this
    // environment either) degrades gracefully to an ok:true skip
    // (review-response-handler.ts:299-303) and stays selected, so Approve
    // still executes for real.
    await reviewRow.getByRole('checkbox', { name: /post public reply/i }).uncheck();
    await expect(page.getByTestId('review-nothing-selected')).toHaveCount(0); // private still selected

    // ── Approve — real PUT (flip approved flags) then real POST approve. ───
    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/proposals/${proposalId}`,
    );
    const approvePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${proposalId}/approve`,
    );
    await reviewRow.getByRole('button', { name: /^approve$/i }).click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/proposals/${proposalId} -> ${putRes.status()}`).toBeLessThan(300);
    const approveRes = await approvePromise;
    expect(approveRes.status(), `POST approve -> ${approveRes.status()}`).toBeLessThan(300);
    await expect(page.getByTestId('inbox-row')).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-4-9-5-02-approved.png') });

    // ── Real execution: the app's own auto-delivery worker (1s cadence)
    //    picks it up past the 5s undo window — poll the real API. ──────────
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/proposals/${proposalId}`, { headers: owner.authHeaders });
          if (!res.ok()) return 'error';
          const body = (await res.json()) as { status?: string };
          return body.status;
        },
        { timeout: 30_000, message: 'proposal never reached executed' },
      )
      .toBe('executed');

    // ── Read back what actually happened, via the real API + a direct
    //    Postgres read for the ledger (no route lists all service credits
    //    for a customer). ─────────────────────────────────────────────────
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const auditRepo = new PgAuditRepository(pool2);
      const events = await auditRepo.findByEntity(owner.tenantId, 'proposal', proposalId);
      expect(events.map((e) => e.eventType)).toContain('review_response.executed');

      const { rows } = await pool2.query(
        `SELECT COUNT(*)::int AS n FROM service_credits WHERE tenant_id = $1 AND customer_id = $2 AND amount_cents = $3`,
        [owner.tenantId, customer.id, DOLLARS_50],
      );
      // The $50 tier was omitted at draft time — no NEW credit row landed.
      expect(rows[0].n).toBe(0);
    } finally {
      await pool2.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors across the 9.4/9.5 flow').toEqual([]);
  });
});
