import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgTagRepository } from '../../src/customers/pg-tag';
import { PgCampaignRepository } from '../../src/marketing/pg-campaign';
import { createCampaign, sendCampaign } from '../../src/marketing/campaign';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import type { Customer } from '../../src/customers/customer';

function customer(tenantId: string, userId: string, email: string | undefined): Customer {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId,
    firstName: 'Pat',
    lastName: 'Property',
    displayName: 'Pat Property',
    preferredChannel: 'email',
    smsConsent: false,
    email,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Postgres integration — marketing campaigns (migration 226)', () => {
  let pool: Pool;
  let repo: PgCampaignRepository;
  let customers: PgCustomerRepository;
  let tags: PgTagRepository;
  let tenant: { tenantId: string; userId: string };
  let sentTo: string[];
  let delivery: MessageDeliveryProvider;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCampaignRepository(pool);
    customers = new PgCustomerRepository(pool);
    tags = new PgTagRepository(pool);
    tenant = await createTestTenant(pool);
    sentTo = [];
    delivery = {
      sendSms: async () => ({ providerMessageId: 's', provider: 'test', channel: 'sms' as const }),
      sendEmail: async (m) => {
        sentTo.push(m.to);
        return { providerMessageId: 'e', provider: 'test', channel: 'email' as const };
      },
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a campaign and sends it to the resolved segment, recording counts', async () => {
    const a = await customers.create(customer(tenant.tenantId, tenant.userId, 'a@x.com'));
    const b = await customers.create(customer(tenant.tenantId, tenant.userId, 'b@x.com'));
    await customers.create(customer(tenant.tenantId, tenant.userId, undefined)); // no email
    await tags.addTag(tenant.tenantId, a.id, 'vip');
    await tags.addTag(tenant.tenantId, b.id, 'vip');

    const campaign = await createCampaign(
      {
        tenantId: tenant.tenantId,
        name: 'Spring promo',
        subject: '20% off tune-ups',
        bodyText: 'Book now',
        segmentTag: 'vip',
        createdBy: tenant.userId,
      },
      repo,
    );

    const { rows } = await pool.query(
      `SELECT tenant_id, name, subject, segment_tag, status FROM marketing_campaigns WHERE id = $1`,
      [campaign.id],
    );
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].subject).toBe('20% off tune-ups');
    expect(rows[0].segment_tag).toBe('vip');
    expect(rows[0].status).toBe('draft');

    const sent = await sendCampaign(
      tenant.tenantId,
      campaign.id,
      { campaignRepo: repo, customerRepo: customers, tagRepo: tags, delivery },
      tenant.userId,
    );
    expect(sent.status).toBe('sent');
    expect(sent.recipientCount).toBe(2);
    expect(sent.sentCount).toBe(2);
    expect(sentTo.sort()).toEqual(['a@x.com', 'b@x.com']);

    const reloaded = await repo.findById(tenant.tenantId, campaign.id);
    expect(reloaded?.status).toBe('sent');
    expect(reloaded?.sentAt).toBeInstanceOf(Date);
  });

  it('does not leak campaigns across tenants (RLS)', async () => {
    const campaign = await createCampaign(
      {
        tenantId: tenant.tenantId,
        name: 'Secret',
        subject: 'Hi',
        bodyText: 'Body',
        createdBy: tenant.userId,
      },
      repo,
    );
    const other = await createTestTenant(pool);
    expect(await repo.findById(other.tenantId, campaign.id)).toBeNull();
    expect(await repo.list(other.tenantId)).toEqual([]);
  });
});
