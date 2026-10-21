/**
 * S5a-5 (U8, "Pick, don't build") — the payment-mode switch enqueues the
 * `deactivate_payment_links` job inside the settings write, and the job
 * retires the tenant's live pay links one claim at a time.
 *
 * Unit level: in-memory repositories, `InMemoryQueue`, and the REAL
 * in-memory claimer the in-memory app boot registers (no stubbed claim). The
 * provider is the repo's `MockPaymentLinkProvider`, subclassed with a
 * fail-once switch. The Postgres half (the job row committed with the mode,
 * the claim's lock order, the lease, the races) is pinned in
 * test/integration/payment-link-mode-switch.test.ts.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  CLEANUP_LEASE_MS,
  PASS_2_DELAY_SECONDS,
  createInMemoryPaymentLinkClaimer,
  deactivatePaymentLinksKey,
  followUpKey,
  onPaymentCollectionModeChanged,
  type DeactivatePaymentLinksPayload,
} from '../../src/invoices/payment-mode-change';
import { createDeactivatePaymentLinksWorker } from '../../src/workers/deactivate-payment-links';
import {
  InMemorySettingsRepository,
  createSettings,
  updateSettings,
  type PaymentCollectionMode,
  type TenantSettings,
} from '../../src/settings/settings';
import { InMemoryInvoiceRepository, type Invoice, type InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryQueue, type QueueMessage } from '../../src/queues/queue';
import { MockPaymentLinkProvider, type DeactivateLinkOptions } from '../../src/payments/payment-link-provider';
import { OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import type { Proposal } from '../../src/proposals/proposal';
import { createLogger } from '../../src/logging/logger';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const log = createLogger({ service: 'deactivate-payment-links-test', environment: 'test' });
const CONNECT = 'acct_minting_scope';

type ModeState = PaymentCollectionMode | 'unset';

/** Drain every visible message of the job type (oldest first). */
async function drain(queue: InMemoryQueue): Promise<QueueMessage<DeactivatePaymentLinksPayload>[]> {
  const out: QueueMessage<DeactivatePaymentLinksPayload>[] = [];
  for (;;) {
    const m = await queue.receive<DeactivatePaymentLinksPayload>();
    if (!m) return out;
    out.push(m);
  }
}

async function seedSettings(repo: InMemorySettingsRepository, tenantId: string, mode: ModeState) {
  await createSettings({ tenantId, businessName: 'Acme HVAC' }, repo);
  if (mode !== 'unset') await repo.update(tenantId, { paymentCollectionMode: mode });
}

// ─── which writes enqueue ───────────────────────────────────────────────────

