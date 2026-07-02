/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * P8 — entity resolution against REAL Postgres + pg_trgm. The unit suite
 * (test/ai/resolution/pg-entity-resolver.test.ts) mocks the Pool, which
 * is exactly how the resolver shipped with column names that didn't
 * exist in the schema (name vs display_name, title vs summary). These
 * tests pin the SQL against the real migrations so that can't regress,
 * and exercise the voice-action-router end-to-end: transcript → resolver
 * → verified ID / clarification / pending reference.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

function silentLogger(): Logger {
  const noop = () => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function gatewayReturning(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[i++] ?? responses[responses.length - 1];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: 'msg-1',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

describe('Postgres integration — entity resolution (P8)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let customerRepo: PgCustomerRepository;
  let tenant: TestTenant;
  let other: TestTenant;
  let rodriguezId: string;

  async function seedCustomer(
    tenantId: string,
    displayName: string,
    opts: { phone?: string; archived?: boolean; createdBy: string },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await customerRepo.create({
      id,
      tenantId,
      firstName: displayName.split(' ')[0] ?? displayName,
      lastName: displayName.split(' ').slice(1).join(' '),
      displayName,
      primaryPhone: opts.phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: opts.archived ?? false,
      createdBy: opts.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);

    rodriguezId = await seedCustomer(tenant.tenantId, 'Rodriguez Plumbing LLC', {
      phone: '555-0100',
      createdBy: tenant.userId,
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('exact display_name match resolves with score 1.0', async () => {
    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Rodriguez Plumbing LLC',
      kind: 'customer',
    });
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe(rodriguezId);
      expect(result.candidate.score).toBe(1);
      expect(result.candidate.hint).toBe('555-0100');
    }
  });

  it('transcription typo resolves via trigram similarity', async () => {
    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Rodrigez Plumbing LLC', // missing 'u'
      kind: 'customer',
    });
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe(rodriguezId);
      expect(result.candidate.score).toBeLessThan(1);
      expect(result.candidate.score).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('duplicate display_names → ambiguous with both candidates', async () => {
    const a = await seedCustomer(tenant.tenantId, 'Bob Smith', { createdBy: tenant.userId });
    const b = await seedCustomer(tenant.tenantId, 'Bob Smith', { createdBy: tenant.userId });

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Bob Smith',
      kind: 'customer',
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      const ids = result.candidates.map((c) => c.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    }
  });

  it('unknown reference → not_found with the raw reference', async () => {
    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Zelda Fitzgerald Enterprises',
      kind: 'customer',
    });
    expect(result).toEqual({ kind: 'not_found', reference: 'Zelda Fitzgerald Enterprises' });
  });

  it('never resolves across tenants', async () => {
    const result = await resolver.resolve({
      tenantId: other.tenantId,
      reference: 'Rodriguez Plumbing LLC',
      kind: 'customer',
    });
    expect(result.kind).toBe('not_found');
  });

  it('archived customers are excluded', async () => {
    await seedCustomer(tenant.tenantId, 'Archibald Archived', {
      archived: true,
      createdBy: tenant.userId,
    });
    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Archibald Archived',
      kind: 'customer',
    });
    expect(result.kind).toBe('not_found');
  });

  // U1 — technician kind: pins the REAL users columns (first_name/last_name/
  // role/deleted_at) + the trigram expression migration 230 indexes. The unit
  // suite mocks the Pool, which is exactly how column drift ships (see the
  // header comment), so these assertions run against the live schema.
  describe('technician kind (U1)', () => {
    async function seedUser(
      tenantId: string,
      firstName: string,
      lastName: string,
      role: 'owner' | 'dispatcher' | 'technician',
      opts: { deleted?: boolean } = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          tenantId,
          `clerk-${id}`,
          `${firstName}.${lastName}.${id.slice(0, 8)}@example.com`.toLowerCase(),
          role,
          firstName,
          lastName,
          opts.deleted ? new Date() : null,
        ],
      );
      return id;
    }

    it('exact full-name match resolves with role hint', async () => {
      const carlosId = await seedUser(tenant.tenantId, 'Carlos', 'Rodriguez', 'technician');
      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Carlos Rodriguez',
        kind: 'technician',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(carlosId);
        expect(result.candidate.label).toBe('Carlos Rodriguez');
        expect(result.candidate.hint).toBe('technician');
        expect(result.candidate.score).toBe(1);
      }
    });

    it('transcription typo resolves via trigram similarity', async () => {
      const mikeId = await seedUser(tenant.tenantId, 'Mikhail', 'Petrovsky', 'dispatcher');
      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Mikhail Petrovski', // trailing-vowel typo
        kind: 'technician',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(mikeId);
        expect(result.candidate.score).toBeGreaterThanOrEqual(0.8);
        expect(result.candidate.score).toBeLessThan(1);
      }
    });

    it('two technicians with the same name → ambiguous with both candidates', async () => {
      const a = await seedUser(tenant.tenantId, 'Dana', 'Whitfield', 'technician');
      const b = await seedUser(tenant.tenantId, 'Dana', 'Whitfield', 'dispatcher');
      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Dana Whitfield',
        kind: 'technician',
      });
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        const ids = result.candidates.map((c) => c.id);
        expect(ids).toContain(a);
        expect(ids).toContain(b);
      }
    });

    it('soft-deleted users never resolve', async () => {
      await seedUser(tenant.tenantId, 'Ghost', 'Departed', 'technician', { deleted: true });
      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Ghost Departed',
        kind: 'technician',
      });
      expect(result.kind).toBe('not_found');
    });

    it('never resolves across tenants', async () => {
      await seedUser(tenant.tenantId, 'Priya', 'Natarajan', 'technician');
      const result = await resolver.resolve({
        tenantId: other.tenantId,
        reference: 'Priya Natarajan',
        kind: 'technician',
      });
      expect(result.kind).toBe('not_found');
    });

    it('router end-to-end: spoken technician name lands as a verified toTechnicianId', async () => {
      const felixId = await seedUser(tenant.tenantId, 'Felix', 'Okonkwo', 'technician');
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'reassign_appointment',
          confidence: 0.9,
          extractedEntities: {
            appointmentReference: "Tuesday's Davis job",
            targetTechnicianName: 'Felix Okonkwo',
          },
        }),
      ]);
      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        entityResolver: resolver,
      });

      await worker.handle(
        msg({
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          transcript: "Give Tuesday's Davis job to Felix Okonkwo",
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenant.tenantId);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('reassign_appointment');
      expect(proposals[0].payload.toTechnicianId).toBe(felixId);
    });
  });

  it('resolves jobs by summary (schema column, not the nonexistent title)', async () => {
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: rodriguezId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId: rodriguezId,
      locationId,
      jobNumber: 'JOB-ER-1',
      summary: 'Water heater replacement Rodriguez',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Water heater replacement Rodriguez',
      kind: 'job',
    });
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(jobId);
  });

  describe('voice-action-router end-to-end', () => {
    function classifierJson(customerName: string): string {
      return JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.9,
        extractedEntities: { customerName },
      });
    }

    const invoiceJson = JSON.stringify({
      customerId: '00000000-0000-0000-0000-000000000001',
      jobId: '00000000-0000-0000-0000-000000000002',
      lineItems: [{ description: 'Service call', quantity: 1, unitPrice: 12000 }],
      confidence_score: 0.85,
    });

    it('transcript with a unique name → drafting context carries the verified UUID', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([
        classifierJson('Rodriguez Plumbing LLC'),
        invoiceJson,
      ]);
      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        entityResolver: resolver,
      });

      await worker.handle(
        msg({
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          transcript: 'Draft an invoice for Rodriguez Plumbing for the service call',
        }),
        silentLogger(),
      );

      expect(await proposalRepo.findByTenant(tenant.tenantId)).toHaveLength(1);
      const draftCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(draftCall.messages[1].content).toContain(rodriguezId);
    });

    it('transcript matching duplicate names → voice_clarification with candidates', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([classifierJson('Bob Smith'), invoiceJson]);
      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        entityResolver: resolver,
      });

      await worker.handle(
        msg({
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          transcript: 'Draft an invoice for Bob Smith',
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenant.tenantId);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('voice_clarification');
      const payload = proposals[0].payload as Record<string, unknown>;
      expect(payload.reason).toBe('ambiguous_entity');
      expect((payload.entityCandidates as unknown[]).length).toBeGreaterThanOrEqual(2);
      // Drafting LLM call skipped — classifier only.
      expect(gateway.complete).toHaveBeenCalledTimes(1);
    });

    it('transcript with an unknown name → proposal carries pendingReference', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([
        classifierJson('Zelda Fitzgerald Enterprises'),
        invoiceJson,
      ]);
      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        entityResolver: resolver,
      });

      await worker.handle(
        msg({
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          transcript: 'Draft an invoice for Zelda Fitzgerald Enterprises',
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenant.tenantId);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('draft_invoice');
      const ctx = proposals[0].sourceContext as Record<string, unknown>;
      expect(ctx.pendingReference).toEqual([
        { kind: 'customer', reference: 'Zelda Fitzgerald Enterprises' },
      ]);
    });
  });
});
