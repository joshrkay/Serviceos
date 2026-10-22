/**
 * S5a-6 (U8) — does `createApp()` actually run the daily payment-link
 * reconciliation sweep?
 *
 * The sweep and its enumerators are proven on their own (unit:
 * test/workers/payment-link-reconciliation-sweep.test.ts; Postgres:
 * test/integration/payment-link-mode-switch.test.ts). This file proves the
 * app.ts registration end to end: a worker-role boot (in-memory, no pool),
 * the clock driven past one hourly tick, and the app's own queue poll loop
 * running the job the sweep enqueued through the registered
 * `deactivate_payment_links` handler. Inside 03:00–03:59 UTC the tenant's
 * live link is retired; outside it the tick does nothing.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import crypto from 'crypto';

const ENV_KEYS = ['DATABASE_URL', 'PROCESS_ROLE', 'AI_PROVIDER_API_KEY'] as const;
const originalEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

type App = { gracefulDrain: (reason: string) => Promise<void> };
let app: App | undefined;

// Cold-importing app.ts is most of this file's cost; pay it once, outside a test's timeout.
beforeAll(async () => {
  await import('../../src/app');
}, 120_000);

afterEach(async () => {
  vi.useRealTimers();
  await app?.gracefulDrain('test-cleanup');
  app = undefined;
  for (const [k, v] of originalEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
});

async function bootAt(iso: string) {
  vi.useFakeTimers({ now: new Date(iso), toFake: ['setInterval', 'clearInterval', 'Date'] });
  delete process.env.DATABASE_URL;
  delete process.env.AI_PROVIDER_API_KEY;
  process.env.PROCESS_ROLE = 'worker';
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
  const { InMemoryQueue } = await import('../../src/queues/queue');
  const { InMemorySettingsRepository, createSettings } = await import('../../src/settings/settings');
  const { InMemoryInvoiceRepository } = await import('../../src/invoices/invoice');
  const { buildLineItem, calculateDocumentTotals } = await import('../../src/shared/billing-engine');
  const queue = new InMemoryQueue();
  const settingsRepo = new InMemorySettingsRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();

  const tenantId = crypto.randomUUID();
  await createSettings({ tenantId, businessName: 'Acme HVAC' }, settingsRepo);
  // Stored directly: a link that predates the choice, with no cleanup job queued.
  await settingsRepo.update(tenantId, { paymentCollectionMode: 'collect_on_site' });
  const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 20000, 0, true, 'labor')];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  const invoiceId = crypto.randomUUID();
  await invoiceRepo.create({
    id: invoiceId,
    tenantId,
    jobId: crypto.randomUUID(),
    invoiceNumber: 'INV-1',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
    stripePaymentLinkId: 'plink_predates_choice',
    stripePaymentLinkUrl: 'https://pay.stripe.com/predates',
  });

  const { createApp } = await import('../../src/app');
  app = createApp({ queue, settingsRepo, invoiceRepo }) as unknown as App;
  expect(queue.size()).toBe(0);
  return { queue, invoiceRepo, tenantId, invoiceId };
}

/** One hour of ticks, letting each tick's async work (the sweep, the poll loop's job) settle. */
async function oneHour(): Promise<void> {
  for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(60_000);
}

describe('createApp runs the daily payment-link reconciliation sweep (S5a-6)', () => {
  it('a worker boot whose hourly tick lands in 03:00–03:59 UTC retires a link that predates the choice, through the app queue and the registered cleanup handler', async () => {
    const w = await bootAt('2026-10-19T02:30:00.000Z');
    await oneHour();
    await vi.waitFor(async () => {
      expect((await w.invoiceRepo.findById(w.tenantId, w.invoiceId))?.stripePaymentLinkId).toBeUndefined();
    });
    // The swept job ran and left its follow-up under the sweep key plus :pass2.
    const realNow = Date.now();
    vi.setSystemTime(realNow + 121_000);
    const followUp = await w.queue.receive<{ tenantId: string; pass: number }>();
    expect(followUp?.payload).toEqual({ tenantId: w.tenantId, pass: 2 });
    expect(followUp?.idempotencyKey).toBe(`deactivate-payment-links:${w.tenantId}:sweep:2026-10-19:pass2`);
  });

  it('a tick outside the 03:00 UTC hour enqueues nothing and the link stays', async () => {
    const w = await bootAt('2026-10-19T04:30:00.000Z');
    await oneHour();
    expect(w.queue.size()).toBe(0);
    expect((await w.invoiceRepo.findById(w.tenantId, w.invoiceId))?.stripePaymentLinkId).toBe('plink_predates_choice');
  });
});
