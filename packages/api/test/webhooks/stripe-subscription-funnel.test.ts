/**
 * Stripe `customer.subscription.*` → PostHog `trial_to_paid` funnel event
 * (src/webhooks/routes.ts).
 *
 * `trial_to_paid` is the funnel's CONVERSION step: a tenant's first paid
 * period. A card-required trial whose first charge fails never goes
 * trialing → active; it goes trialing → past_due → active (or → unpaid →
 * active), so the conversion has to be counted on that recovery too — exactly
 * once, and never again for a later renewal failure + recovery.
 *
 * The Stripe router, the in-memory receipt writer (with its real payload
 * minimization) and the PostHog capture path all run for real. The pool is a
 * small stateful fake of the two things the handler touches — the tenants row
 * and the `webhook_events` receipts — so a list of statuses behaves like a
 * series of Stripe deliveries. The fake's receipt predicate restates the
 * handler's SQL in JS; the SQL itself is pinned against real Postgres in
 * test/integration/stripe-subscription-funnel.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import {
  createWebhookSignature,
  InMemoryWebhookRepository,
  type WebhookEvent,
} from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { capturePostHog } from '../helpers/posthog-capture';

const SECRET = 'whsec_test_sub_funnel';
const TENANT = '44444444-4444-4444-4444-444444444444';
const OWNER = 'user_funnel_owner';
const CUSTOMER = 'cus_funnel_1';
const SUBSCRIPTION = 'sub_funnel_1';

/** The in-memory receipt writer, plus a view of what it stored. */
class RecordingWebhookRepository extends InMemoryWebhookRepository {
  readonly receipts: WebhookEvent[] = [];

  override async create(event: WebhookEvent): Promise<WebhookEvent> {
    const stored = await super.create(event);
    this.receipts.push(stored);
    return stored;
  }
}

type SubscriptionEventType = 'customer.subscription.created' | 'customer.subscription.updated';

describe('Stripe subscription → trial_to_paid funnel event', () => {
  let app: express.Express;
  let receipts: RecordingWebhookRepository;
  let posthog: ReturnType<typeof capturePostHog>;

  beforeEach(() => {
    posthog = capturePostHog();
    receipts = new RecordingWebhookRepository();
    const tenant: { status: string | null } = { status: null };

    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      // "Has this subscription already been reported active, by an event other
      // than the one being handled?" Params: [subscriptionId, currentReceiptId].
      if (/FROM webhook_events/.test(sql)) {
        const [subscriptionId, currentReceiptId] = params;
        const rows = receipts.receipts.filter((r) => {
          const object = r.payload.object as { id?: string; status?: string } | undefined;
          return (
            r.source === 'stripe' &&
            r.id !== currentReceiptId &&
            r.eventType.startsWith('customer.subscription.') &&
            object?.id === subscriptionId &&
            object?.status === 'active'
          );
        });
        return { rowCount: rows.length, rows: rows.map(() => ({ paid_before: 1 })) };
      }
      // The tenant read (by metadata id or by customer id), under FOR UPDATE.
      if (/FROM tenants/.test(sql) && /FOR UPDATE/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: TENANT,
              owner_id: OWNER,
              subscription_status: tenant.status,
              stripe_customer_id: CUSTOMER,
            },
          ],
        };
      }
      // The status mirror: $2 is the subscription status.
      if (/UPDATE tenants/.test(sql) && /subscription_status = \$2/.test(sql)) {
        tenant.status = params[1] as string;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    };
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        billingService: { applySubscriptionEvent: vi.fn(async () => undefined) } as never,
        pool: pool as never,
        webhookRepo: receipts,
        auditRepo: new InMemoryAuditRepository(),
        stripeWebhookSecret: SECRET,
      }),
    );
  });

  afterEach(() => {
    posthog.restore();
    vi.restoreAllMocks();
  });

  async function deliver(type: SubscriptionEventType, status: string): Promise<void> {
    const rawBody = JSON.stringify({
      id: `evt_${uuidv4()}`,
      type,
      data: { object: { id: SUBSCRIPTION, customer: CUSTOMER, status } },
    });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(rawBody, SECRET))
      .set('content-type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(200);
  }

  /** Deliver the statuses in order: `created` for the first, `updated` after. */
  async function deliverStatuses(statuses: string[]): Promise<void> {
    for (const [i, status] of statuses.entries()) {
      await deliver(
        i === 0 ? 'customer.subscription.created' : 'customer.subscription.updated',
        status,
      );
    }
  }

  const conversions = () => posthog.events().filter((e) => e.event === 'trial_to_paid');

  it('counts a trial whose first charge failed (trialing → past_due → active) as converted, once', async () => {
    await deliverStatuses(['trialing', 'past_due', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0]).toMatchObject({
      distinctId: OWNER,
      properties: expect.objectContaining({
        tenantId: TENANT,
        subscriptionId: SUBSCRIPTION,
        newStatus: 'active',
        from_status: 'past_due',
      }),
    });
  });

  it('still counts a clean conversion (trialing → active) once, now tagged from_status trialing', async () => {
    await deliverStatuses(['trialing', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0]).toMatchObject({
      distinctId: OWNER,
      properties: expect.objectContaining({
        priorStatus: 'trialing',
        newStatus: 'active',
        from_status: 'trialing',
      }),
    });
  });

  it('does not count a later renewal failure and recovery (active → past_due → active) again', async () => {
    await deliverStatuses(['trialing', 'active', 'past_due', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].properties.from_status).toBe('trialing');
  });

  it('counts the recovery conversion once even when the card fails again on a later renewal', async () => {
    await deliverStatuses(['trialing', 'past_due', 'active', 'past_due', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].properties.from_status).toBe('past_due');
  });

  it('counts a trial that went past_due → unpaid before the card recovered (unpaid → active)', async () => {
    await deliverStatuses(['trialing', 'past_due', 'unpaid', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].properties.from_status).toBe('unpaid');
  });

  it('does not count a tenant that was already paid when it recovers from unpaid (unpaid → active)', async () => {
    await deliverStatuses(['trialing', 'active', 'past_due', 'unpaid', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].properties.from_status).toBe('trialing');
  });

  it('counts a subscription whose first payment went through after incomplete (incomplete → active)', async () => {
    await deliverStatuses(['incomplete', 'active']);

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].properties.from_status).toBe('incomplete');
  });

  it('emits no conversion while the subscription is still failing to pay', async () => {
    await deliverStatuses(['trialing', 'past_due', 'unpaid']);

    expect(conversions()).toHaveLength(0);
  });

  it('keeps the receipt fields the paid-before check reads (subscription id and status)', async () => {
    await deliver('customer.subscription.updated', 'active');

    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0].payload).toMatchObject({
      object: { id: SUBSCRIPTION, status: 'active' },
    });
  });
});
