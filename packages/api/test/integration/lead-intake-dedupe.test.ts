/**
 * #1406 D1 — repeat lead intake with the same phone (real Postgres).
 *
 * `idx_leads_phone_unique_open` (migration 058) keeps (tenant_id,
 * phone_normalized) unique while converted_customer_id IS NULL. Before the
 * fix, a second submission with that phone raised an unhandled 23505 and
 * the public intake form showed "Submission failed (500)"; a LOST lead
 * (still unconverted) blocked every future lead with its number.
 *
 * Seam: `createLead` (lead-service) against PgLeadRepository.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { captureLead, createLead, loseLead } from '../../src/leads/lead-service';

describe('Postgres integration — repeat lead intake (#1406 D1)', () => {
  let pool: Pool;
  let repo: PgLeadRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgLeadRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('attaches a repeat submission to the existing open lead instead of failing', async () => {
    const first = await createLead(
      {
        tenantId: tenant.tenantId,
        firstName: 'Rita',
        primaryPhone: '(602) 555-0141',
        source: 'web_form',
        notes: 'Leaky faucet',
        createdBy: tenant.userId,
      },
      repo,
    );

    const second = await createLead(
      {
        tenantId: tenant.tenantId,
        firstName: 'Rita',
        primaryPhone: '+1 602-555-0141',
        email: 'rita@example.com',
        source: 'web_form',
        notes: 'Also the water heater',
        createdBy: tenant.userId,
      },
      repo,
    );

    expect(second.id).toBe(first.id);
    expect(second.stage).toBe('new');
    expect(second.email).toBe('rita@example.com');
    expect(second.notes).toContain('Leaky faucet');
    expect(second.notes).toContain('Also the water heater');
  });

  it('a lost lead does not block a new inquiry from the same phone — it is revived', async () => {
    const lost = await createLead(
      {
        tenantId: tenant.tenantId,
        firstName: 'Omar',
        primaryPhone: '480-555-0177',
        source: 'web_form',
        createdBy: tenant.userId,
      },
      repo,
    );
    await loseLead(tenant.tenantId, lost.id, 'went with a competitor', repo, tenant.userId, 'owner');

    const result = await captureLead(
      {
        tenantId: tenant.tenantId,
        firstName: 'Omar',
        primaryPhone: '4805550177',
        source: 'web_form',
        notes: 'Back again — AC out',
        createdBy: tenant.userId,
      },
      repo,
    );

    expect(result.outcome).toBe('reopened');
    expect(result.lead.id).toBe(lost.id);
    expect(result.lead.stage).toBe('new');
    expect(result.lead.lostReason).toBeUndefined();
    expect(result.lead.notes).toContain('Back again — AC out');
  });
});
