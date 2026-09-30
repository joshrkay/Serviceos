import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runThankYouSmsSweep } from '../../packages/api/src/workers/thank-you-sms-worker';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgDncRepository } from '../../packages/api/src/compliance/dnc';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { PgConsentEventRepository } from '../../packages/api/src/compliance/consent-events';
import { GatedMessageDelivery } from '../../packages/api/src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { MessageDeliveryFeedbackDispatcher } from '../../packages/api/src/feedback/dispatcher';
import { createLogger } from '../../packages/api/src/logging/logger';
import {
  API_URL,
  SKIP_REASON,
  bootstrapOwner,
  canRunAgainstRealPostgres,
  createCompletedJob,
  flipQuickSetting,
  signInAs,
} from '../fixtures/close-8-9-lane';

/**
 * §8.9 row 9.1 — rung-5 REACHABILITY: "a customer thanked 2h after the job,
 * so the last thing they remember is courtesy".
 *
 * The write + audit are proven at real Postgres
 * (thank-you-sms-worker.test.ts, thank-you-sms-reachability-9-1.test.ts),
 * but always over tenants/jobs/customers INSERTed by SQL. This spec starts
 * from real owners instead:
 *
 *   1. Two owners are provisioned through the real Clerk webhook +
 *      onboarding. The neighbour switches "Thank-you text after every job"
 *      OFF in the real Settings screen; the owner keeps the shipped default.
 *   2. Each completes a job for a texting-consented customer through the
 *      real authenticated API.
 *   3. The sweep runs as a worker tick: the SAME `runThankYouSmsSweep`
 *      app.ts's leader-locked 10-minute interval calls, against the SAME
 *      Postgres the API is on, with the dispatcher composed exactly as app.ts
 *      composes `feedbackDispatcher` (MessageDeliveryFeedbackDispatcher over
 *      the central consent gate in `block` mode, with the consent ledger,
 *      over the in-memory provider the dev server itself constructs). Two
 *      ticks fire CONCURRENTLY, clock injected 3h ahead (the 2h delay).
 *
 * Asserted: exactly one SMS to the owner's customer, carrying the owner's
 * own business name; exactly one `notification.thank_you_sms.sent` audit
 * row; a third tick (restart) sends nothing. T3: the neighbour's switch is
 * read in the same pass — its customer is never texted.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('9.1 reachability — the thank-you text after a real owner completes a job', () => {
  test.skip(!canRunAgainstRealPostgres(), SKIP_REASON);

  test('two concurrent sweep ticks send ONE thank-you and write ONE audit row for the owner\'s completed job; a neighbour who switched it off is never texted (T3)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'ty-owner', { businessName: 'Thank You 9.1 HVAC' });
    const neighbour = await bootstrapOwner(request, 'ty-neighbour', { businessName: 'Neighbour 9.1 Roofing' });

    await signInAs(page, neighbour, baseURL!);
    await flipQuickSetting(page, 'Thank-you text after every job');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-1-01-neighbour-switched-thank-you-off.png'), fullPage: true });
    const neighbourSettings = await request.get(`${API_URL}/api/settings`, { headers: neighbour.authHeaders });
    expect(((await neighbourSettings.json()) as { sendThankYouSms?: boolean }).sendThankYouSms).toBe(false);
    const ownerSettings = await request.get(`${API_URL}/api/settings`, { headers: owner.authHeaders });
    expect(((await ownerSettings.json()) as { sendThankYouSms?: boolean }).sendThankYouSms).toBe(true);

    const ownerJob = await createCompletedJob(request, owner, 'Tess', '+15125550191');
    const neighbourJob = await createCompletedJob(request, neighbour, 'Ned', '+15125550192');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const auditRepo = new PgAuditRepository(pool);
      const dncRepo = new PgDncRepository(pool);
      const base = new InMemoryDeliveryProvider();
      const dispatcher = new MessageDeliveryFeedbackDispatcher(
        new GatedMessageDelivery({
          base,
          dnc: dncRepo,
          auditRepo,
          enforcement: 'block',
          consentLedger: new PgConsentEventRepository(pool),
          // The SMS kill switch is checked before consent; pin it ON so an
          // inherited TELEPHONY_ENABLED=false cannot turn this into a silent
          // `channel_disabled` pass.
          env: { ...process.env, TELEPHONY_ENABLED: 'true' },
        }),
      );
      const deps = {
        pool,
        jobRepo: new PgJobRepository(pool),
        customerRepo: new PgCustomerRepository(pool),
        settingsRepo: new PgSettingsRepository(pool),
        dncRepo,
        dispatcher,
        auditRepo,
        logger: createLogger({ service: 'e2e-thank-you-9-1', environment: 'test', level: 'error' }),
        now: () => new Date(Date.now() + 3 * 60 * 60 * 1000),
      };

      const [a, b] = await Promise.all([runThankYouSmsSweep(deps), runThankYouSmsSweep(deps)]);
      expect(a.failed + b.failed, `ticks -> ${JSON.stringify([a, b])}`).toBe(0);

      const toOwnerCustomer = base.sentSms.filter((m) => m.to === ownerJob.phone);
      expect(toOwnerCustomer, 'exactly one thank-you to the owner\'s customer').toHaveLength(1);
      expect(toOwnerCustomer[0].tenantId).toBe(owner.tenantId);
      expect(toOwnerCustomer[0].body).toContain('Thank You 9.1 HVAC');
      expect(toOwnerCustomer[0].body).not.toContain('Neighbour 9.1 Roofing');

      const sentAudits = (await auditRepo.findByEntity(owner.tenantId, 'job', ownerJob.jobId)).filter(
        (e) => e.eventType === 'notification.thank_you_sms.sent',
      );
      expect(sentAudits, 'exactly one sent audit row for one send').toHaveLength(1);

      // A restarted worker (fresh provider) finds the job stamped and sends nothing.
      const restartedBase = new InMemoryDeliveryProvider();
      await runThankYouSmsSweep({
        ...deps,
        dispatcher: new MessageDeliveryFeedbackDispatcher(
          new GatedMessageDelivery({
            base: restartedBase,
            dnc: dncRepo,
            auditRepo,
            enforcement: 'block',
            consentLedger: new PgConsentEventRepository(pool),
            env: { ...process.env, TELEPHONY_ENABLED: 'true' },
          }),
        ),
      });
      expect(restartedBase.sentSms, 'a restarted worker never re-thanks').toEqual([]);
      expect(
        (await auditRepo.findByEntity(owner.tenantId, 'job', ownerJob.jobId)).filter(
          (e) => e.eventType === 'notification.thank_you_sms.sent',
        ),
      ).toHaveLength(1);

      // T3 — the neighbour's own switch was honoured in the same pass.
      expect(base.sentSms.filter((m) => m.to === neighbourJob.phone)).toEqual([]);
      expect(await auditRepo.findByEntity(neighbour.tenantId, 'job', neighbourJob.jobId)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ eventType: 'notification.thank_you_sms.sent' })]),
      );
      expect(await auditRepo.findByEntity(neighbour.tenantId, 'job', ownerJob.jobId)).toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors in the Settings session').toEqual([]);
  });
});
