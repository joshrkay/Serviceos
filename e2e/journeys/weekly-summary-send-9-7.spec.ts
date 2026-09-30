import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runWeeklyFeedbackSweep } from '../../packages/api/src/workers/weekly-feedback-worker';
import { startOfWeekUTC } from '../../packages/api/src/workers/hfcr-weekly-send-worker';
import { buildWeeklyFeedbackSnapshot } from '../../packages/api/src/digest/weekly-feedback-builder';
import {
  isWeeklyFeedbackEnabledForTenant,
  resolveTenantBusinessName,
  resolveTenantOwnerEmail,
} from '../../packages/api/src/digest/weekly-feedback-config';
import { PgCorrectionRepository } from '../../packages/api/src/proposals/corrections/pg-correction';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { listAllTenantIds } from '../../packages/api/src/tenants/list-tenant-ids';
import { createLogger } from '../../packages/api/src/logging/logger';
import {
  SKIP_REASON,
  bootstrapOwner,
  canRunAgainstRealPostgres,
  createCompletedJob,
  editProposalAsOwner,
  flipQuickSetting,
  laborLine,
  seedAiDraftEstimate,
  signInAs,
} from '../fixtures/close-8-9-lane';

/**
 * §8.9 row 9.7 — rung-5: the Saturday summary email itself, captured
 * hermetically. "A weekly summary I can read Saturday morning, including how
 * often it repeated a mistake."
 *
 * Every prior proof stopped short of the send: the builder and the sweep's
 * ledger at real Postgres (weekly-feedback-builder.test.ts,
 * weekly-feedback-reachability-9-7.test.ts) and the owner's switch in a real
 * browser (weekly-feedback-toggle.spec.ts). This spec captures the actual
 * email the product composes for real owners:
 *
 *   1. Three owners are provisioned through the real Clerk webhook +
 *      onboarding (their `tenants.owner_email` is what the sweep mails).
 *   2. The week's corrections are the owners' OWN edits through the real edit
 *      route (`PUT /api/proposals/:id`, which is what writes the corrections
 *      table) on an AI draft, and the week's activity is a job completed
 *      through the real API. Owner A corrects the line items twice (the
 *      second is a repeat) and the notes once: 3 corrections, 1 repeat.
 *      Neighbour B corrects once. Owner C switches "Weekly summary email"
 *      OFF in the real Settings screen.
 *   3. The sweep runs as a worker tick — the same `runWeeklyFeedbackSweep`
 *      app.ts runs on boot and daily, with the SAME deps app.ts wires
 *      (PgAuditRepository ledger, `buildWeeklyFeedbackSnapshot` over
 *      `PgCorrectionRepository`, the production per-tenant resolvers, the
 *      production tenant enumerator) — on the Saturday after this week, with
 *      `sendEmail` bound to the in-memory provider the dev server itself uses.
 *
 * The captured bodies are asserted and written to the lane-report folder.
 */

const EVIDENCE_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(EVIDENCE_DIR, { recursive: true });

