/**
 * S5a-6 (U8, "Pick, don't build") — the daily payment-link reconciliation
 * sweep: the backstop for a cleanup job that was lost or dead-lettered and
 * for pay links that predate the "Collect on the spot" choice.
 *
 * Unit level: the REAL in-memory enumerator the in-memory app boot uses
 * (`InMemorySettingsRepository.listTenantIdsByPaymentCollectionMode`), the
 * in-memory invoice repository, `InMemoryQueue`, and — for "running it
 * deactivates the link" — the real in-memory claimer and the S5a-5 worker.
 * No stubbed tenant list, no mocked pool. The Postgres enumerator (its
 * columns, its RLS posture, the cross-tenant role) is pinned in
 * test/integration/payment-link-mode-switch.test.ts.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  runPaymentLinkReconciliationSweep,
  isPaymentLinkReconciliationHour,
  PAYMENT_LINK_RECONCILIATION_HOUR_UTC,
} from '../../src/workers/payment-link-reconciliation-sweep';
import {
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  PASS_2_DELAY_SECONDS,
  createInMemoryPaymentLinkClaimer,
  deactivatePaymentLinksSweepKey,
  type DeactivatePaymentLinksPayload,
} from '../../src/invoices/payment-mode-change';
import { createDeactivatePaymentLinksWorker } from '../../src/workers/deactivate-payment-links';
import { InMemorySettingsRepository, createSettings, type PaymentCollectionMode } from '../../src/settings/settings';
import { InMemoryInvoiceRepository, type Invoice, type InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue, type QueueMessage } from '../../src/queues/queue';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';
import { createLogger } from '../../src/logging/logger';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const logger = createLogger({ service: 'payment-link-reconciliation-sweep-test', environment: 'test' });
const SWEEP_AT = new Date('2026-10-19T03:12:00.000Z');

/** One invoice repository whose page read fails for chosen tenants (a real throw from the read path). */
class FlakyInvoiceRepository extends InMemoryInvoiceRepository {
  readonly failingTenants = new Set<string>();
  override async findOpenWithPaymentLink(tenantId: string, afterId: string | null, limit: number): Promise<Invoice[]> {
    if (this.failingTenants.has(tenantId)) throw new Error(`invoice store unreachable for ${tenantId}`);
    return super.findOpenWithPaymentLink(tenantId, afterId, limit);
  }
}

function world() {
  const settings = new InMemorySettingsRepository();
  const invoices = new FlakyInvoiceRepository();
  const queue = new InMemoryQueue();
  const sweep = (at: Date = SWEEP_AT) =>
    runPaymentLinkReconciliationSweep({
      listCollectOnSiteTenantIds: () => settings.listTenantIdsByPaymentCollectionMode('collect_on_site'),
      invoiceRepo: invoices,
      queue,
      logger,
      now: () => at,
    });

  async function tenant(mode: PaymentCollectionMode | 'unset'): Promise<string> {
    const tenantId = crypto.randomUUID();
    await createSettings({ tenantId, businessName: 'Acme HVAC' }, settings);
    if (mode !== 'unset') await settings.update(tenantId, { paymentCollectionMode: mode });
    return tenantId;
  }

  async function invoice(tenantId: string, status: InvoiceStatus, linkId?: string): Promise<Invoice> {
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 32500, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return invoices.create({
      id: crypto.randomUUID(),
      tenantId,
      jobId: crypto.randomUUID(),
      invoiceNumber: `INV-${crypto.randomUUID().slice(0, 6)}`,
      status,
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(linkId ? { stripePaymentLinkId: linkId, stripePaymentLinkUrl: `https://pay.stripe.com/${linkId}` } : {}),
    });
  }

  async function drain(): Promise<QueueMessage<DeactivatePaymentLinksPayload>[]> {
    const out: QueueMessage<DeactivatePaymentLinksPayload>[] = [];
    for (;;) {
      const m = await queue.receive<DeactivatePaymentLinksPayload>();
      if (!m) return out;
      out.push(m);
    }
  }

  return { settings, invoices, queue, sweep, tenant, invoice, drain };
}