describe('S5a-5 — which settings writes enqueue the cleanup job', () => {
  const states: ModeState[] = ['unset', 'pay_link', 'collect_on_site'];
  const targets: PaymentCollectionMode[] = ['pay_link', 'collect_on_site'];

  it('onPaymentCollectionModeChanged enqueues exactly when the stored value moves from pay_link or unset to collect_on_site', async () => {
    for (const before of states) {
      for (const after of [...states, 'no_key' as const]) {
        const queue = new InMemoryQueue();
        const tenantId = crypto.randomUUID();
        const updatedAt = new Date('2026-10-19T12:00:00.000Z');
        const row = (m: ModeState): TenantSettings =>
          ({
            id: 's',
            tenantId,
            businessName: 'Acme HVAC',
            updatedAt,
            ...(m === 'unset' ? {} : { paymentCollectionMode: m }),
          }) as TenantSettings;
        await onPaymentCollectionModeChanged(queue, {
          client: null,
          tenantId,
          before: row(before),
          after: row(after === 'no_key' ? before : after),
        });
        const jobs = await drain(queue);
        const expected = (before === 'unset' || before === 'pay_link') && after === 'collect_on_site';
        expect({ before, after, enqueued: jobs.length }).toEqual({ before, after, enqueued: expected ? 1 : 0 });
        if (expected) {
          expect(jobs[0].type).toBe('deactivate_payment_links');
          expect(jobs[0].payload).toEqual({ tenantId, pass: 1 });
          expect(jobs[0].idempotencyKey).toBe(`deactivate-payment-links:${tenantId}:2026-10-19T12:00:00.000Z`);
        }
      }
    }
  });

  it('a null before (no prior row) counts as unset', async () => {
    const queue = new InMemoryQueue();
    const tenantId = crypto.randomUUID();
    await onPaymentCollectionModeChanged(queue, {
      client: null,
      tenantId,
      before: null,
      after: { id: 's', tenantId, updatedAt: new Date(0), paymentCollectionMode: 'collect_on_site' } as TenantSettings,
    });
    expect(await drain(queue)).toHaveLength(1);
  });

  for (const site of ['updateSettings (PUT /api/settings)', 'onboarding_voice_policy handler'] as const) {
    it(`write site ${site}: exactly pay_link→collect_on_site and unset→collect_on_site enqueue; a patch without the key enqueues nothing`, async () => {
      for (const before of states) {
        for (const target of [...targets, 'no_key' as const]) {
          const repo = new InMemorySettingsRepository();
          const queue = new InMemoryQueue();
          const tenantId = crypto.randomUUID();
          await seedSettings(repo, tenantId, before);
          if (site === 'updateSettings (PUT /api/settings)') {
            await updateSettings(
              tenantId,
              target === 'no_key' ? { businessName: 'Renamed' } : { paymentCollectionMode: target },
              repo,
              { preserveVoiceApprovalPin: true, paymentModeQueue: queue },
            );
          } else {
            const handler = new OnboardingVoicePolicyExecutionHandler(repo, new InMemoryAuditRepository(), queue);
            const result = await handler.execute(
              {
                id: crypto.randomUUID(),
                tenantId,
                proposalType: 'onboarding_voice_policy',
                status: 'approved',
                payload: target === 'no_key' ? { voiceGreeting: 'Hi there' } : { paymentCollectionMode: target },
                summary: 'voice policy',
              } as unknown as Proposal,
              { tenantId, executedBy: crypto.randomUUID(), executedByRole: 'owner' },
            );
            expect(result.success).toBe(true);
          }
          const jobs = await drain(queue);
          const expected = (before === 'unset' || before === 'pay_link') && target === 'collect_on_site';
          expect({ before, target, enqueued: jobs.length }).toEqual({ before, target, enqueued: expected ? 1 : 0 });
          if (expected) {
            const stored = await repo.findByTenant(tenantId);
            expect(jobs[0].payload).toEqual({ tenantId, pass: 1 });
            expect(jobs[0].idempotencyKey).toBe(deactivatePaymentLinksKey(tenantId, stored!.updatedAt));
            expect(jobs[0].idempotencyKey).toBe(
              `deactivate-payment-links:${tenantId}:${stored!.updatedAt.toISOString()}`,
            );
          }
        }
      }
    });
  }

  it('the keys and timings are the plan\'s', () => {
    const t = '00000000-0000-4000-8000-000000000001';
    const at = new Date('2026-10-19T12:00:00.000Z');
    expect(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE).toBe('deactivate_payment_links');
    expect(deactivatePaymentLinksKey(t, at)).toBe(`deactivate-payment-links:${t}:2026-10-19T12:00:00.000Z`);
    expect(followUpKey(deactivatePaymentLinksKey(t, at))).toBe(`deactivate-payment-links:${t}:2026-10-19T12:00:00.000Z:pass2`);
    expect(CLEANUP_LEASE_MS).toBe(600_000);
    expect(PASS_2_DELAY_SECONDS).toBe(120);
  });
});

// ─── the job ────────────────────────────────────────────────────────────────

/** The repo's provider fake, with a switch that fails every call for a link and a hook per call. */
class SwitchableProvider extends MockPaymentLinkProvider {
  readonly failing = new Set<string>();
  onDeactivate: ((linkId: string) => Promise<void>) | null = null;
  calls = 0;

  async deactivateLink(linkId: string, stripeAccountId?: string, options?: DeactivateLinkOptions): Promise<void> {
    this.calls++;
    if (this.onDeactivate) await this.onDeactivate(linkId);
    if (this.failing.has(linkId)) throw new Error(`stripe down for ${linkId}`);
    await super.deactivateLink(linkId, stripeAccountId, options);
  }
}

class FlakySettingsRepository extends InMemorySettingsRepository {
  failReads = false;
  async findByTenant(tenantId: string) {
    if (this.failReads) throw new Error('settings store unreachable');
    return super.findByTenant(tenantId);
  }
}

