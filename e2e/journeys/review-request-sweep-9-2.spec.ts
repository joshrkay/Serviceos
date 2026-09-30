import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runReviewRequestSweep } from '../../packages/api/src/workers/review-request-worker';
import { PgQueue } from '../../packages/api/src/queues/pg-queue';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgFeedbackRequestRepository } from '../../packages/api/src/feedback/pg-feedback-request';
import { createLogger } from '../../packages/api/src/logging/logger';
import {
  API_URL,
  SKIP_REASON,
  bootstrapOwner,
  canRunAgainstRealPostgres,
  createCompletedJob,
  flipQuickSetting,
  pollFor,
  signInAs,
} from '../fixtures/close-8-9-lane';

/**
 * §8.9 row 9.2 — rung-5 REACHABILITY: "a review asked for automatically, so
 * my rating grows without me thinking about it".
 *
 * The integration proofs (review-request-sweep.test.ts,
 * review-request-sweep-reachability-9-2.test.ts) drive the sweep and a
 * hand-built feedback_send worker at real Postgres. What never ran is the
 * chain inside a RUNNING app:
 *
 *   1. Two real owners are provisioned (Clerk webhook + onboarding). The
 *      neighbour turns "Review request after every job" OFF in the real
 *      Settings screen; the owner leaves it at its shipped default (ON).
 *   2. Each completes a job through the real authenticated API.
 *   3. The review-request sweep runs as a worker tick — the SAME
 *      `runReviewRequestSweep` app.ts's leader-locked 10-minute interval
 *      calls, against the SAME Postgres, onto the SAME `PgQueue` — with its
 *      clock injected 25h ahead (the 24h delay; waiting it out is not
 *      viable). The sweep itself only enqueues `feedback_send`.
 *   4. The RUNNING API's own queue consumer picks that message up and runs
 *      the production `feedback_send` worker (its own dispatcher, its own
 *      consent gate) — the spec never calls it. The durable
 *      `feedback_requests` row it mints is polled for.
 *   5. The customer opens the link that SMS carries (`/feedback/<token>`) in
 *      a real browser and the review page is there, under the owner's own
 *      business name.
 *
 * Swept twice → still one request (the row's criterion). T3: the neighbour's
 * per-tenant switch is read in the same pass — its job is never enqueued.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('9.2 reachability — the review request, sent by the running app', () => {
  test.skip(!canRunAgainstRealPostgres(), SKIP_REASON);

  test('a completed job is swept, the running app sends the review request exactly once, and the customer reaches the review page from its link — a neighbour who switched it off gets nothing (T3)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'rr-owner', { businessName: 'Review Ask 9.2 Plumbing' });
    const neighbour = await bootstrapOwner(request, 'rr-neighbour', { businessName: 'Neighbour 9.2 Electric' });

    // ── The neighbour switches review requests OFF in the real Settings UI. ─
    await signInAs(page, neighbour, baseURL!);
    await flipQuickSetting(page, 'Review request after every job');
    const neighbourSettings = await request.get(`${API_URL}/api/settings`, { headers: neighbour.authHeaders });
    expect(((await neighbourSettings.json()) as { sendReviewRequest?: boolean }).sendReviewRequest).toBe(false);
    const ownerSettings = await request.get(`${API_URL}/api/settings`, { headers: owner.authHeaders });
    expect(((await ownerSettings.json()) as { sendReviewRequest?: boolean }).sendReviewRequest).toBe(true);

    const ownerJob = await createCompletedJob(request, owner, 'Rhea', '+15125550292');
    const neighbourJob = await createCompletedJob(request, neighbour, 'Nico', '+15125550293');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let token: string;
    try {
      const jobRepo = new PgJobRepository(pool);
      const queue = new PgQueue(pool);
      const feedbackRequestRepo = new PgFeedbackRequestRepository(pool);
      const sweepDeps = {
        pool,
        jobRepo,
        queue,
        logger: createLogger({ service: 'e2e-review-request-9-2', environment: 'test', level: 'error' }),
        now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
      };

      const first = await runReviewRequestSweep(sweepDeps);
      expect(first.failed).toBe(0);
      expect(first.enqueued, `first sweep -> ${JSON.stringify(first)}`).toBeGreaterThanOrEqual(1);

      // The RUNNING app's queue consumer runs feedback_send — poll its row.
      const sent = await pollFor(
        () => feedbackRequestRepo.findByJob(owner.tenantId, ownerJob.jobId),
        'the running app never minted the feedback request',
      );
      token = sent.token;
      expect(sent.tenantId).toBe(owner.tenantId);

      // Swept again → nothing new is enqueued for this job; still ONE request.
      const second = await runReviewRequestSweep(sweepDeps);
      expect(second.candidates, `second sweep -> ${JSON.stringify(second)}`).toBe(0);
      // Let the running app finish (ack) the consumed message, then count.
      await pollFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM _queue_messages WHERE idempotency_key = $1`,
          [`${owner.tenantId}:${ownerJob.jobId}:feedback_send`],
        );
        return rows[0].n === '0' ? true : null;
      }, 'the running app never finished the feedback_send message');
      const { rows: requests } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM feedback_requests WHERE tenant_id = $1 AND job_id = $2`,
        [owner.tenantId, ownerJob.jobId],
      );
      expect(requests[0].n).toBe('1');

      // T3 — the neighbour's switch was read in the same pass: its completed
      // job was never swept, never enqueued, never sent.
      expect(await feedbackRequestRepo.findByJob(neighbour.tenantId, neighbourJob.jobId)).toBeNull();
      const neighbourRow = await jobRepo.findById(neighbour.tenantId, neighbourJob.jobId);
      expect(neighbourRow?.reviewRequestSentAt ?? null).toBeNull();
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── The customer opens the link the review-request SMS carries. ────────
    const customerPage = await page.context().browser()!.newPage();
    try {
      await customerPage.goto(`${baseURL}/feedback/${token}`);
      await expect(customerPage.getByTestId('star-rating')).toBeVisible({ timeout: 15_000 });
      await expect(customerPage.getByText(/Review Ask 9\.2 Plumbing/)).toBeVisible();
      await expect(customerPage.getByText(/Neighbour 9\.2 Electric/)).toHaveCount(0);
      await customerPage.screenshot({ path: join(SCREENSHOT_DIR, '9-2-01-review-page-from-sms-link.png') });
    } finally {
      await customerPage.close();
    }

    expect(pageErrors, 'no uncaught page errors in the owner session').toEqual([]);
  });
});