describe('S5a-6 — the payment-link reconciliation sweep', () => {
  it('enqueues one pass-1 cleanup per collect-on-site tenant still holding a live link, under the :sweep:<UTC date> key; nobody else gets a job', async () => {
    const w = world();
    const lostJob = await w.tenant('collect_on_site');
    await w.invoice(lostJob, 'open', 'plink_lost_job');
    const predates = await w.tenant('collect_on_site');
    await w.invoice(predates, 'partially_paid', 'plink_predates');
    const noLiveLink = await w.tenant('collect_on_site');
    await w.invoice(noLiveLink, 'paid');
    await w.invoice(noLiveLink, 'void');
    const payLink = await w.tenant('pay_link');
    await w.invoice(payLink, 'open', 'plink_pay_link_tenant');
    const unset = await w.tenant('unset');
    await w.invoice(unset, 'open', 'plink_unset_tenant');

    const result = await w.sweep();

    expect(result).toEqual({ candidates: 3, enqueued: 2, skipped: 1, failed: 0 });
    const jobs = await w.drain();
    expect(jobs.map((j) => j.payload.tenantId).sort()).toEqual([lostJob, predates].sort());
    for (const job of jobs) {
      expect(job.type).toBe('deactivate_payment_links');
      expect(job.payload).toEqual({ tenantId: job.payload.tenantId, pass: 1 });
      expect(job.idempotencyKey).toBe(`deactivate-payment-links:${job.payload.tenantId}:sweep:2026-10-19`);
    }
  });

  it('a second sweep the same UTC day adds nothing; the next day keys a new job', async () => {
    const w = world();
    const t = await w.tenant('collect_on_site');
    await w.invoice(t, 'open', 'plink_daily');

    await w.sweep(new Date('2026-10-19T03:01:00.000Z'));
    expect(w.queue.size()).toBe(1);
    await w.sweep(new Date('2026-10-19T03:59:00.000Z'));
    expect(w.queue.size()).toBe(1);

    await w.sweep(new Date('2026-10-20T03:05:00.000Z'));
    expect(w.queue.size()).toBe(2);
    expect((await w.drain()).map((j) => j.idempotencyKey)).toEqual([
      `deactivate-payment-links:${t}:sweep:2026-10-19`,
      `deactivate-payment-links:${t}:sweep:2026-10-20`,
    ]);
  });

  it('one tenant whose invoice read throws is counted failed; the rest of the pass still enqueues', async () => {
    const w = world();
    const broken = await w.tenant('collect_on_site');
    await w.invoice(broken, 'open', 'plink_broken');
    const fine = await w.tenant('collect_on_site');
    await w.invoice(fine, 'open', 'plink_fine');
    w.invoices.failingTenants.add(broken);

    const result = await w.sweep();

    expect(result).toEqual({ candidates: 2, enqueued: 1, skipped: 0, failed: 1 });
    expect((await w.drain()).map((j) => j.payload.tenantId)).toEqual([fine]);
  });

  it('a failing enumerator fails the pass (so the sweep heartbeat reads as lag) and enqueues nothing', async () => {
    const queue = new InMemoryQueue();
    await expect(
      runPaymentLinkReconciliationSweep({
        listCollectOnSiteTenantIds: async () => {
          throw new Error('tenant_settings unreachable');
        },
        invoiceRepo: new InMemoryInvoiceRepository(),
        queue,
        logger,
        now: () => SWEEP_AT,
      }),
    ).rejects.toThrow(/tenant_settings unreachable/);
    expect(queue.size()).toBe(0);
  });

  it('running the job the sweep enqueued retires the link (and its follow-up gets a key of its own); a tenant that switched back after the sweep listed it keeps its link', async () => {
    const w = world();
    const t = await w.tenant('collect_on_site');
    const inv = await w.invoice(t, 'open', 'plink_swept');
    const switchedBack = await w.tenant('collect_on_site');
    const kept = await w.invoice(switchedBack, 'open', 'plink_kept');
    await w.sweep();
    // The owner switches back after the sweep listed the tenant, before the job runs.
    await w.settings.update(switchedBack, { paymentCollectionMode: 'pay_link' });

    const audit = new InMemoryAuditRepository();
    const provider = new MockPaymentLinkProvider();
    const worker = createDeactivatePaymentLinksWorker({
      claimNext: createInMemoryPaymentLinkClaimer({ invoiceRepo: w.invoices, settingsRepo: w.settings, queue: w.queue }),
      invoiceRepo: w.invoices,
      provider,
      settingsRepo: w.settings,
      auditRepo: audit,
    });
    for (const job of await w.drain()) await worker.handle(job, logger);

    expect(provider.deactivations.map((d) => d.linkId)).toEqual(['plink_swept']);
    expect((await w.invoices.findById(t, inv.id))?.stripePaymentLinkId).toBeUndefined();
    expect((await w.invoices.findById(switchedBack, kept.id))?.stripePaymentLinkId).toBe('plink_kept');
    expect(
      audit.getAll().filter((e) => e.eventType === 'invoice.payment_link_deactivated').map((e) => [e.entityId, e.metadata?.reason]),
    ).toEqual([[inv.id, 'payment_mode_changed']]);
    expect(
      audit
        .getAll()
        .filter((e) => e.eventType === 'payment_links.cleanup_superseded')
        .map((e) => [e.entityId, e.metadata?.modeRead]),
    ).toEqual([[switchedBack, 'pay_link']]);
    // Only the swept collect-on-site job enqueued a follow-up (delayed 120 s),
    // under the sweep key plus :pass2.
    expect(w.queue.size()).toBe(1);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + PASS_2_DELAY_SECONDS * 1000 + 1;
      expect((await w.drain()).map((j) => [j.payload, j.idempotencyKey])).toEqual([
        [{ tenantId: t, pass: 2 }, `deactivate-payment-links:${t}:sweep:2026-10-19:pass2`],
      ]);
    } finally {
      Date.now = realNow;
    }
  });

  it('the sweep key is the job type\'s key family with the UTC calendar date', () => {
    const t = '00000000-0000-4000-8000-000000000001';
    expect(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE).toBe('deactivate_payment_links');
    // 23:30 in New York on Oct 18 is already Oct 19 in UTC.
    expect(deactivatePaymentLinksSweepKey(t, new Date('2026-10-19T03:30:00.000Z'))).toBe(
      `deactivate-payment-links:${t}:sweep:2026-10-19`,
    );
    expect(deactivatePaymentLinksSweepKey(t, new Date('2026-10-19T23:59:59.999Z'))).toBe(
      `deactivate-payment-links:${t}:sweep:2026-10-19`,
    );
  });

  it('runs once a day: only an hourly tick inside 03:00–03:59 UTC sweeps', () => {
    expect(PAYMENT_LINK_RECONCILIATION_HOUR_UTC).toBe(3);
    expect(isPaymentLinkReconciliationHour(new Date('2026-10-19T02:59:59.999Z'))).toBe(false);
    expect(isPaymentLinkReconciliationHour(new Date('2026-10-19T03:00:00.000Z'))).toBe(true);
    expect(isPaymentLinkReconciliationHour(new Date('2026-10-19T03:59:59.999Z'))).toBe(true);
    expect(isPaymentLinkReconciliationHour(new Date('2026-10-19T04:00:00.000Z'))).toBe(false);
  });
});

describe('S5a-6 — the in-memory enumerator', () => {
  it('lists exactly the tenants whose stored choice is collect_on_site, sorted; an unset key is the pay_link default (D-039/D-040)', async () => {
    const repo = new InMemorySettingsRepository();
    const ids: Record<string, string> = {};
    for (const [name, mode] of [
      ['a', 'collect_on_site'],
      ['b', 'pay_link'],
      ['c', 'unset'],
      ['d', 'collect_on_site'],
    ] as const) {
      ids[name] = crypto.randomUUID();
      await createSettings({ tenantId: ids[name], businessName: name }, repo);
      if (mode !== 'unset') await repo.update(ids[name], { paymentCollectionMode: mode });
    }
    expect(await repo.listTenantIdsByPaymentCollectionMode('collect_on_site')).toEqual([ids.a, ids.d].sort());
    expect(await repo.listTenantIdsByPaymentCollectionMode('pay_link')).toEqual([ids.b]);
  });
});
