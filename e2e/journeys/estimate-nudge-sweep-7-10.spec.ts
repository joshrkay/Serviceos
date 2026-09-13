import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { bootstrapOwner, seedJob, queryAsTenant } from '../fixtures/estimate-quote-lane';
import { PgEstimateRepository } from '../../packages/api/src/estimates/pg-estimate';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { PgDispatchRepository } from '../../packages/api/src/notifications/dispatch-repository';
import { SendService } from '../../packages/api/src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { runEstimateReminderSweep } from '../../packages/api/src/workers/estimate-reminder-worker';
import { createLogger } from '../../packages/api/src/logging/logger';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * §8.7 row 7.10 — rung-5 reachability: "unviewed quotes chased
 * automatically." The production sweep entrypoint
 * (`runEstimateReminderSweep`, `packages/api/src/workers/estimate-reminder-worker.ts`)
 * is REGISTERED in the real API boot path — `app.ts:6448-6465` — as
 * `setInterval(..., 60 * 60_000)`, gated on `shouldRunWorkers &&
 * sendService`. This spec imports and calls that SAME, unmodified
 * production function directly against the live Postgres the API
 * webServer is also using (not a reimplementation, not a mock of the
 * dispatch/audit/cooldown logic) — the only way to exercise an
 * hourly-scheduled worker inside a bounded Playwright run without either
 * waiting a real hour or adding a test-trigger hook to `app.ts`, both out
 * of scope for a test-only lane (`playwright.config.ts` may gain a
 * project/env, never product wiring). `now` is the function's OWN
 * documented dependency-injection seam (`EstimateReminderWorkerDeps.now`,
 * used the same way by `test/integration/estimate-nudge.test.ts`) — not a
 * SQL fake of a state the product should produce.
 *
 * `InMemoryDeliveryProvider` is not a test double invented here — it is
 * the literal class `notifications/delivery-provider.ts` says is the
 * "Default in dev and tests so the app boots without provider
 * credentials," which is exactly this lane's environment (no TWILIO_*
 * set, per the shared preamble). The already-passing `sendEstimate` calls
 * elsewhere in this lane prove the SAME provider class is what the live
 * webServer itself is using.
 *
 * PINNED, NOT PROVEN: the real wall-clock-triggered, browser-observable
 * automatic firing of the `setInterval` itself — see the dedicated
 * `test.fail()` below.
 */

async function buildSweepDeps(pool: Pool, tenantIds: string[]) {
  const delivery = new InMemoryDeliveryProvider();
  const estimateRepo = new PgEstimateRepository(pool);
  const auditRepo = new PgAuditRepository(pool);
  const sendService = new SendService({
    delivery,
    estimateRepo,
    invoiceRepo: new PgInvoiceRepository(pool),
    jobRepo: new PgJobRepository(pool),
    customerRepo: new PgCustomerRepository(pool),
    settingsRepo: new PgSettingsRepository(pool),
    dispatchRepo: new PgDispatchRepository(pool),
    publicBaseUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
  });
  return {
    estimateRepo,
    sendService,
    pool,
    listTenantIds: async () => tenantIds,
    logger: createLogger({ service: 'estimate-reminder-worker-e2e', environment: 'test' }),
    auditRepo,
    delivery,
  };
}