test.describe('9.7 — the Saturday summary email, captured', () => {
  test.skip(!canRunAgainstRealPostgres(), SKIP_REASON);

  test('each owner\'s own week — corrections, repeats and rate from their own edits — is emailed once; an owner who switched it off gets nothing (T3)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const ownerA = await bootstrapOwner(request, 'wk-a', { businessName: 'Weekly 9.7 Plumbing' });
    const ownerB = await bootstrapOwner(request, 'wk-b', { businessName: 'Weekly 9.7 Electric' });
    const ownerC = await bootstrapOwner(request, 'wk-c', { businessName: 'Weekly 9.7 Roofing' });

    // C turns the weekly email off in the real Settings screen.
    await signInAs(page, ownerC, baseURL!);
    await flipQuickSetting(page, 'Weekly summary email');

    const jobA = await createCompletedJob(request, ownerA, 'Wes', '+15125550971');
    const jobB = await createCompletedJob(request, ownerB, 'Wynn', '+15125550972');
    const jobC = await createCompletedJob(request, ownerC, 'Wade', '+15125550973');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const draftA = await seedAiDraftEstimate(pool, ownerA, jobA, 11500);
      const draftB = await seedAiDraftEstimate(pool, ownerB, jobB, 11500);
      const draftC = await seedAiDraftEstimate(pool, ownerC, jobC, 11500);

      // A: line items twice (the second is a repeat), notes once → 3 / 1.
      await editProposalAsOwner(request, ownerA, draftA, { lineItems: [laborLine(12500)] });
      await editProposalAsOwner(request, ownerA, draftA, { lineItems: [laborLine(13500)] });
      await editProposalAsOwner(request, ownerA, draftA, { notes: 'Bring the long ladder.' });
      // B: one correction. C: two (it must still get nothing).
      await editProposalAsOwner(request, ownerB, draftB, { lineItems: [laborLine(9900)] });
      await editProposalAsOwner(request, ownerC, draftC, { lineItems: [laborLine(9000)] });
      await editProposalAsOwner(request, ownerC, draftC, { lineItems: [laborLine(9100)] });

      const settingsRepo = new PgSettingsRepository(pool);
      const auditRepo = new PgAuditRepository(pool);
      const correctionRepo = new PgCorrectionRepository(pool);
      const delivery = new InMemoryDeliveryProvider();
      // The Saturday after this week: the sweep summarises the completed week
      // [this Monday, next Monday), which holds every edit above.
      const saturday = new Date(startOfWeekUTC(new Date()).getTime() + 12 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000);
      const deps = {
        auditRepo,
        buildSnapshot: (tenantId: string, weekStart: Date, weekEnd: Date) =>
          buildWeeklyFeedbackSnapshot(pool, tenantId, weekStart, weekEnd, correctionRepo),
        resolveOwnerEmail: (tenantId: string) => resolveTenantOwnerEmail(pool, tenantId),
        isFeedbackEnabled: (tenantId: string) => isWeeklyFeedbackEnabledForTenant(settingsRepo, tenantId),
        resolveBusinessName: (tenantId: string) => resolveTenantBusinessName(settingsRepo, tenantId),
        sendEmail: (args: { to: string; subject: string; text: string; html: string }) =>
          delivery.sendEmail({ to: args.to, subject: args.subject, text: args.text, html: args.html }),
        listTenantIds: () => listAllTenantIds(pool),
        logger: createLogger({ service: 'e2e-weekly-9-7', environment: 'test', level: 'error' }),
        now: () => saturday,
      };

      const first = await runWeeklyFeedbackSweep(deps);
      expect(first.failed, `sweep -> ${JSON.stringify(first)}`).toBe(0);

      const toA = delivery.sentEmails.filter((e) => e.to === ownerA.email);
      const toB = delivery.sentEmails.filter((e) => e.to === ownerB.email);
      const toC = delivery.sentEmails.filter((e) => e.to === ownerC.email);
      expect(toA, 'owner A gets exactly one weekly email').toHaveLength(1);
      expect(toB, 'owner B gets exactly one weekly email').toHaveLength(1);
      expect(toC, 'owner C switched it off').toEqual([]);

      expect(toA[0].text).toContain('Weekly 9.7 Plumbing');
      expect(toA[0].text).toContain('Jobs completed: 1');
      expect(toA[0].text).toContain('Of 3 corrections this week, 1 was a repeat of an earlier correction (33%).');
      expect(toA[0].text).not.toContain('Weekly 9.7 Electric');

      expect(toB[0].text).toContain('Weekly 9.7 Electric');
      expect(toB[0].text).toContain('Of 1 correction this week, 0 were repeats of an earlier correction (0%).');
      expect(toB[0].text).not.toContain('Weekly 9.7 Plumbing');

      writeFileSync(
        join(EVIDENCE_DIR, '9-7-captured-weekly-emails.txt'),
        [toA[0], toB[0]]
          .map((e, i) => `── ${i === 0 ? 'owner A' : 'neighbour B'} ──\nSubject: ${e.subject}\n\n${e.text}\n`)
          .join('\n'),
      );

      // The send ledger is idempotent: a second Saturday tick sends nothing.
      const before = delivery.sentEmails.length;
      await runWeeklyFeedbackSweep(deps);
      expect(delivery.sentEmails.length, 'a re-run sends no second email').toBe(before);
    } finally {
      await pool.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors in the Settings session').toEqual([]);
  });
});
