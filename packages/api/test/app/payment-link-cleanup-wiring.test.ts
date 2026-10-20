/**
 * S5a-5 (U8) — does `createApp()` actually wire the pay-link cleanup?
 *
 * The job only runs if three things are connected in app.ts: the
 * `deactivate_payment_links` handler is registered (unconditionally — with
 * no pool, over the in-memory claimer), `PUT /api/settings` gets the app
 * queue, and the `onboarding_voice_policy` handler gets it through the
 * execution registry. Unit and integration tests build those pieces by hand,
 * so a dropped argument in app.ts would leave them green. This file boots the
 * real app (in-memory, web role), captures what app.ts hands each factory,
 * and runs the registered handler against the app's own repositories.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { WorkerHandler } from '../../src/queues/queue';
import type { DeactivatePaymentLinksPayload } from '../../src/invoices/payment-mode-change';

const captured: {
  workers: Array<WorkerHandler<DeactivatePaymentLinksPayload>>;
  settingsRouterPaymentModeDeps: unknown[];
  executionQueues: unknown[];
} = { workers: [], settingsRouterPaymentModeDeps: [], executionQueues: [] };

vi.mock('../../src/workers/deactivate-payment-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/deactivate-payment-links')>();
  return {
    ...actual,
    createDeactivatePaymentLinksWorker: (...args: Parameters<typeof actual.createDeactivatePaymentLinksWorker>) => {
      const worker = actual.createDeactivatePaymentLinksWorker(...args);
      captured.workers.push(worker);
      return worker;
    },
  };
});

vi.mock('../../src/routes/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/settings')>();
  return {
    ...actual,
    createSettingsRouter: (...args: Parameters<typeof actual.createSettingsRouter>) => {
      captured.settingsRouterPaymentModeDeps.push(args[6]);
      return actual.createSettingsRouter(...args);
    },
  };
});

vi.mock('../../src/proposals/execution/handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/proposals/execution/handlers')>();
  return {
    ...actual,
    createExecutionHandlerRegistry: (...args: Parameters<typeof actual.createExecutionHandlerRegistry>) => {
      captured.executionQueues.push(args[0]?.queue);
      return actual.createExecutionHandlerRegistry(...args);
    },
  };
});

const ENV_KEYS = ['DATABASE_URL', 'PROCESS_ROLE', 'AI_PROVIDER_API_KEY'] as const;
const originalEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

let app: { shutdown?: () => Promise<void> } | undefined;
let queue: import('../../src/queues/queue').InMemoryQueue;
let settingsRepo: import('../../src/settings/settings').InMemorySettingsRepository;
let invoiceRepo: import('../../src/invoices/invoice').InMemoryInvoiceRepository;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.AI_PROVIDER_API_KEY;
  process.env.PROCESS_ROLE = 'web';
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
  const { InMemoryQueue } = await import('../../src/queues/queue');
  const { InMemorySettingsRepository } = await import('../../src/settings/settings');
  const { InMemoryInvoiceRepository } = await import('../../src/invoices/invoice');
  queue = new InMemoryQueue();
  settingsRepo = new InMemorySettingsRepository();
  invoiceRepo = new InMemoryInvoiceRepository();
  const { createApp } = await import('../../src/app');
  app = createApp({ queue, settingsRepo, invoiceRepo }) as unknown as { shutdown?: () => Promise<void> };
});

afterAll(async () => {
  await app?.shutdown?.();
  for (const [k, v] of originalEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
});

describe("createApp wires the pay-link cleanup (S5a-5)", () => {
  it('PUT /api/settings and the onboarding_voice_policy handler both receive the app queue', () => {
    expect(captured.settingsRouterPaymentModeDeps).toEqual([{ queue }]);
    expect(captured.executionQueues).toEqual([queue]);
  });

  it('registers the deactivate_payment_links handler without a pool, and it retires a live link through the app repositories', async () => {
    expect(captured.workers).toHaveLength(1);
    const worker = captured.workers[0];
    expect(worker.type).toBe('deactivate_payment_links');

    const { createSettings } = await import('../../src/settings/settings');
    const { buildLineItem, calculateDocumentTotals } = await import('../../src/shared/billing-engine');
    const { createLogger } = await import('../../src/logging/logger');
    const tenantId = crypto.randomUUID();
    await createSettings({ tenantId, businessName: 'Acme HVAC' }, settingsRepo);
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
      stripePaymentLinkId: 'plink_wired',
      stripePaymentLinkUrl: 'https://pay.stripe.com/wired',
    });

    await worker.handle(
      {
        id: crypto.randomUUID(),
        type: 'deactivate_payment_links',
        payload: { tenantId, pass: 1 },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: `deactivate-payment-links:${tenantId}:wired`,
        createdAt: new Date().toISOString(),
      },
      createLogger({ service: 'wiring-test', environment: 'test' }),
    );

    expect((await invoiceRepo.findById(tenantId, invoiceId))?.stripePaymentLinkId).toBeUndefined();
    // (The audit rows are pinned in the unit and integration suites; the app
    // wraps its audit repository, so this file asserts the effect.)
    // The follow-up pass was enqueued on the app queue.
    expect(queue.size()).toBe(1);
  });
});