test.describe('estimate-reminder sweep chases unviewed quotes automatically (7.10) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres (DATABASE_URL set, same as the ' +
      'webServer env) so this spec can drive the REAL production sweep function against the SAME DB.',
  );

  test('the real sweep nudges exactly one eligible estimate per tenant, records the audit + reminder bookkeeping, two concurrent sweep calls do not double-send, and a second (untouched) tenant proves T4 fanout', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      // ── Tenant A: one estimate sent "4 days ago" (past the 3-day
      //    reminderAfterDays default) via the real owner API ───────────────
      const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.10');
      const jobA = await seedJob(request, tenantA, 'NudgeMe');
      const estRes = await request.post(`${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates`, {
        headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
        data: JSON.stringify({
          jobId: jobA.jobId,
          lineItems: [{
            id: randomUUID(), description: 'Silent pipeline repair', quantity: 1,
            unitPriceCents: 8_000, totalCents: 8_000, sortOrder: 0, taxable: false,
          }],
        }),
      });
      expect(estRes.ok()).toBeTruthy();
      const estimate = (await estRes.json()) as { id: string };
      const sendRes = await request.post(
        `${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates/${estimate.id}/send`,
        {
          headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
          data: JSON.stringify({ channel: 'email' }),
        },
      );
      expect(sendRes.ok()).toBeTruthy();

      // ── Tenant B (T4): a FRESH estimate sent "just now" — outside the
      //    reminder window, so the SAME sweep call must skip it entirely ───
      const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.10');
      const jobB = await seedJob(request, tenantB, 'TooSoon');
      const estResB = await request.post(`${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates`, {
        headers: { 'content-type': 'application/json', ...tenantB.authHeaders },
        data: JSON.stringify({
          jobId: jobB.jobId,
          lineItems: [{
            id: randomUUID(), description: 'Fresh quote', quantity: 1,
            unitPriceCents: 5_000, totalCents: 5_000, sortOrder: 0, taxable: false,
          }],
        }),
      });
      const estimateB = (await estResB.json()) as { id: string };
      await request.post(
        `${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates/${estimateB.id}/send`,
        {
          headers: { 'content-type': 'application/json', ...tenantB.authHeaders },
          data: JSON.stringify({ channel: 'email' }),
        },
      );

      // ── Run the REAL production sweep once, "now" = +4 days, across BOTH
      //    tenants in one pass (T4 fanout: A is eligible, B is not) ─────────
      const fourDaysLater = () => new Date(Date.now() + 4 * DAY_MS);
      const deps = await buildSweepDeps(pool, [tenantA.tenantId, tenantB.tenantId]);
      const result = await runEstimateReminderSweep({ ...deps, now: fourDaysLater });
      expect(result.tenants).toBe(2);
      expect(result.reminders).toBe(1); // only tenant A's estimate qualifies
      expect(result.failed).toBe(0);
      expect(deps.delivery.sentSms.length + deps.delivery.sentEmails.length).toBe(1);

      // ── Durable proof: reminder_count / last_reminder_at on the row, and
      //    the estimate.reminder_sent audit event, at real Postgres ─────────
      const rowA = await queryAsTenant(
        tenantA.tenantId,
        `SELECT reminder_count, last_reminder_at FROM estimates WHERE id = $1`,
        [estimate.id],
      );
      expect(Number(rowA[0]!.reminder_count)).toBe(1);
      expect(rowA[0]!.last_reminder_at).toBeTruthy();

      const auditA = await queryAsTenant(
        tenantA.tenantId,
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'estimate.reminder_sent'`,
        [tenantA.tenantId, estimate.id],
      );
      expect(auditA).toHaveLength(1);

      // Tenant B's fresh estimate is untouched — T4: the sweep reached BOTH
      // tenants in the fan-out but only nudged the one that qualified.
      const rowB = await queryAsTenant(
        tenantB.tenantId,
        `SELECT reminder_count FROM estimates WHERE id = $1`,
        [estimateB.id],
      );
      expect(Number(rowB[0]!.reminder_count ?? 0)).toBe(0);

      // ── Concurrent nudges: two sweep calls racing the SAME estimate must
      //    settle to exactly one send, cadence advancing once (mirrors
      //    test/integration/estimate-nudge.test.ts's "two concurrent
      //    dispatchEstimateNudge calls" proof one layer up, through the
      //    REAL sweep entrypoint instead of the bare dispatch function) ────
      const jobC = await seedJob(request, tenantA, 'RaceNudge');
      const estResC = await request.post(`${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates`, {
        headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
        data: JSON.stringify({
          jobId: jobC.jobId,
          lineItems: [{
            id: randomUUID(), description: 'Racing nudge target', quantity: 1,
            unitPriceCents: 4_000, totalCents: 4_000, sortOrder: 0, taxable: false,
          }],
        }),
      });
      const estimateC = (await estResC.json()) as { id: string };
      await request.post(
        `${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/estimates/${estimateC.id}/send`,
        {
          headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
          data: JSON.stringify({ channel: 'email' }),
        },
      );

      const raceDeps = await buildSweepDeps(pool, [tenantA.tenantId]);
      const [r1, r2] = await Promise.all([
        runEstimateReminderSweep({ ...raceDeps, now: fourDaysLater }),
        runEstimateReminderSweep({ ...raceDeps, now: fourDaysLater }),
      ]);
      // Exactly one of the two concurrent sweeps actually sent it (the
      // claim-before-send gate reclaims/reconciles the other) — never two.
      expect(r1.reminders + r2.reminders).toBe(1);
      const rowC = await queryAsTenant(
        tenantA.tenantId,
        `SELECT reminder_count FROM estimates WHERE id = $1`,
        [estimateC.id],
      );
      expect(Number(rowC[0]!.reminder_count)).toBe(1);
      const sendCountC = raceDeps.delivery.sentSms.length + raceDeps.delivery.sentEmails.length;
      expect(sendCountC, 'two concurrent sweeps must produce exactly one send for the racing estimate').toBe(1);
    } finally {
      await pool.end();
    }
  });

  // ── Honest gap: the real, wall-clock-triggered automatic firing ───────────
  test('the real setInterval-driven automatic trigger cannot be observed inside a bounded hermetic run — pinned, not faked', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    test.fail(
      true,
      'packages/api/src/app.ts:6448-6465: registerInterval(setInterval(() => ' +
        'runAsLeader(SWEEP_LOCK.estimateReminder, () => runEstimateReminderSweep(...)), ' +
        '60 * 60_000)) — the sweep only fires once per real hour of wall-clock time. This ' +
        'test-only lane may add a Playwright project/env but never a product-code test-trigger ' +
        'hook or a shortened interval, so the literal browser-observable "an estimate sent 3+ ' +
        'days ago gets chased with zero manual action, purely from the API process running" ' +
        'cannot be driven inside a bounded run. What IS proven above: the exact production sweep ' +
        'function, registered at that line, run against real Postgres with real owner-created ' +
        'data, the real cooldown/claim-before-send mechanics, and T4 fan-out.',
    );

    // The observation expected to keep failing: the running API exposes NO
    // on-demand trigger for this sweep (only the hourly timer). An owner
    // asking the real server to run it now gets a 404 — there is nothing
    // on the persona's surface, or any surface, that can fire it early.
    const tenant = await bootstrapOwner(request, 'pin', 'Acme HVAC 7.10 Pin');
    const probe = await request.post(
      `${process.env.E2E_API_URL ?? 'http://localhost:3000'}/api/workers/estimate-reminder/run`,
      { headers: tenant.authHeaders },
    );
    expect(probe.status(), 'no on-demand estimate-reminder trigger exists (404) — only app.ts:6455\'s hourly setInterval').not.toBe(404);
  });
});
