/**
 * Postgres integration — outbound messaging (D-045) against real tables.
 *
 * The unit test (`test/notifications/outbound-messaging.test.ts`) runs without
 * a pool. This pins the two things only a real database proves: the customer
 * read (real `customers` columns for phone and consent) and the dedupe claim
 * in `send_claims` — a second send under the same key reports the first one
 * instead of texting again, and a blocked or failed send leaves the key free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { createLogger } from '../../src/logging/logger';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createOutboundMessaging } from '../../src/notifications/outbound-messaging';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

describe('Postgres integration — outbound messaging', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  async function seedCustomer(tenant: { tenantId: string; userId: string }, smsConsent: boolean) {
    const customerId = crypto.randomUUID();
    const phone = `+1555${customerId.replace(/-/g, '').replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`;
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
         primary_phone, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1,$2,'Mary','Johnson','Mary Johnson',$3,'sms',$4,false,$5)`,
      [customerId, tenant.tenantId, phone, smsConsent, tenant.userId],
    );
    return { customerId, phone };
  }

  function build(delivery = new InMemoryDeliveryProvider()) {
    const messaging = createOutboundMessaging({
      delivery,
      customerRepo: new PgCustomerRepository(pool),
      dncRepo: new PgDncRepository(pool),
      consentLedger: new PgConsentEventRepository(pool),
      pool,
      logger,
    });
    return { messaging, delivery };
  }

  it('sends once per dedupe key, reading phone and consent from the customer row', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId, phone } = await seedCustomer(tenant, true);
    const { messaging, delivery } = build();
    const text = {
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer' as const, customerId },
      purpose: 'transactional' as const,
      dedupe: { messageKind: 'om_test', recordId: customerId },
      body: 'Your tech is on the way',
    };

    const first = await messaging.sendText(text);
    const second = await messaging.sendText(text);

    expect(first.status).toBe('sent');
    expect(second).toEqual({ status: 'sent', duplicate: 'sent' });
    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0]).toMatchObject({
      to: phone,
      consent: { smsConsent: true, customerId },
      idempotencyKey: `om_test:${customerId}`,
    });
    const claim = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `om_test:${customerId}`],
    );
    expect(claim.rows[0].status).toBe('sent');
  });

  it('a blocked nudge spends no claim, so the same key can send once consent is given', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId } = await seedCustomer(tenant, false);
    const { messaging, delivery } = build();
    const text = {
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer' as const, customerId },
      purpose: 'automated_nudge' as const,
      dedupe: { messageKind: 'om_nudge', recordId: customerId },
      body: 'Thanks for choosing us',
    };

    expect(await messaging.sendText(text)).toEqual({
      status: 'blocked',
      reason: 'no_consent',
      permanent: true,
    });
    await pool.query(`UPDATE customers SET sms_consent = true WHERE id = $1`, [customerId]);
    expect((await messaging.sendText(text)).status).toBe('sent');
    expect(delivery.sentSms).toHaveLength(1);
  });

  it('marketing needs a marketing grant in the real consent ledger', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId, phone } = await seedCustomer(tenant, true);
    const { messaging, delivery } = build();
    const text = {
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer' as const, customerId },
      purpose: 'marketing' as const,
      dedupe: { messageKind: 'om_marketing', recordId: customerId },
      body: 'Fall tune-up special',
    };

    expect(await messaging.sendText(text)).toEqual({
      status: 'blocked',
      reason: 'no_marketing_consent',
      permanent: true,
    });
    await new PgConsentEventRepository(pool).append({
      tenantId: tenant.tenantId,
      customerId,
      phone,
      kind: 'marketing',
      state: 'granted',
      source: 'portal',
    });
    expect((await messaging.sendText(text)).status).toBe('sent');
    expect(delivery.sentSms).toHaveLength(1);
  });

  it('a key another attempt still holds is a retryable block, never reported as sent', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId } = await seedCustomer(tenant, true);
    const { messaging, delivery } = build();
    // Another process claimed this key a moment ago and has not finished.
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'sending', NOW())`,
      [tenant.tenantId, `om_inflight:${customerId}`],
    );

    const outcome = await messaging.sendText({
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer', customerId },
      purpose: 'transactional',
      dedupe: { messageKind: 'om_inflight', recordId: customerId },
      body: 'Your tech is on the way',
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'in_flight', permanent: false });
    expect(delivery.sentSms).toHaveLength(0);
  });

  it('an already-sent key reports sent even after the customer is gone', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId } = await seedCustomer(tenant, true);
    const { messaging, delivery } = build();
    const text = {
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer' as const, customerId },
      purpose: 'automated_nudge' as const,
      dedupe: { messageKind: 'om_resent', recordId: customerId },
      body: 'Thanks for choosing us',
    };

    expect((await messaging.sendText(text)).status).toBe('sent');
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);

    expect(await messaging.sendText(text)).toEqual({ status: 'sent', duplicate: 'sent' });
    expect(delivery.sentSms).toHaveLength(1);
  });

  it('the claim stays reclaimable until the gate reaches the provider', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId } = await seedCustomer(tenant, true);
    const claimKey = `om_boundary:${customerId}`;
    const statuses: string[] = [];
    const readStatus = async () =>
      (
        await pool.query(`SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`, [
          tenant.tenantId,
          claimKey,
        ])
      ).rows[0].status as string;
    const inner = new InMemoryDeliveryProvider();
    // Stands in for the gate: its policy reads happen first, then the hook.
    const gateLike = {
      sendSms: async (m: Parameters<InMemoryDeliveryProvider['sendSms']>[0]) => {
        statuses.push(await readStatus());
        await m.onProviderStarting?.();
        statuses.push(await readStatus());
        return inner.sendSms(m);
      },
      sendEmail: inner.sendEmail.bind(inner),
    };
    const { messaging } = build(gateLike as unknown as InMemoryDeliveryProvider);

    const outcome = await messaging.sendText({
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer', customerId },
      purpose: 'transactional',
      dedupe: { messageKind: 'om_boundary', recordId: customerId },
      body: 'Your tech is on the way',
    });

    expect(outcome.status).toBe('sent');
    expect(statuses).toEqual(['claimed', 'sending']);
    expect(await readStatus()).toBe('sent');
  });

  it('a provider failure releases the claim so a retry sends', async () => {
    const tenant = await createTestTenant(pool);
    const { customerId } = await seedCustomer(tenant, true);
    const delivery = new InMemoryDeliveryProvider();
    let failNext = true;
    const flaky = {
      sendSms: async (m: Parameters<InMemoryDeliveryProvider['sendSms']>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('Twilio 503');
        }
        return delivery.sendSms(m);
      },
      sendEmail: delivery.sendEmail.bind(delivery),
    };
    const { messaging } = build(flaky as unknown as InMemoryDeliveryProvider);
    const text = {
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer' as const, customerId },
      purpose: 'transactional' as const,
      dedupe: { messageKind: 'om_retry', recordId: customerId },
      body: 'Invoice ready',
    };

    expect(await messaging.sendText(text)).toMatchObject({
      status: 'blocked',
      reason: 'send_failed',
      permanent: false,
    });
    expect((await messaging.sendText(text)).status).toBe('sent');
    expect(delivery.sentSms).toHaveLength(1);
  });
});