interface Harness {
  tenantId: string;
  settings: FlakySettingsRepository;
  invoices: InMemoryInvoiceRepository;
  audit: InMemoryAuditRepository;
  users: InMemoryUserRepository;
  queue: InMemoryQueue;
  provider: SwitchableProvider;
  clock: { now: Date };
  addInvoice(status: InvoiceStatus, linkId?: string, tenantId?: string): Promise<Invoice>;
  run(payload: DeactivatePaymentLinksPayload, key?: string): Promise<void>;
  pass1Key: string;
  events(eventType: string): Array<{ entityType: string; entityId: string; metadata: Record<string, unknown> }>;
  switchTo(mode: PaymentCollectionMode): Promise<void>;
}

async function harness(opts: { initial?: ModeState; ownerFirstName?: string | null } = {}): Promise<Harness> {
  const tenantId = crypto.randomUUID();
  const settings = new FlakySettingsRepository();
  const invoices = new InMemoryInvoiceRepository();
  const audit = new InMemoryAuditRepository();
  const users = new InMemoryUserRepository();
  const queue = new InMemoryQueue();
  const provider = new SwitchableProvider();
  const clock = { now: new Date() };
  await seedSettings(settings, tenantId, opts.initial ?? 'pay_link');
  if (opts.ownerFirstName !== null) {
    await users.create({
      id: crypto.randomUUID(),
      tenantId,
      clerkUserId: `user_${crypto.randomUUID()}`,
      email: 'owner@acme.test',
      role: 'owner',
      firstName: opts.ownerFirstName ?? 'Dana',
    } as never);
  }
  const claimNext = createInMemoryPaymentLinkClaimer({
    invoiceRepo: invoices,
    settingsRepo: settings,
    queue,
    now: () => clock.now,
  });
  const worker = createDeactivatePaymentLinksWorker({
    claimNext,
    invoiceRepo: invoices,
    provider,
    connectAccountResolver: {
      resolveTenantConnectAccount: async () => ({ accountId: CONNECT, chargesEnabled: true }),
    } as never,
    settingsRepo: settings,
    userRepo: users,
    auditRepo: audit,
  });
  let pass1Key = '';
  const h: Harness = {
    tenantId,
    settings,
    invoices,
    audit,
    users,
    queue,
    provider,
    clock,
    get pass1Key() {
      return pass1Key;
    },
    async addInvoice(status, linkId, forTenant = tenantId) {
      const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 32500, 0, true, 'labor')];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      const paid = status === 'paid' ? totals.totalCents : status === 'partially_paid' ? 10000 : 0;
      const inv: Invoice = {
        id: crypto.randomUUID(),
        tenantId: forTenant,
        jobId: crypto.randomUUID(),
        invoiceNumber: `INV-${crypto.randomUUID().slice(0, 6)}`,
        status,
        lineItems,
        totals,
        amountPaidCents: paid,
        amountDueCents: totals.totalCents - paid,
        createdBy: 'u',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(linkId ? { stripePaymentLinkId: linkId, stripePaymentLinkUrl: `https://pay.stripe.com/${linkId}` } : {}),
      };
      return invoices.create(inv);
    },
    async run(payload, key) {
      await worker.handle(
        {
          id: crypto.randomUUID(),
          type: DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
          payload,
          attempts: 1,
          maxAttempts: 3,
          idempotencyKey: key ?? pass1Key,
          createdAt: new Date().toISOString(),
        },
        log,
      );
    },
    events(eventType) {
      return audit
        .getAll()
        .filter((e) => e.eventType === eventType && e.tenantId === tenantId)
        .map((e) => ({ entityType: e.entityType, entityId: e.entityId, metadata: e.metadata as Record<string, unknown> }));
    },
    // The switch the owner makes; its job row is what the tests run.
    async switchTo(mode) {
      await updateSettings(tenantId, { paymentCollectionMode: mode }, settings, { paymentModeQueue: queue });
      const jobs = await drain(queue);
      if (jobs.length > 0) pass1Key = jobs[0].idempotencyKey;
    },
  };
  return h;
}

const DANA_MESSAGE = 'Acme HVAC collects payment in person. Please settle up with Dana when the work is done.';

