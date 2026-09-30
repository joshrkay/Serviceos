import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgCorrectionLessonRepository } from '../../packages/api/src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { PgPaymentRepository } from '../../packages/api/src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../packages/api/src/estimates/pg-estimate';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgAppointmentRepository } from '../../packages/api/src/appointments/pg-appointment';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';
import { PgFeedbackResponseRepository } from '../../packages/api/src/feedback/pg-feedback-response';
import { PgDailyDigestRepository } from '../../packages/api/src/digest/pg-daily-digest';
import { PgDispatchRepository } from '../../packages/api/src/notifications/dispatch-repository';
import { runDailyDigestSweep } from '../../packages/api/src/workers/daily-digest-worker';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { createLogger } from '../../packages/api/src/logging/logger';
import {
  API_URL,
  SKIP_REASON,
  type Owner,
  bootstrapOwner,
  canRunAgainstRealPostgres,
  createCompletedJob,
  editProposalAsOwner,
  laborLine,
  pollFor,
  seedAiDraftEstimate,
  signInAs,
} from '../fixtures/close-8-9-lane';

/**
 * §8.9 rows 9.8 / 9.9 — rung-5 REACHABILITY for "a correction I make once
 * sticks" and "undo a lesson it learned wrong".
 *
 * `correction-loop-reachability-9-8-9-9.test.ts` drives the route FUNCTIONS
 * and a hand-built executor at real Postgres. This spec runs the loop inside
 * the RUNNING app:
 *
 *   1. The AI's draft estimate (labor $115/hr, the tenant's configured rate)
 *      is seeded — drafting needs a live model (#1119); it is the AI's output,
 *      not an owner action.
 *   2. The owner's correction goes through the real edit route
 *      (`PUT /api/proposals/:id`) — the product has NO web control that edits
 *      a drafted line's price (mobile deliberately withholds free-text price
 *      entry, proposalEdit.ts), so this one step is API-driven; see the PRD
 *      row. The owner APPROVES it by clicking Approve on the real /inbox.
 *   3. The running app's own execution worker executes it and its wired
 *      `onExecuted` records the lesson and cascades the labor rate — the spec
 *      polls, it never calls the executor.
 *   4. The digest sweep runs as a worker tick (the same `runDailyDigestSweep`
 *      app.ts's interval calls) and the owner reads the lesson under "What I
 *      learned today" on /digest (9.8: "it appears in the day's applied
 *      lessons").
 *   5. 9.9 — the owner taps Undo on that line. The prior rate comes back
 *      EXACTLY, `correction_lesson.reverted` is written exactly once, and a
 *      second undo is a no-op.
 *
 * T2: a neighbour tenant runs its own divergent correction ($99) in the same
 * run; its lesson and rate survive the owner's undo and never appear on the
 * owner's digest.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_RATE = 11500;
const OWNER_RATE = 13500;
const NEIGHBOUR_RATE = 9900;

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

test.describe('9.8 / 9.9 reachability — a correction that sticks, and its undo, in the running app', () => {
  test.skip(!canRunAgainstRealPostgres(), SKIP_REASON);

  test('the owner\'s approved labor-rate correction is learned by the running app, shows under "What I learned today", and Undo restores the prior rate exactly — a neighbour\'s own lesson is untouched (T2)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'cl-owner', { businessName: 'Lesson 9.8 Plumbing' });
    const neighbour = await bootstrapOwner(request, 'cl-neighbour', { businessName: 'Neighbour 9.8 HVAC' });
    const ownerJob = await createCompletedJob(request, owner, 'Lena', '+15125550981');
    const neighbourJob = await createCompletedJob(request, neighbour, 'Nate', '+15125550982');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const settingsRepo = new PgSettingsRepository(pool);
    const lessonRepo = new PgCorrectionLessonRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    try {
      // Tenant baseline: both labor rates $115/hr (no API writes this column
      // — the same `settingsRepo.update` the integration proof uses).
      await settingsRepo.update(owner.tenantId, { laborRateCentsPerHour: BASE_RATE });
      await settingsRepo.update(neighbour.tenantId, { laborRateCentsPerHour: BASE_RATE });

      const ownerProposalId = await seedAiDraftEstimate(pool, owner, ownerJob, BASE_RATE);
      const neighbourProposalId = await seedAiDraftEstimate(pool, neighbour, neighbourJob, BASE_RATE);

      // ── The owner's correction (edit route) + approval on the real /inbox.
      await editProposalAsOwner(request, owner, ownerProposalId, { lineItems: [laborLine(OWNER_RATE)] });
      await signInAs(page, owner, baseURL!);
      await page.goto('/inbox', { timeout: 45_000 });
      const crashed = page.getByText('Something went wrong');
      if (await crashed.isVisible({ timeout: 3_000 }).catch(() => false)) await page.reload();
      await expect(page.getByTestId('inbox-row')).toHaveCount(1, { timeout: 30_000 });
      const approvePromise = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${ownerProposalId}/approve`,
      );
      await page.getByRole('button', { name: /^approve$/i }).click();
      expect((await approvePromise).status()).toBeLessThan(300);

      // The neighbour corrects + approves its own draft through the API.
      await editProposalAsOwner(request, neighbour, neighbourProposalId, { lineItems: [laborLine(NEIGHBOUR_RATE)] });
      const nApprove = await request.post(`${API_URL}/api/proposals/${neighbourProposalId}/approve`, {
        headers: neighbour.authHeaders,
      });
      expect(nApprove.ok(), `neighbour approve -> ${nApprove.status()}`).toBeTruthy();

      // ── The RUNNING app executes both and records each tenant's lesson.
      const ownerLesson = await pollFor(
        async () => (await lessonRepo.findBySourceProposal(owner.tenantId, ownerProposalId))[0],
        'the running app never recorded the owner\'s lesson',
        60_000,
      );
      const neighbourLesson = await pollFor(
        async () => (await lessonRepo.findBySourceProposal(neighbour.tenantId, neighbourProposalId))[0],
        'the running app never recorded the neighbour\'s lesson',
        60_000,
      );
      expect(ownerLesson.lessonType).toBe('labor_rate_changed');
      expect(ownerLesson.payload).toEqual({ kind: 'labor_rate_changed', beforeCents: BASE_RATE, afterCents: OWNER_RATE });
      expect((await settingsRepo.findByTenant(owner.tenantId))!.laborRateCentsPerHour).toBe(OWNER_RATE);
      expect((await settingsRepo.findByTenant(neighbour.tenantId))!.laborRateCentsPerHour).toBe(NEIGHBOUR_RATE);
      expect(
        (await auditRepo.findByEntity(owner.tenantId, 'correction_lesson', ownerLesson.id)).map((e) => e.eventType),
      ).toContain('correction_lesson.applied');

      // ── The digest tick, so the owner can read the day's lessons.
      const now = new Date();
      for (const t of [owner, neighbour] as Owner[]) {
        const res = await request.put(`${API_URL}/api/settings`, {
          headers: { 'content-type': 'application/json', ...t.authHeaders },
          data: JSON.stringify({
            digestEnabled: true,
            digestChannel: 'sms',
            digestTime: localHHMM(now, 'America/Chicago'),
            ownerPhone: t === owner ? '+15125550983' : '+15125550984',
          }),
        });
        expect(res.ok(), `digest settings -> ${res.status()}`).toBeTruthy();
      }
      const sweep = await runDailyDigestSweep({
        settingsRepo,
        digestRepo: new PgDailyDigestRepository(pool),
        computeDeps: {
          paymentRepo: new PgPaymentRepository(pool),
          invoiceRepo: new PgInvoiceRepository(pool),
          estimateRepo: new PgEstimateRepository(pool),
          jobRepo: new PgJobRepository(pool),
          appointmentRepo: new PgAppointmentRepository(pool),
          proposalRepo: new PgProposalRepository(pool),
          customerRepo: new PgCustomerRepository(pool),
          settingsRepo,
          feedbackResponseRepo: new PgFeedbackResponseRepository(pool),
          correctionLessonRepo: lessonRepo,
          auditRepo,
        },
        listTenantIds: async () => [owner.tenantId, neighbour.tenantId],
        delivery: new InMemoryDeliveryProvider(),
        dispatchRepo: new PgDispatchRepository(pool),
        publicBaseUrl: baseURL!,
        logger: createLogger({ service: 'e2e-lesson-9-8', environment: 'test', level: 'error' }),
      });
      expect(sweep.sent, `digest sweep -> ${JSON.stringify(sweep)}`).toBe(2);

      // ── 9.8: the lesson is on the owner's digest; the neighbour's is not.
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto('/digest', { timeout: 45_000 });
      await expect(page.getByText('What I learned today')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Labor rate updated to \$135/)).toBeVisible();
      await expect(page.getByText(/Labor rate updated to \$99/)).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'no horizontal overflow at 320px').toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SCREENSHOT_DIR, '9-8-01-lesson-on-digest-320.png'), fullPage: true });

      // ── 9.9: the owner taps Undo on that line.
      const undoPromise = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${ownerProposalId}/undo`,
      );
      await page.getByRole('button', { name: /^Undo: Labor rate updated to \$135/ }).click();
      expect((await undoPromise).status()).toBe(200);
      await expect(page.getByText('Undone')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Undo:/ })).toHaveCount(0);
      await page.screenshot({ path: join(SCREENSHOT_DIR, '9-9-01-lesson-undone-320.png'), fullPage: true });

      // The prior value is restored EXACTLY; the lesson is reverted; one audit row.
      expect((await settingsRepo.findByTenant(owner.tenantId))!.laborRateCentsPerHour).toBe(BASE_RATE);
      expect((await lessonRepo.findById(owner.tenantId, ownerLesson.id))!.status).toBe('reverted');
      const reverted = async () =>
        (await auditRepo.findByEntity(owner.tenantId, 'correction_lesson', ownerLesson.id)).filter(
          (e) => e.eventType === 'correction_lesson.reverted',
        );
      expect(await reverted()).toHaveLength(1);
      // It drops from the day's applied lessons.
      const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
      expect((await lessonRepo.findAppliedForDay(owner.tenantId, localDay)).map((l) => l.id)).not.toContain(
        ownerLesson.id,
      );

      // A second undo is a no-op: same rate, still exactly one reverted row.
      const again = await request.post(`${API_URL}/api/proposals/${ownerProposalId}/undo`, {
        headers: { 'content-type': 'application/json', ...owner.authHeaders },
        data: JSON.stringify({ scope: 'lessons' }),
      });
      expect(again.status()).toBe(200);
      expect((await settingsRepo.findByTenant(owner.tenantId))!.laborRateCentsPerHour).toBe(BASE_RATE);
      expect(await reverted()).toHaveLength(1);

      // T2 — the neighbour's lesson and rate are untouched, and the owner
      // cannot undo the neighbour's proposal.
      expect((await lessonRepo.findById(neighbour.tenantId, neighbourLesson.id))!.status).toBe('applied');
      expect((await settingsRepo.findByTenant(neighbour.tenantId))!.laborRateCentsPerHour).toBe(NEIGHBOUR_RATE);
      const cross = await request.post(`${API_URL}/api/proposals/${neighbourProposalId}/undo`, {
        headers: { 'content-type': 'application/json', ...owner.authHeaders },
        data: JSON.stringify({ scope: 'lessons' }),
      });
      expect(cross.status()).toBe(404);
      expect((await lessonRepo.findById(neighbour.tenantId, neighbourLesson.id))!.status).toBe('applied');
    } finally {
      await pool.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors across the 9.8/9.9 flow').toEqual([]);
  });
});
