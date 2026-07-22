/**
 * Docker-gated integration proof for the operator voice QA fixture runner.
 * Uses real repositories, migrations, pg_trgm resolution, and RLS.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  closeSharedTestDb,
  createTestTenant,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import {
  runOperatorVoiceFixtureSeed,
  type OperatorVoiceFixtureSeedResult,
} from '../../src/seed/operator-voice-fixture-runner';
import { OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX } from '../../src/seed/operator-voice-fixture-plan';

const catalog = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../fixtures/voice/operator-voice-fixture-catalog.json'),
    'utf8',
  ),
);

describe('Postgres integration — operator voice QA fixtures', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let other: TestTenant;
  let carlosId: string;
  let result: OperatorVoiceFixtureSeedResult;
  let resolver: PgEntityResolver;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    await pool.query('UPDATE tenants SET name = $2 WHERE id = $1', [
      tenant.tenantId,
      'Operator Voice QA',
    ]);
    carlosId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (
         id, tenant_id, clerk_user_id, email, role, first_name, last_name
       ) VALUES ($1, $2, $3, $4, 'technician', 'Carlos', '')`,
      [
        carlosId,
        tenant.tenantId,
        `fixture-carlos-${carlosId}`,
        `carlos-${carlosId}@example.com`,
      ],
    );

    result = await runOperatorVoiceFixtureSeed(pool, catalog, {
      qaTenantId: tenant.tenantId,
      qaActorId: tenant.userId,
      targetEnvironment: 'development',
    });
    resolver = new PgEntityResolver(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the exact catalog through production domain/repository paths with provenance audits', async () => {
    expect(result.tenantId).toBe(tenant.tenantId);
    expect(Object.keys(result.records)).toHaveLength(27);

    const expectedCounts: Record<string, number> = {
      customers: 6,
      service_locations: 6,
      jobs: 6,
      estimates: 2,
      invoices: 4,
      appointments: 1,
      leads: 1,
    };
    for (const [table, expected] of Object.entries(expectedCounts)) {
      const count = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(count.rows[0].count, table).toBe(expected);
    }

    const audits = await pool.query<{
      correlation_id: string;
      metadata: { provenance?: string };
      actor_id: string;
      tenant_id: string;
    }>(
      `SELECT tenant_id, actor_id, correlation_id, metadata
         FROM audit_events
        WHERE tenant_id = $1
          AND correlation_id LIKE $2`,
      [tenant.tenantId, `${OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX}%`],
    );
    expect(audits.rows).toHaveLength(27);
    expect(new Set(audits.rows.map((row) => row.correlation_id)).size).toBe(27);
    for (const audit of audits.rows) {
      expect(audit.tenant_id).toBe(tenant.tenantId);
      expect(audit.actor_id).toBe(tenant.userId);
      expect(audit.metadata.provenance).toBe(audit.correlation_id);
    }
  });

  it.each([
    ['Khan', 'customer.khan'],
    ['Johnson', 'customer.johnson'],
    ['Mrs Lee', 'customer.mrs-lee'],
    ['Garcia', 'customer.garcia'],
  ])('resolves the supported surname/customer reference %s', async (reference, key) => {
    const resolved = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference,
      kind: 'customer',
    });
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind === 'resolved') {
      expect(resolved.candidate.id).toBe(result.records[key].id);
    }
  });

  it('keeps Smith ambiguous with exactly the two catalog customers', async () => {
    const resolved = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Smith',
      kind: 'customer',
    });
    expect(resolved.kind).toBe('ambiguous');
    if (resolved.kind === 'ambiguous') {
      expect(new Set(resolved.candidates.map((candidate) => candidate.id))).toEqual(
        new Set([
          result.records['customer.smith-a'].id,
          result.records['customer.smith-b'].id,
        ]),
      );
    }
  });

  it('resolves INV-0042 and Carlos through the real PgEntityResolver', async () => {
    const invoice = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'INV-0042',
      kind: 'invoice',
    });
    expect(invoice.kind).toBe('resolved');
    if (invoice.kind === 'resolved') {
      expect(invoice.candidate.id).toBe(result.records['invoice.johnson'].id);
    }

    const technician = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Carlos',
      kind: 'technician',
    });
    expect(technician.kind).toBe('resolved');
    if (technician.kind === 'resolved') {
      expect(technician.candidate.id).toBe(carlosId);
      expect(technician.candidate.id).toBe(result.records['technician.carlos'].id);
    }
  });

  it('resolves the Garcia appointment by its real Tuesday UTC date', async () => {
    const appointment = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: '2026-07-28',
      kind: 'appointment',
    });
    expect(appointment.kind).toBe('resolved');
    if (appointment.kind === 'resolved') {
      expect(appointment.candidate.id).toBe(result.records['appointment.garcia-tuesday'].id);
      expect(new Date(appointment.candidate.label).getUTCDay()).toBe(2);
    }
  });

  it('pins EST-0042 and Greenfield while documenting unsupported resolver kinds', async () => {
    const estimateRepo = new PgEstimateRepository(pool);
    const estimates = await estimateRepo.findByTenant(tenant.tenantId, { search: 'EST-0042' });
    expect(estimates).toHaveLength(1);
    expect(estimates[0].id).toBe(result.records['estimate.explicit-0042'].id);

    const estimateResolution = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'EST-0042',
      kind: 'estimate',
    });
    expect(estimateResolution.kind).toBe('resolved');
    if (estimateResolution.kind === 'resolved') {
      expect(estimateResolution.candidate.id).toBe(result.records['estimate.explicit-0042'].id);
    }

    const leadRepo = new PgLeadRepository(pool);
    const leads = await leadRepo.findByTenant(tenant.tenantId);
    expect(leads).toEqual([
      expect.objectContaining({
        id: result.records['lead.greenfield'].id,
        companyName: 'Greenfield Property Management',
      }),
    ]);
  });

  it('denies cross-tenant repository, resolver, actor, and RLS reads', async () => {
    const customerRepo = new PgCustomerRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    expect(
      await customerRepo.findById(other.tenantId, result.records['customer.khan'].id),
    ).toBeNull();
    expect(
      await invoiceRepo.findById(other.tenantId, result.records['invoice.johnson'].id),
    ).toBeNull();
    expect(
      await resolver.resolve({
        tenantId: other.tenantId,
        reference: 'Khan',
        kind: 'customer',
      }),
    ).toEqual({ kind: 'not_found', reference: 'Khan' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rls_app_runtime');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
        other.tenantId,
      ]);
      const denied = await client.query('SELECT id FROM customers WHERE id = $1', [
        result.records['customer.khan'].id,
      ]);
      expect(denied.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    await expect(
      runOperatorVoiceFixtureSeed(pool, catalog, {
        qaTenantId: tenant.tenantId,
        qaActorId: other.userId,
        targetEnvironment: 'development',
      }),
    ).rejects.toThrow(/actor.*tenant/i);
  });
});