describe('S5a-5 — the deactivate_payment_links job', () => {
  it('a switch to collect on site retires exactly the live links: open and partially paid, under the minting scope, with the in-person message; a paid invoice and a neighbour are untouched', async () => {
    const h = await harness();
    const open = await h.addInvoice('open', 'plink_open');
    const partial = await h.addInvoice('partially_paid', 'plink_partial');
    const paid = await h.addInvoice('paid');
    const neighbour = await h.addInvoice('open', 'plink_neighbour', crypto.randomUUID());
    await h.switchTo('collect_on_site');
    expect(h.pass1Key).toMatch(new RegExp(`^deactivate-payment-links:${h.tenantId}:`));

    await h.run({ tenantId: h.tenantId, pass: 1 });

    expect(h.provider.deactivations.map((d) => d.linkId).sort()).toEqual(['plink_open', 'plink_partial']);
    for (const d of h.provider.deactivations) {
      expect(d.stripeAccountId).toBe(CONNECT);
      expect(d.inactiveMessage).toBe(DANA_MESSAGE);
    }
    for (const inv of [open, partial]) {
      const row = await h.invoices.findById(h.tenantId, inv.id);
      expect(row?.stripePaymentLinkId).toBeUndefined();
      expect(row?.stripePaymentLinkUrl).toBeUndefined();
      expect(row?.cleanupClaimedAt).toBeUndefined();
    }
    const deactivated = h.events('invoice.payment_link_deactivated');
    expect(deactivated.map((e) => e.entityId).sort()).toEqual([open.id, partial.id].sort());
    for (const e of deactivated) expect(e.metadata.reason).toBe('payment_mode_changed');
    expect((await h.invoices.findById(h.tenantId, paid.id))?.status).toBe('paid');
    expect((await h.invoices.findById(neighbour.tenantId, neighbour.id))?.stripePaymentLinkId).toBe('plink_neighbour');
    expect(h.events('payment_links.cleanup_completed')).toEqual([
      { entityType: 'tenant', entityId: h.tenantId, metadata: { pass: 1, deactivated: 2, failed: 0 } },
    ]);
  });

  it('a legacy tenant whose key was never set: the switch enqueues one job and it retires both links', async () => {
    const h = await harness({ initial: 'unset' });
    await h.addInvoice('open', 'plink_a');
    await h.addInvoice('partially_paid', 'plink_b');
    await h.switchTo('collect_on_site');
    expect(h.pass1Key).not.toBe('');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations.map((d) => d.linkId).sort()).toEqual(['plink_a', 'plink_b']);
  });

  it('no live links: the job succeeds, the provider is never called, no per-invoice events', async () => {
    const h = await harness();
    await h.addInvoice('paid');
    await h.switchTo('collect_on_site');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.calls).toBe(0);
    expect(h.audit.getAll().filter((e) => e.entityType === 'invoice')).toEqual([]);
    expect(h.events('payment_links.cleanup_completed')[0].metadata).toEqual({ pass: 1, deactivated: 0, failed: 0 });
  });

  it('a switch back to pay link before the job runs: its first claim reads pay_link and it stops as superseded — no provider call, no pass 2, links stay, one superseded event', async () => {
    const h = await harness();
    const a = await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    await h.switchTo('pay_link');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.calls).toBe(0);
    expect(h.queue.size()).toBe(0);
    expect((await h.invoices.findById(h.tenantId, a.id))?.stripePaymentLinkId).toBe('plink_a');
    expect(h.events('payment_links.cleanup_superseded')).toEqual([
      { entityType: 'tenant', entityId: h.tenantId, metadata: { pass: 1, modeRead: 'pay_link', deactivated: 0, failed: 0 } },
    ]);
  });

  it('a switch back while the cleanup is paging: the link in flight is retired, the next claim is superseded, the rest stay', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_1');
    await h.addInvoice('open', 'plink_2');
    await h.addInvoice('open', 'plink_3');
    await h.switchTo('collect_on_site');
    h.provider.onDeactivate = async () => {
      h.provider.onDeactivate = null;
      await h.switchTo('pay_link');
    };
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations).toHaveLength(1);
    expect((await h.invoices.findOpenWithPaymentLink(h.tenantId, null, 10))).toHaveLength(2);
    expect(h.events('payment_links.cleanup_superseded')[0].metadata).toEqual({
      pass: 1,
      modeRead: 'pay_link',
      deactivated: 1,
      failed: 0,
    });
  });

  it('an unreadable mode in the claim: nothing deactivated, no pass 2, a tenant-level payment_mode_unavailable with surface cleanup, the job throws; the retry after recovery retires the links', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    h.settings.failReads = true;
    await expect(h.run({ tenantId: h.tenantId, pass: 1 })).rejects.toThrow('settings store unreachable');
    expect(h.provider.calls).toBe(0);
    expect(h.queue.size()).toBe(0);
    expect(h.events('invoice.payment_mode_unavailable')).toEqual([
      {
        entityType: 'tenant',
        entityId: h.tenantId,
        metadata: { reason: 'payment_mode_unavailable', surface: 'cleanup', error: 'settings store unreachable' },
      },
    ]);
    expect(h.events('payment_links.cleanup_superseded')).toEqual([]);

    h.settings.failReads = false;
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations.map((d) => d.linkId)).toEqual(['plink_a']);
  });

  it('an error is never read as collect on site, and an absent key is never read as collect on site', async () => {
    const h = await harness({ initial: 'unset' });
    await h.addInvoice('open', 'plink_a');
    await h.run({ tenantId: h.tenantId, pass: 1 }, 'deactivate-payment-links:manual');
    expect(h.provider.calls).toBe(0);
    expect(h.events('payment_links.cleanup_superseded')[0].metadata.modeRead).toBe('pay_link');
  });

  it('idempotent: enqueued twice under one key it is one job, and a re-run makes no second provider call and no second audit row', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_a');
    await h.addInvoice('open', 'plink_b');
    await h.switchTo('collect_on_site');
    await h.queue.send(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, { tenantId: h.tenantId, pass: 1 }, h.pass1Key);
    await h.queue.send(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, { tenantId: h.tenantId, pass: 1 }, h.pass1Key);
    expect((await drain(h.queue)).length).toBe(1);
    await h.run({ tenantId: h.tenantId, pass: 1 });
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.calls).toBe(2);
    expect(h.events('invoice.payment_link_deactivated')).toHaveLength(2);
  });

  it('one of three failing at Stripe: it keeps its columns and is audited as failed, the others are retired, the job throws, and the retry touches only the failed one', async () => {
    const h = await harness();
    const a = await h.addInvoice('open', 'plink_a');
    const b = await h.addInvoice('open', 'plink_b');
    const c = await h.addInvoice('open', 'plink_c');
    await h.switchTo('collect_on_site');
    h.provider.failing.add('plink_b');
    await expect(h.run({ tenantId: h.tenantId, pass: 1 })).rejects.toThrow(/1 .*failed/);
    expect(h.provider.deactivations.map((d) => d.linkId).sort()).toEqual(['plink_a', 'plink_c']);
    const bRow = await h.invoices.findById(h.tenantId, b.id);
    expect(bRow?.stripePaymentLinkId).toBe('plink_b');
    expect(bRow?.cleanupClaimedAt).toBeUndefined(); // the claim was released
    expect(h.events('invoice.payment_link_deactivation_failed').map((e) => e.entityId)).toEqual([b.id]);
    expect(h.events('payment_links.cleanup_completed')[0].metadata).toEqual({ pass: 1, deactivated: 2, failed: 1 });

    h.provider.failing.clear();
    const before = h.provider.calls;
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.calls - before).toBe(1);
    expect(h.provider.deactivations.map((d) => d.linkId)).toContain('plink_b');
    for (const inv of [a, b, c]) {
      expect((await h.invoices.findById(h.tenantId, inv.id))?.stripePaymentLinkId).toBeUndefined();
      expect(h.events('invoice.payment_link_deactivated').filter((e) => e.entityId === inv.id)).toHaveLength(1);
    }
  });

  it('pass 1 enqueues exactly one pass 2 under its own key plus :pass2 with the 120 s delay; a retry of pass 1 adds none', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.queue.size()).toBe(1);
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.queue.size()).toBe(1);
    // Delayed: not visible now, visible after 120 s.
    expect(await h.queue.receive()).toBeNull();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + PASS_2_DELAY_SECONDS * 1000 + 1;
      const followUp = await h.queue.receive<DeactivatePaymentLinksPayload>();
      expect(followUp?.payload).toEqual({ tenantId: h.tenantId, pass: 2 });
      expect(followUp?.idempotencyKey).toBe(`${h.pass1Key}:pass2`);
      expect(followUp?.idempotencyKey).not.toBe(h.pass1Key);
    } finally {
      Date.now = realNow;
    }
  });

  it('pass 2 retires a link attached just after pass 1 and enqueues nothing; the cap is read from the payload, not the key', async () => {
    const h = await harness();
    await h.switchTo('collect_on_site');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    await drain(h.queue); // nothing visible yet; the follow-up stays delayed
    const queuedBefore = h.queue.size();
    await h.addInvoice('open', 'plink_racer');
    await h.run({ tenantId: h.tenantId, pass: 2 }, `${h.pass1Key}:pass2`);
    expect(h.provider.deactivations.map((d) => d.linkId)).toEqual(['plink_racer']);
    expect(h.queue.size()).toBe(queuedBefore);
    // A pass-2 payload under a pass-1-shaped key still enqueues nothing.
    await h.addInvoice('open', 'plink_late');
    await h.run({ tenantId: h.tenantId, pass: 2 }, 'deactivate-payment-links:fresh-key');
    expect(h.queue.size()).toBe(queuedBefore);
  });

  it('pass 2 with the mode switched back before it runs is superseded at its first claim and does nothing', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    await h.switchTo('pay_link');
    await h.run({ tenantId: h.tenantId, pass: 2 }, 'k:pass2');
    expect(h.provider.calls).toBe(0);
    expect(h.events('payment_links.cleanup_superseded')[0].metadata).toMatchObject({ pass: 2, deactivated: 0 });
  });

  it('a crashed claimer: a link under an unexpired lease is skipped (9 min), an expired one is reclaimed (11 min) and retired once', async () => {
    const h = await harness();
    const a = await h.addInvoice('open', 'plink_a');
    await h.addInvoice('open', 'plink_b');
    await h.switchTo('collect_on_site');
    const claimedAt = new Date(h.clock.now.getTime());
    expect(h.invoices.markCleanupClaimed(h.tenantId, a.id, 'plink_a', claimedAt)).toBe(true);

    h.clock.now = new Date(claimedAt.getTime() + 9 * 60_000);
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations.map((d) => d.linkId)).toEqual(['plink_b']);

    h.clock.now = new Date(claimedAt.getTime() + CLEANUP_LEASE_MS + 60_000);
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations.map((d) => d.linkId)).toEqual(['plink_b', 'plink_a']);
    expect((await h.invoices.findById(h.tenantId, a.id))?.cleanupClaimedAt).toBeUndefined();
  });

  it('a claimed invoice whose link was cleared elsewhere before the act is skipped, not deactivated again', async () => {
    const h = await harness();
    const a = await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    const original = h.invoices.findById.bind(h.invoices);
    let cleared = false;
    h.invoices.findById = async (tenantId: string, id: string) => {
      if (!cleared && id === a.id) {
        cleared = true;
        await h.invoices.clearPaymentLinkIfMatches(tenantId, id, 'plink_a');
      }
      return original(tenantId, id);
    };
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.calls).toBe(0);
    expect(h.events('payment_links.cleanup_completed')[0].metadata).toEqual({ pass: 1, deactivated: 0, failed: 0 });
  });

  it('a claimed invoice that cannot be re-read is counted failed and its claim handed back; the retry retires it', async () => {
    const h = await harness();
    const a = await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    const original = h.invoices.findById.bind(h.invoices);
    h.invoices.findById = async () => {
      throw new Error('invoice store unreachable');
    };
    await expect(h.run({ tenantId: h.tenantId, pass: 1 })).rejects.toThrow(/1 pay link\(s\) failed/);
    expect(h.provider.calls).toBe(0);
    h.invoices.findById = original;
    expect((await h.invoices.findById(h.tenantId, a.id))?.cleanupClaimedAt).toBeUndefined();
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations.map((d) => d.linkId)).toEqual(['plink_a']);
  });

  it('the in-person message names only the business when no owner first name is on file, or when the name read fails', async () => {
    const h = await harness({ ownerFirstName: null });
    await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    await h.run({ tenantId: h.tenantId, pass: 1 });
    expect(h.provider.deactivations[0].inactiveMessage).toBe(
      'Acme HVAC collects payment in person. Please settle up when the work is done.',
    );

    const h2 = await harness();
    await h2.addInvoice('open', 'plink_b');
    await h2.switchTo('collect_on_site');
    h2.users.findByTenant = async () => {
      throw new Error('users down');
    };
    await h2.run({ tenantId: h2.tenantId, pass: 1 });
    expect(h2.provider.deactivations[0].inactiveMessage).toBe(
      'Acme HVAC collects payment in person. Please settle up when the work is done.',
    );
  });

  it('a malformed payload is dropped without a claim (no retry storm)', async () => {
    const h = await harness();
    await h.addInvoice('open', 'plink_a');
    await h.switchTo('collect_on_site');
    await h.run({ tenantId: 'not-a-uuid', pass: 1 });
    await h.run({ tenantId: h.tenantId, pass: 3 } as unknown as DeactivatePaymentLinksPayload);
    expect(h.provider.calls).toBe(0);
    expect(h.audit.getAll().filter((e) => e.eventType.startsWith('payment_links.'))).toEqual([]);
  });
});
