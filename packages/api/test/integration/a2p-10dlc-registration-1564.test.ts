/**
 * #1564 — the A2P 10DLC registration store at real Postgres
 * (`a2p_registrations`).
 *
 * Seams: the registration service (submit / view) over PgA2pRegistrationStore,
 * and the store's progress write the worker uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgA2pRegistrationStore } from '../../src/integrations/twilio/a2p-10dlc/pg-store';
import { createA2pRegistrationService } from '../../src/integrations/twilio/a2p-10dlc/service';
import { InMemoryQueue } from '../../src/queues/queue';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { A2pBusinessDetails } from '../../src/integrations/twilio/a2p-10dlc/registration';
import {
  createPgTenantMessagingResolver,
  createPgA2pIntegrationMirror,
} from '../../src/workers/a2p-10dlc-registration';
import { encrypt } from '../../src/integrations/crypto';

const KEY = 'a'.repeat(64);

const details: A2pBusinessDetails = {
  legalBusinessName: 'Acme Plumbing LLC',
  ein: '123456789',
  businessType: 'Limited Liability Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: 'https://acme-plumbing.example.com',
  address: { street: '1 Main St', street2: 'Suite 2', city: 'Austin', region: 'TX', postalCode: '78701' },
  contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+15125550100', title: 'Owner', jobPosition: 'CEO' },
};

describe('Postgres integration — A2P 10DLC registration store (#1564)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function service() {
    return createA2pRegistrationService({
      store: new PgA2pRegistrationStore(pool),
      queue: new InMemoryQueue(),
      auditRepo: new InMemoryAuditRepository(),
      encryptionKey: KEY,
    });
  }

  it('persists a submission and reads it back with only the EIN last four', async () => {
    const { tenantId, userId } = await createTestTenant(pool);

    await service().submit(tenantId, { userId, role: 'owner' }, details);
    const view = await service().view(tenantId);

    expect(view.status).toBe('submitted');
    expect(view.readiness).toBe('partial_readiness');
    expect(view.details).toEqual({
      legalBusinessName: 'Acme Plumbing LLC',
      einLast4: '6789',
      businessType: 'Limited Liability Corporation',
      businessIndustry: 'CONSTRUCTION',
      websiteUrl: 'https://acme-plumbing.example.com',
      address: { street: '1 Main St', street2: 'Suite 2', city: 'Austin', region: 'TX', postalCode: '78701' },
      contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+15125550100', title: 'Owner', jobPosition: 'CEO' },
    });
    expect(JSON.stringify(view)).not.toContain('123456789');
  });

  // Spec ("EIN stored encrypted"): the at-rest column must not hold the EIN.
  it('stores the EIN encrypted at rest', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    await service().submit(tenantId, { userId, role: 'owner' }, details);

    const { rows } = await pool.query(`SELECT * FROM a2p_registrations WHERE tenant_id = $1`, [tenantId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('123456789');
  });

  it('records progress, failure reasons and the approval time the worker writes', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    await service().submit(tenantId, { userId, role: 'owner' }, details);
    const store = new PgA2pRegistrationStore(pool);

    await store.saveProgress(tenantId, {
      status: 'failed',
      refs: { customerProfileSid: 'BUx', brandSid: 'BNx' },
      failureReasons: ['Legal business name does not match the EIN on file.'],
    });
    const failed = await store.get(tenantId);
    expect(failed?.progress).toEqual({
      status: 'failed',
      refs: { customerProfileSid: 'BUx', brandSid: 'BNx' },
      failureReasons: ['Legal business name does not match the EIN on file.'],
    });
    expect(failed?.approvedAt).toBeNull();

    await store.saveProgress(tenantId, { status: 'approved', refs: { brandSid: 'BNx', campaignSid: 'QEx' }, failureReasons: [] });
    const view = await service().view(tenantId);
    expect(view.status).toBe('approved');
    expect(view.readiness).toBe('full_readiness');
    expect(view.approvedAt).not.toBeNull();
  });

  it('keeps one tenant from reading another tenant\'s registration', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    await service().submit(a.tenantId, { userId: a.userId, role: 'owner' }, details);

    expect((await service().view(b.tenantId)).status).toBe('not_started');
  });

  it('resolves the tenant subaccount creds + Messaging Service the worker registers with', async () => {
    const { tenantId } = await createTestTenant(pool);
    const resolve = createPgTenantMessagingResolver(pool, KEY);
    expect(await resolve(tenantId)).toBeNull();

    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, subaccount_sid, auth_token_primary_enc, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', 'ACsub1564', $2, $3::jsonb)`,
      [tenantId, encrypt('subtoken', KEY), JSON.stringify({ messagingServiceSid: 'MG1564' })],
    );

    expect(await resolve(tenantId)).toEqual({
      creds: { accountSid: 'ACsub1564', authToken: 'subtoken' },
      messagingServiceSid: 'MG1564',
    });
  });

  it('treats the non-production stub integration (no subaccount) as not ready', async () => {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', '{"stub": true, "phoneE164": "+15005550006"}'::jsonb)`,
      [tenantId],
    );
    expect(await createPgTenantMessagingResolver(pool, KEY)(tenantId)).toBeNull();
  });

  it('mirrors the registration status onto the phone integration without touching its readiness', async () => {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, subaccount_sid, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', 'ACsub', '{"messagingServiceSid": "MGx"}'::jsonb)`,
      [tenantId],
    );

    await createPgA2pIntegrationMirror(pool)(tenantId, {
      status: 'failed',
      refs: { brandSid: 'BNx' },
      failureReasons: ['Website is not reachable.'],
    });

    const { rows } = await pool.query(
      `SELECT status, provider_data FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId],
    );
    expect(rows[0].status).toBe('full_readiness');
    expect(rows[0].provider_data.messagingServiceSid).toBe('MGx');
    expect(rows[0].provider_data.a2p10dlc).toMatchObject({
      status: 'failed',
      brandSid: 'BNx',
      failureReasons: ['Website is not reachable.'],
    });
  });
});
