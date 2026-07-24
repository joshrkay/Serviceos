/**
 * Docker-gated integration test for T4-F01's customer-message-delivery
 * claim-before-send gate — proves the interplay between the real
 * `send_claims` table and the real `message_dispatches` table (both keyed by
 * the same idempotency string) for both channels. A mocked-Pool unit test
 * (test/notifications/customer-message-delivery.test.ts) cannot prove the
 * real-Postgres interaction between the two tables.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import { sendCustomerMessage } from '../../src/notifications/customer-message-delivery';
import type { Customer } from '../../src/customers/customer';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function makeCustomer(tenantId: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: 'Sam',
    lastName: 'Lee',
    displayName: 'Sam Lee',
    primaryPhone: '+15559876543',
    email: 'sam@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('sendCustomerMessage (integration) — claim-before-send against real Postgres', () => {
  let pool: Pool;
  let dispatchRepo: PgDispatchRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    dispatchRepo = new PgDispatchRepository(pool);
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('happy path: sends once and writes one real message_dispatches row per channel', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();
    const customer = makeCustomer(tenantId);
    const entityId = crypto.randomUUID();
    const prefix = `estimate:${entityId}:send`;

    await sendCustomerMessage(
      { delivery, dispatchRepo, pool, logger },
      {
        tenantId,
        customer,
        entityType: 'estimate',
        entityId,
        channels: ['sms', 'email'],
        smsBody: 'Your estimate is ready',
        emailSubject: 'Estimate ready',
        emailText: 'Your estimate is ready',
        idempotencyKeyPrefix: prefix,
      },
    );

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentEmails).toHaveLength(1);
    const rows = await dispatchRepo.findByEntity(tenantId, 'estimate', entityId);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([`${prefix}:email`, `${prefix}:sms`]);

    const claimRows = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = ANY($2)`,
      [tenantId, [`${prefix}:sms`, `${prefix}:email`]],
    );
    expect(claimRows.rows.every((r) => r.status === 'sent')).toBe(true);
  });

  it('crash-between-claim-and-send recovery: a stale claim is reclaimed and the dispatch row is written', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();
    const customer = makeCustomer(tenantId);
    const entityId = crypto.randomUUID();
    const prefix = `estimate:${entityId}:send`;
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenantId, `${prefix}:sms`],
    );

    await sendCustomerMessage(
      { delivery, dispatchRepo, pool, logger },
      {
        tenantId,
        customer,
        entityType: 'estimate',
        entityId,
        channels: ['sms'],
        smsBody: 'Your estimate is ready',
        idempotencyKeyPrefix: prefix,
      },
    );

    expect(delivery.sentSms).toHaveLength(1);
    const rows = await dispatchRepo.findByEntity(tenantId, 'estimate', entityId);
    expect(rows).toHaveLength(1);
  });

  it('crash-between-send-and-mark: a "sent" claim with no dispatch row is NOT resent', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();
    const customer = makeCustomer(tenantId);
    const entityId = crypto.randomUUID();
    const prefix = `estimate:${entityId}:send`;
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, $2, 'sent', NOW(), NOW())`,
      [tenantId, `${prefix}:sms`],
    );

    await sendCustomerMessage(
      { delivery, dispatchRepo, pool, logger },
      {
        tenantId,
        customer,
        entityType: 'estimate',
        entityId,
        channels: ['sms'],
        smsBody: 'Your estimate is ready',
        idempotencyKeyPrefix: prefix,
      },
    );

    expect(delivery.sentSms).toHaveLength(0);
    expect(await dispatchRepo.findByEntity(tenantId, 'estimate', entityId)).toHaveLength(0);
  });

  it('two concurrent calls with the same idempotencyKeyPrefix: exactly one send, one real dispatch row', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();
    const customer = makeCustomer(tenantId);
    const entityId = crypto.randomUUID();
    const prefix = `estimate:${entityId}:send`;
    const send = () =>
      sendCustomerMessage(
        { delivery, dispatchRepo, pool, logger },
        {
          tenantId,
          customer,
          entityType: 'estimate',
          entityId,
          channels: ['sms'],
          smsBody: 'Your estimate is ready',
          idempotencyKeyPrefix: prefix,
        },
      );

    await Promise.all([send(), send()]);
    expect(delivery.sentSms).toHaveLength(1);
    expect(await dispatchRepo.findByEntity(tenantId, 'estimate', entityId)).toHaveLength(1);
  });

  it('a genuine provider error releases the claim and logs a warn, but never throws', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();
    vi.spyOn(delivery, 'sendSms').mockRejectedValueOnce(new Error('Twilio 500'));
    const customer = makeCustomer(tenantId);
    const entityId = crypto.randomUUID();
    const prefix = `estimate:${entityId}:send`;
    const warn = vi.fn();
    const spyLogger = { ...logger, warn };

    await expect(
      sendCustomerMessage(
        { delivery, dispatchRepo, pool, logger: spyLogger },
        {
          tenantId,
          customer,
          entityType: 'estimate',
          entityId,
          channels: ['sms'],
          smsBody: 'Your estimate is ready',
          idempotencyKeyPrefix: prefix,
        },
      ),
    ).resolves.toEqual({ eligibilitySuppressed: false });

    expect(warn).toHaveBeenCalled();
    expect(await dispatchRepo.findByEntity(tenantId, 'estimate', entityId)).toHaveLength(0);

    // Claim released — an immediate retry succeeds.
    await sendCustomerMessage(
      { delivery, dispatchRepo, pool, logger },
      {
        tenantId,
        customer,
        entityType: 'estimate',
        entityId,
        channels: ['sms'],
        smsBody: 'Your estimate is ready',
        idempotencyKeyPrefix: prefix,
      },
    );
    expect(delivery.sentSms).toHaveLength(1);
  });
});
