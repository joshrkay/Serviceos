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
import { DateTime } from 'luxon';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { TAU_ENT, TAU_ENT_CONFIRM_LOW } from '../../src/ai/resolution/entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { createEstimate } from '../../src/estimates/estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { createInvoice } from '../../src/invoices/invoice';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { buildLineItem } from '../../src/shared/billing-engine';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { assignTechnician } from '../../src/appointments/assignment';
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

    // Each test below uses a FRESH tenant (not the file-shared `tenant`,
    // which already carries a 'Carlos Rodriguez' seeded by the exact-match
    // test above) — otherwise a "Carlos" reference would pick up that
    // earlier row too and every assertion here would be testing tenant
    // contamination, not the scoring expression.

    // 7fbff6e added TECH_SCORE_EXPR's strict_word_similarity variant so a
    // FIRST-NAME-ONLY reference ("assign CARLOS", not "assign Carlos Vega")
    // resolves — real Postgres, real pg_trgm, since a mocked Pool cannot
    // prove a scoring expression scores anything.
    it('a FIRST-NAME-ONLY reference resolves against a full name (7fbff6e)', async () => {
      const t = await createTestTenant(pool);
      const carlosId = await seedUser(t.tenantId, 'Carlos', 'Vega', 'technician');
      const result = await resolver.resolve({
        tenantId: t.tenantId,
        reference: 'Carlos',
        kind: 'technician',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(carlosId);
        expect(result.candidate.score).toBe(1);
      }
    });

    // The other side of the same fix: `strict_word_similarity` must not go
    // so loose that a PARTIAL first name also resolves — 'carl' scores 0.500
    // against 'Carlos Vega' (per 7fbff6e's commit message), under
    // TAU_ENT_CONFIRM_LOW (0.6), so this must stay not_found rather than
    // guessing at a name the caller didn't finish saying.
    it('a PARTIAL first name stays below the floor and does not resolve', async () => {
      const t = await createTestTenant(pool);
      await seedUser(t.tenantId, 'Carlos', 'Vega', 'technician');
      const result = await resolver.resolve({
        tenantId: t.tenantId,
        reference: 'carl',
        kind: 'technician',
      });
      expect(result.kind).toBe('not_found');
    });

    // Two technicians who share only a FIRST name (not a full-name
    // duplicate, see "two technicians with the same name" above) must
    // become ambiguous, never a guess at which Carlos the caller meant.
    it('two technicians sharing only a FIRST name → ambiguous, never a guess', async () => {
      const t = await createTestTenant(pool);
      const carlosVega = await seedUser(t.tenantId, 'Carlos', 'Vega', 'technician');
      const carlosMendoza = await seedUser(t.tenantId, 'Carlos', 'Mendoza', 'dispatcher');
      const result = await resolver.resolve({
        tenantId: t.tenantId,
        reference: 'Carlos',
        kind: 'technician',
      });
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        const ids = result.candidates.map((c) => c.id);
        expect(ids).toContain(carlosVega);
        expect(ids).toContain(carlosMendoza);
      }
    });

    // The overflow guard `resolveTechnician` now shares with `resolveJob` /
    // `resolveEstimate`: since a shared first name scores every matching
    // technician at 1.000, a shop with six Carloses is ordinary, not exotic,
    // and handing back an arbitrary five would be a picker that need not
    // even contain the right person. Six CONFIDENT matches must escalate to
    // not_found; five must still resolve/ambiguate exactly as before.
    describe('overflow guard (six confident matches escalate, five do not)', () => {
      it('SIX technicians sharing a first name → not_found, not an arbitrary five-candidate picker', async () => {
        const t = await createTestTenant(pool);
        for (let i = 0; i < 6; i++) {
          await seedUser(t.tenantId, 'Carlos', `Surname${i}`, 'technician');
        }
        const result = await resolver.resolve({
          tenantId: t.tenantId,
          reference: 'Carlos',
          kind: 'technician',
        });
        expect(result.kind).toBe('not_found');
      });

      it('FIVE technicians sharing a first name → ambiguous with all five, not escalated', async () => {
        const t = await createTestTenant(pool);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push(await seedUser(t.tenantId, 'Carlos', `Fivesurname${i}`, 'technician'));
        }
        const result = await resolver.resolve({
          tenantId: t.tenantId,
          reference: 'Carlos',
          kind: 'technician',
        });
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.candidates.map((c) => c.id).sort()).toEqual([...ids].sort());
        }
      });
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

  // ---------------------------------------------------------------------
  // B5.3 AC-3 — job-name → appointment resolution, and the delicate fix:
  // a NAME-BEARING appointment reference that matches no job must never
  // fall through to the nameless tenant-wide "soonest upcoming" fallback
  // (b5.3-design.md §3). Each `it` seeds its own tenant so the tenant-wide
  // fallback's "exactly one upcoming appointment" precondition is under
  // this test's control, not shared/perturbed by other tests in this file
  // (mirrors test/integration/reschedule-appointment-voice.test.ts's
  // per-test tenant isolation for the same reason).
  // ---------------------------------------------------------------------
  describe('appointment resolution by job name (AC-3 / AC-4)', () => {
    async function seedTenantWithJobAppointments(
      jobSummary: string,
      appointments: Array<{ daysOut: number; technicianId?: string }>,
    ): Promise<{
      tenantId: string;
      userId: string;
      jobId: string;
      appointmentIds: string[];
    }> {
      const t = await createTestTenant(pool);
      const localCustomerRepo = new PgCustomerRepository(pool);
      const locationRepo = new PgLocationRepository(pool);
      const jobRepo = new PgJobRepository(pool);
      const localAppointmentRepo = new PgAppointmentRepository(pool);
      const assignmentRepo = new PgAssignmentRepository(pool);

      const customerId = crypto.randomUUID();
      await localCustomerRepo.create({
        id: customerId,
        tenantId: t.tenantId,
        firstName: jobSummary.split(' ')[0] ?? 'Customer',
        lastName: 'Customer',
        displayName: jobSummary,
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId,
        tenantId: t.tenantId,
        customerId,
        street1: '1 Test St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'USA',
        isPrimary: true,
        addressType: 'service',
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId,
        tenantId: t.tenantId,
        customerId,
        locationId,
        jobNumber: `JOB-${jobId.slice(0, 8)}`,
        summary: jobSummary,
        status: 'scheduled',
        priority: 'normal',
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const appointmentIds: string[] = [];
      for (const appt of appointments) {
        const start = new Date();
        start.setUTCDate(start.getUTCDate() + appt.daysOut);
        const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
        const appointmentId = crypto.randomUUID();
        await localAppointmentRepo.create({
          id: appointmentId,
          tenantId: t.tenantId,
          jobId,
          scheduledStart: start,
          scheduledEnd: end,
          timezone: 'America/Chicago',
          status: 'scheduled',
          holdPendingApproval: false,
          notes: jobSummary,
          createdBy: t.userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        if (appt.technicianId) {
          await assignTechnician(
            {
              tenantId: t.tenantId,
              appointmentId,
              technicianId: appt.technicianId,
              technicianRole: 'technician',
              isPrimary: true,
              assignedBy: t.userId,
            },
            assignmentRepo,
          );
        }
        appointmentIds.push(appointmentId);
      }

      return { tenantId: t.tenantId, userId: t.userId, jobId, appointmentIds };
    }

    async function seedTechnician(tenantId: string, firstName: string, lastName: string): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
         VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
        [id, tenantId, `clerk-${id}`, `${firstName}.${lastName}.${id.slice(0, 8)}@example.com`.toLowerCase(), firstName, lastName],
      );
      return id;
    }

    /** Add a SECOND job (plus one upcoming appointment) to an existing tenant. */
    async function seedSecondJobWithAppointment(
      tenantId: string,
      userId: string,
      jobSummary: string,
      daysOut: number,
    ): Promise<string> {
      const localCustomerRepo = new PgCustomerRepository(pool);
      const locationRepo = new PgLocationRepository(pool);
      const jobRepo = new PgJobRepository(pool);
      const localAppointmentRepo = new PgAppointmentRepository(pool);

      const customerId = crypto.randomUUID();
      await localCustomerRepo.create({
        id: customerId, tenantId, firstName: jobSummary.split(' ')[0] ?? 'Customer',
        lastName: 'Customer', displayName: jobSummary, preferredChannel: 'phone',
        smsConsent: false, isArchived: false, createdBy: userId,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId, tenantId, customerId, street1: '2 Test St', city: 'Austin',
        state: 'TX', postalCode: '78701', country: 'USA', isPrimary: true,
        addressType: 'service', isArchived: false, createdAt: new Date(), updatedAt: new Date(),
      });
      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId, tenantId, customerId, locationId,
        jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: jobSummary, status: 'scheduled',
        priority: 'normal', createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
      });
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + daysOut);
      const appointmentId = crypto.randomUUID();
      await localAppointmentRepo.create({
        id: appointmentId, tenantId, jobId, scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
        timezone: 'America/Chicago', status: 'scheduled', holdPendingApproval: false,
        notes: jobSummary, createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
      });
      return appointmentId;
    }

    // Follow-up to AC-3, raised in PR review: when the NAME matches several
    // jobs, the resolver used to return job-kind candidates for an APPOINTMENT
    // reference. The operator would tap a job, the redraft would inject a
    // `jobId`, and reassign/cancel/reschedule still had no `appointmentId` —
    // the proposal stayed gated and no appointment picker was ever shown.
    it('an ambiguous job NAME answers with APPOINTMENT candidates, not job candidates', async () => {
      // Two OPEN jobs for the same customer — an ordinary shop, and the case
      // that makes the name itself ambiguous.
      const seeded = await seedTenantWithJobAppointments('the Johnson job', [{ daysOut: 3 }]);
      const secondAppointmentId = await seedSecondJobWithAppointment(
        seeded.tenantId,
        seeded.userId,
        'the Johnson job',
        6,
      );

      const result = await resolver.resolve({
        tenantId: seeded.tenantId,
        reference: 'the Johnson job',
        kind: 'appointment',
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        // Every candidate is answerable by the scheduling handlers…
        for (const c of result.candidates) {
          expect(c.kind).toBe('appointment');
        }
        // …and they are the real appointments behind BOTH matched jobs.
        const ids = result.candidates.map((c) => c.id).sort();
        expect(ids).toEqual([seeded.appointmentIds[0], secondAppointmentId].sort());
      }
    });

    it('AC-3 positive: a named job reference with ONE upcoming appointment resolves to that appointment', async () => {
      const { tenantId, appointmentIds } = await seedTenantWithJobAppointments(
        'the Johnson job',
        [{ daysOut: 3 }],
      );
      const result = await resolver.resolve({
        tenantId,
        reference: 'the Johnson job',
        kind: 'appointment',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(appointmentIds[0]);
        expect(result.candidate.kind).toBe('appointment');
      }
    });

    it('AC-3: a named job reference with MULTIPLE upcoming appointments → ambiguous, ≤5 candidates carrying date + assigned tech', async () => {
      const { tenantId, appointmentIds } = await seedTenantWithJobAppointments('the Garcia job', [
        { daysOut: 2 },
        { daysOut: 5 },
      ]);
      const carlosId = await seedTechnician(tenantId, 'Carlos', 'Ramirez');
      // Assign a tech to only the SECOND appointment so the hint text is
      // provably per-candidate, not a fixed string.
      const assignmentRepo = new PgAssignmentRepository(pool);
      await assignTechnician(
        {
          tenantId,
          appointmentId: appointmentIds[1],
          technicianId: carlosId,
          technicianRole: 'technician',
          isPrimary: true,
          assignedBy: 'seed',
        },
        assignmentRepo,
      );

      const result = await resolver.resolve({
        tenantId,
        reference: 'the Garcia job',
        kind: 'appointment',
      });
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.candidates.length).toBeLessThanOrEqual(5);
      expect(result.candidates.map((c) => c.id).sort()).toEqual([...appointmentIds].sort());
      // Every candidate's label is a real ISO date (the "DATE" half of
      // "DATE + ASSIGNED TECH" the picker needs to be answerable).
      for (const c of result.candidates) {
        expect(() => new Date(c.label).toISOString()).not.toThrow();
      }
      const assigned = result.candidates.find((c) => c.id === appointmentIds[1]);
      const unassigned = result.candidates.find((c) => c.id === appointmentIds[0]);
      expect(assigned?.hint).toBe('assigned to Carlos Ramirez');
      expect(unassigned?.hint).toBe('unassigned');
    });

    it('AC-3 (the defect fix): a NAME-BEARING reference matching NO job returns not_found — even when the tenant has exactly one upcoming appointment (the case that would otherwise resolve via the nameless fallback)', async () => {
      const { tenantId } = await seedTenantWithJobAppointments('Miller AC repair', [
        { daysOut: 4 },
      ]);
      // The tenant's ONLY upcoming appointment belongs to an unrelated
      // "Miller" job. A reference naming "Johnson" — a customer/job this
      // tenant has no record of — must NEVER resolve to Miller's
      // appointment just because it happens to be the tenant's sole
      // upcoming one. Before the fix, `resolveAppointment` fell straight
      // to `resolveUpcomingAppointment` here and DID return it.
      const result = await resolver.resolve({
        tenantId,
        reference: 'the Johnson job',
        kind: 'appointment',
      });
      expect(result.kind).toBe('not_found');
      if (result.kind === 'not_found') {
        expect(result.reference).toBe('the Johnson job');
      }
    });

    it('AC-3 regression pin: a NAMELESS reference with exactly one upcoming appointment still resolves (SCH-03 unbroken)', async () => {
      const { tenantId, appointmentIds } = await seedTenantWithJobAppointments(
        'Miller AC repair',
        [{ daysOut: 4 }],
      );
      // Same shape of tenant state as the negative case above — the ONLY
      // difference is the reference itself carries no name. This must
      // still resolve via the SCH-03 tenant-wide fallback.
      const result = await resolver.resolve({
        tenantId,
        reference: 'the upcoming appointment',
        kind: 'appointment',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(appointmentIds[0]);
      }
    });

    it('AC-4: two technicians sharing a FIRST NAME → reassign_appointment drafting short-circuits to voice_clarification (technician picker)', async () => {
      const { tenantId, userId, appointmentIds } = await seedTenantWithJobAppointments(
        'the Ramirez job',
        [{ daysOut: 2 }],
      );
      // Real Postgres, real pg_trgm — DIFFERENT last names, sharing only a
      // first name, because that is the case an operator actually produces:
      // "Assign Carlos" names one word, not a surname the caller may not
      // even know. Before 7fbff6e this arrangement used two IDENTICAL full
      // names specifically to avoid a first-name-only score landing in the
      // confidence band `TECH_SCORE_EXPR`'s `strict_word_similarity` variant
      // lives in — the band the product actually serves. Post-fix, a full
      // first-name word match scores 1.000 via strict_word_similarity same
      // as an identical full name would, so this is the honest version of
      // the same proof.
      const carlosA = await seedTechnician(tenantId, 'Carlos', 'Vega');
      const carlosB = await seedTechnician(tenantId, 'Carlos', 'Mendoza');

      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'reassign_appointment',
          confidence: 0.9,
          extractedEntities: {
            appointmentReference: 'the Ramirez job',
            // A classifier extracting from "Assign Carlos to the Ramirez
            // job" produces the FIRST NAME spoken, not a surname never
            // uttered — see intent-classifier.ts's own example for this
            // exact sentence ("Assign Carlos to the Johnson job").
            targetTechnicianName: 'Carlos',
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
          tenantId,
          userId,
          transcript: 'Assign Carlos to the Ramirez job',
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenantId);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('voice_clarification');
      const payload = proposals[0].payload as Record<string, unknown>;
      expect(payload.reason).toBe('ambiguous_entity');
      const candidateIds = (payload.entityCandidates as Array<{ id: string }>).map((c) => c.id);
      expect(candidateIds).toContain(carlosA);
      expect(candidateIds).toContain(carlosB);
      // The appointment itself resolved cleanly (job-name unique match) —
      // technician ambiguity is the ONLY thing gating this, proving the
      // picker fires on the reassign path specifically, not as a stand-in
      // for an unresolved appointment.
      void appointmentIds;
    });

    // The de-arrangement above swaps the pair's claim from "two IDENTICAL
    // full names" to "two names sharing only a first word" — a different
    // and now-honest case, but it silently drops the original one: that the
    // FULL voice-action-router pipeline (not just `resolver.resolve`
    // directly, which "two technicians with the same name" up in the U1
    // block already pins) short-circuits to voice_clarification when an
    // operator speaks a full name two technicians both carry. Kept as its
    // own case so neither claim is lost.
    it('AC-4 (identical full name, retained): two technicians with the SAME full name → reassign_appointment drafting also short-circuits to voice_clarification', async () => {
      const { tenantId, userId } = await seedTenantWithJobAppointments('the Ramirez job', [
        { daysOut: 2 },
      ]);
      const carlosA = await seedTechnician(tenantId, 'Carlos', 'Vega');
      const carlosB = await seedTechnician(tenantId, 'Carlos', 'Vega');

      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'reassign_appointment',
          confidence: 0.9,
          extractedEntities: {
            appointmentReference: 'the Ramirez job',
            // "Assign Carlos Vega" — the operator spoke the full name this
            // time, so the classifier extracts the full name, unlike the
            // first-name-only case above.
            targetTechnicianName: 'Carlos Vega',
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
          tenantId,
          userId,
          transcript: 'Assign Carlos Vega to the Ramirez job',
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenantId);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('voice_clarification');
      const payload = proposals[0].payload as Record<string, unknown>;
      expect(payload.reason).toBe('ambiguous_entity');
      const candidateIds = (payload.entityCandidates as Array<{ id: string }>).map((c) => c.id);
      expect(candidateIds).toContain(carlosA);
      expect(candidateIds).toContain(carlosB);
    });
  });

  // ---------------------------------------------------------------------
  // PR review findings A + B — an appointment named by its CUSTOMER, and an
  // appointment named by its TIME. Both were `not_found` before, which is
  // B4.7 (reschedule/cancel) and B5.3 (reassign) failing on the two most
  // natural phrasings a dispatcher uses.
  //
  // FIXTURE RULE (docs/solutions/test-failures/a-fixture-arranged-to-pass-
  // proves-nothing.md): the seed here contains only what a real shop would
  // produce. Job summaries say what the WORK is; the customer's name appears
  // ONLY on the customer row; the appointment's notes do not repeat it. Every
  // test below asserts that separation explicitly, so the planting the
  // sibling helper does (displayName = jobSummary) cannot creep back in.
  // ---------------------------------------------------------------------
  describe('appointment resolution by CUSTOMER name and by CLOCK TIME', () => {
    interface RealisticSeed {
      tenantId: string;
      userId: string;
      customerId: string;
      jobId: string;
    }

    /** A tenant with one customer and one ordinarily-summarized job. */
    async function seedRealisticTenant(opts: {
      displayName: string;
      jobSummary: string;
      timezone?: string;
      companyName?: string;
    }): Promise<RealisticSeed> {
      const t = await createTestTenant(pool);
      if (opts.timezone) {
        await pool.query(
          `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
           VALUES ($1, $2, $3, $4, 'TX')`,
          [crypto.randomUUID(), t.tenantId, 'Test Shop', opts.timezone],
        );
      }
      const localCustomerRepo = new PgCustomerRepository(pool);
      const locationRepo = new PgLocationRepository(pool);
      const jobRepo = new PgJobRepository(pool);

      const [firstName, ...rest] = opts.displayName.split(' ');
      const customerId = crypto.randomUUID();
      await localCustomerRepo.create({
        id: customerId,
        tenantId: t.tenantId,
        firstName,
        lastName: rest.join(' '),
        displayName: opts.displayName,
        companyName: opts.companyName,
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId,
        tenantId: t.tenantId,
        customerId,
        street1: '9 Real St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'USA',
        isPrimary: true,
        addressType: 'service',
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId,
        tenantId: t.tenantId,
        customerId,
        locationId,
        jobNumber: `JOB-${jobId.slice(0, 8)}`,
        summary: opts.jobSummary,
        status: 'scheduled',
        priority: 'normal',
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { tenantId: t.tenantId, userId: t.userId, customerId, jobId };
    }

    /** Another customer + job inside an EXISTING tenant. */
    async function addRealisticJob(
      seed: RealisticSeed,
      opts: { displayName: string; jobSummary: string },
    ): Promise<string> {
      const localCustomerRepo = new PgCustomerRepository(pool);
      const locationRepo = new PgLocationRepository(pool);
      const jobRepo = new PgJobRepository(pool);
      const [firstName, ...rest] = opts.displayName.split(' ');
      const customerId = crypto.randomUUID();
      await localCustomerRepo.create({
        id: customerId, tenantId: seed.tenantId, firstName, lastName: rest.join(' '),
        displayName: opts.displayName, preferredChannel: 'phone', smsConsent: false,
        isArchived: false, createdBy: seed.userId, createdAt: new Date(), updatedAt: new Date(),
      });
      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId, tenantId: seed.tenantId, customerId, street1: '10 Real St',
        city: 'Austin', state: 'TX', postalCode: '78701', country: 'USA', isPrimary: true,
        addressType: 'service', isArchived: false, createdAt: new Date(), updatedAt: new Date(),
      });
      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId, tenantId: seed.tenantId, customerId, locationId,
        jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: opts.jobSummary, status: 'scheduled',
        priority: 'normal', createdBy: seed.userId, createdAt: new Date(), updatedAt: new Date(),
      });
      return jobId;
    }

    /**
     * An appointment at an EXACT instant. `notes` deliberately never carries
     * the customer's name — nothing but the customer row may answer a
     * customer-named reference.
     */
    async function seedAppointmentAt(
      seed: RealisticSeed,
      jobId: string,
      start: Date,
    ): Promise<string> {
      const localAppointmentRepo = new PgAppointmentRepository(pool);
      const appointmentId = crypto.randomUUID();
      await localAppointmentRepo.create({
        id: appointmentId,
        tenantId: seed.tenantId,
        jobId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
        timezone: 'America/Chicago',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: seed.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return appointmentId;
    }

    function daysOut(n: number): Date {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    }

    /**
     * The UTC instant of `hour`:00 wall-clock in `zone`, on the tenant-local
     * day `dayOffset` days from the tenant's today. Stated here with luxon
     * directly rather than by calling the production `resolveDateTime`, so the
     * fixture is an INDEPENDENT statement of the tenant-zone instant and not a
     * restatement of the code under test.
     */
    function localHourUtc(zone: string, hour: number, dayOffset = 0): Date {
      return DateTime.now()
        .setZone(zone)
        .plus({ days: dayOffset })
        .set({ hour, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toJSDate();
    }

    /** Today's `hour`:00 in `zone` if still ahead, else tomorrow's — what a bare "the 2pm" means. */
    function nextLocalHourUtc(zone: string, hour: number): Date {
      const today = localHourUtc(zone, hour, 0);
      return today.getTime() > Date.now() ? today : localHourUtc(zone, hour, 1);
    }

    // -- Finding A -------------------------------------------------------

    it('"move the Garcia job" resolves through customers → jobs when the SUMMARY is "AC repair" and only the CUSTOMER carries the name', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
      });
      const appointmentId = await seedAppointmentAt(seed, seed.jobId, daysOut(3));

      // The word "Garcia" exists on the customer row and NOWHERE else that a
      // query could reach: not the summary, not the job number, not the
      // appointment notes. Asserted, so it cannot be re-planted later.
      const planted = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM jobs j
           LEFT JOIN appointments a ON a.job_id = j.id
          WHERE j.tenant_id = $1
            AND (j.summary ILIKE '%garcia%' OR j.job_number ILIKE '%garcia%'
                 OR COALESCE(a.notes,'') ILIKE '%garcia%')`,
        [seed.tenantId],
      );
      expect(planted.rows[0].n).toBe('0');

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the Garcia job',
        kind: 'appointment',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(appointmentId);
        expect(result.candidate.kind).toBe('appointment');
      }
    });

    it('a LAST-NAME-ONLY reference clears the confirm floor, which whole-string similarity() provably does not', async () => {
      // The measurement that drove the design, pinned against the real
      // pg_trgm this suite runs on: whole-string similarity of a last-name
      // reference against a full display name is BELOW τ_ent_confirm_low
      // (0.60), so a `similarity(display_name, needle)` traversal would have
      // reproduced the same silent not_found. strict_word_similarity is above
      // τ_ent (0.80). If this ever inverts, the fix's premise has changed.
      const scores = await pool.query<{
        whole: number;
        phrase: number;
        strict: number;
        loose_prefix: number;
        strict_prefix: number;
      }>(
        `SELECT similarity('Jamie Garcia', 'garcia')                AS whole,
                similarity('Jamie Garcia', 'the Garcia job')        AS phrase,
                strict_word_similarity('garcia', 'Jamie Garcia')    AS strict,
                word_similarity('khan', 'Khanna Enterprises')       AS loose_prefix,
                strict_word_similarity('khan', 'Khanna Enterprises') AS strict_prefix`,
      );
      const s = scores.rows[0];
      expect(Number(s.whole)).toBeLessThan(TAU_ENT_CONFIRM_LOW);
      expect(Number(s.phrase)).toBeLessThan(TAU_ENT_CONFIRM_LOW);
      expect(Number(s.strict)).toBeGreaterThanOrEqual(TAU_ENT);
      // …and the reason it is the STRICT variant: the loose one scores a mere
      // shared PREFIX near τ_ent, where strict word boundaries put it below
      // the confirm floor, i.e. unable to resolve or even low-confidence.
      expect(Number(s.loose_prefix)).toBeGreaterThan(Number(s.strict_prefix));
      expect(Number(s.strict_prefix)).toBeLessThan(TAU_ENT_CONFIRM_LOW);

      const seed = await seedRealisticTenant({
        displayName: 'Aisha Khan',
        jobSummary: 'Water heater replacement',
      });
      const appointmentId = await seedAppointmentAt(seed, seed.jobId, daysOut(2));
      // A customer who merely SHARES THE PREFIX, with her own upcoming
      // appointment. A loose word match would make "the Khan job" ambiguous
      // (or worse, pick her); strict word boundaries must not reach her.
      const khannaJobId = await addRealisticJob(seed, {
        displayName: 'Priya Khanna',
        jobSummary: 'Drain cleaning',
      });
      await seedAppointmentAt(seed, khannaJobId, daysOut(4));

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the Khan job',
        kind: 'appointment',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') expect(result.candidate.id).toBe(appointmentId);
    });

    it('two jobs for the SAME customer stay a one-tap clarification, in appointment kind', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
      });
      const secondJobId = await addRealisticJob(seed, {
        displayName: 'Jamie Garcia',
        jobSummary: 'Furnace tune-up',
      });
      const a1 = await seedAppointmentAt(seed, seed.jobId, daysOut(2));
      const a2 = await seedAppointmentAt(seed, secondJobId, daysOut(5));

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the Garcia job',
        kind: 'appointment',
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      for (const c of result.candidates) expect(c.kind).toBe('appointment');
      expect(result.candidates.map((c) => c.id).sort()).toEqual([a1, a2].sort());
    });

    it('a customer-named reference never crosses tenants', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
      });
      await seedAppointmentAt(seed, seed.jobId, daysOut(3));
      const stranger = await createTestTenant(pool);

      const result = await resolver.resolve({
        tenantId: stranger.tenantId,
        reference: 'the Garcia job',
        kind: 'appointment',
      });
      expect(result.kind).toBe('not_found');
    });

    it('an ARCHIVED customer cannot answer a named reference', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
      });
      await seedAppointmentAt(seed, seed.jobId, daysOut(3));
      await pool.query(`UPDATE customers SET is_archived = true WHERE id = $1`, [seed.customerId]);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the Garcia job',
        kind: 'appointment',
      });
      expect(result.kind).toBe('not_found');
    });

    // -- Finding B -------------------------------------------------------

    // Pacific/Honolulu is UTC-10 with no DST: 2pm local is 00:00 UTC the NEXT
    // day. A resolver doing server-local or UTC arithmetic would look ten
    // hours away from the right instant — and each test below seeds a decoy
    // appointment at exactly the instant such a resolver would have picked.
    const TZ = 'Pacific/Honolulu';

    it('"the 2pm" resolves the appointment at 2pm in the TENANT\'s zone, not at 14:00 UTC', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      const localTwoPm = nextLocalHourUtc(TZ, 14);
      const target = await seedAppointmentAt(seed, seed.jobId, localTwoPm);

      // The decoy: 14:00 UTC on the same local day — what a UTC-arithmetic
      // implementation would resolve "the 2pm" to.
      const utcTwoPm = new Date(localTwoPm);
      utcTwoPm.setUTCHours(14, 0, 0, 0);
      if (utcTwoPm.getTime() <= Date.now()) utcTwoPm.setUTCDate(utcTwoPm.getUTCDate() + 1);
      expect(Math.abs(utcTwoPm.getTime() - localTwoPm.getTime())).toBeGreaterThan(60 * 60 * 1000);
      const decoy = await seedAppointmentAt(seed, seed.jobId, utcTwoPm);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the 2pm',
        kind: 'appointment',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(target);
        expect(result.candidate.id).not.toBe(decoy);
        expect(result.candidate.kind).toBe('appointment');
      }
    });

    it('"tomorrow at 2" resolves TOMORROW\'s 2pm in the tenant zone', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      const todayTwoPm = localHourUtc(TZ, 14, 0);
      const tomorrowTwoPm = localHourUtc(TZ, 14, 1);
      expect(tomorrowTwoPm.getTime() - todayTwoPm.getTime()).toBe(24 * 60 * 60 * 1000);
      // BOTH exist, so picking the right day is the whole assertion.
      const near = await seedAppointmentAt(seed, seed.jobId, todayTwoPm);
      const target = await seedAppointmentAt(seed, seed.jobId, tomorrowTwoPm);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'tomorrow at 2',
        kind: 'appointment',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(target);
        expect(result.candidate.id).not.toBe(near);
      }
    });

    it('two appointments at the stated time stay a one-tap clarification carrying what distinguishes them', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      const otherJobId = await addRealisticJob(seed, {
        displayName: 'Linh Nguyen',
        jobSummary: 'Furnace tune-up',
      });
      const at2 = nextLocalHourUtc(TZ, 14);
      const a1 = await seedAppointmentAt(seed, seed.jobId, at2);
      const a2 = await seedAppointmentAt(seed, otherJobId, at2);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the 2pm',
        kind: 'appointment',
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.candidates.map((c) => c.id).sort()).toEqual([a1, a2].sort());
      for (const c of result.candidates) expect(c.kind).toBe('appointment');
      // The clock cannot tell these apart, so the picker must say what does.
      const hints = result.candidates.map((c) => c.hint ?? '');
      expect(hints.some((h) => h.includes('AC repair'))).toBe(true);
      expect(hints.some((h) => h.includes('Furnace tune-up'))).toBe(true);
    });

    it('a canceled appointment is not a reschedule target even at the stated time', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      const at2 = nextLocalHourUtc(TZ, 14);
      const canceled = await seedAppointmentAt(seed, seed.jobId, at2);
      await pool.query(`UPDATE appointments SET status = 'canceled' WHERE id = $1`, [canceled]);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the 2pm',
        kind: 'appointment',
      });
      expect(result.kind).toBe('not_found');
    });

    it('a clock-time reference never crosses tenants', async () => {
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(TZ, 14));
      const stranger = await createTestTenant(pool);
      await pool.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
         VALUES ($1, $2, 'Stranger', $3, 'TX')`,
        [crypto.randomUUID(), stranger.tenantId, TZ],
      );

      const result = await resolver.resolve({
        tenantId: stranger.tenantId,
        reference: 'the 2pm',
        kind: 'appointment',
      });
      expect(result.kind).toBe('not_found');
    });

    it('a clock time that matches nothing REFUSES — it never answers with a different appointment', async () => {
      // Raised in PR review. This case previously asserted the opposite, that
      // an unmatched time "falls through" so the customer traversal answers,
      // on the reasoning that the temporal branch should be purely additive.
      // That reasoning is the defect: the speaker stated 2pm, and the only
      // thing here is at 9am. Falling through hands "the 2pm Garcia job" to
      // the name branch, which resolves the 9am — so cancel/reschedule would
      // target a visit the operator did not name. An explicit constraint that
      // matches nothing has to be terminal; every remaining route reaches a
      // wrong answer by a longer path.
      const seed = await seedRealisticTenant({
        displayName: 'Jamie Garcia',
        jobSummary: 'AC repair',
        timezone: TZ,
      });
      const at9 = nextLocalHourUtc(TZ, 9);
      const appointmentId = await seedAppointmentAt(seed, seed.jobId, at9);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the 2pm Garcia job',
        kind: 'appointment',
      });

      expect(result.kind).toBe('not_found');

      // Control: the SAME tenant and appointment resolve fine when the spoken
      // time matches, so the refusal above is about the stated time and not
      // about the seed being unreachable.
      const matching = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the 9am Garcia job',
        kind: 'appointment',
      });
      expect(matching.kind).toBe('resolved');
      if (matching.kind === 'resolved') expect(matching.candidate.id).toBe(appointmentId);
    });

    // -- an UNSET tenant timezone must REFUSE, never default ---------------
    //
    // `resolveDateTime` substitutes `DEFAULT_TENANT_TIMEZONE`
    // ('America/New_York') for an absent zone — resolve-datetime.ts:161, with
    // the constant at :32. So passing `undefined` through does not fail
    // loudly; it silently answers in Eastern. For a Phoenix tenant that means
    // "cancel the 2pm" can select the appointment sitting at the
    // 2pm-EASTERN instant and feed that id to cancel / reschedule / reassign.
    // Every other failure on this branch degrades to not_found or ambiguous;
    // this one degraded to confidently-wrong on an irreversible action class.
    //
    // The CONTROL test is the load-bearing one: it proves the appointment in
    // these fixtures really is matchable at the Eastern instant, so the
    // refusals above it are caused by the missing zone and not by an
    // appointment that nothing could have found.
    describe('an unset tenant timezone refuses instead of defaulting to Eastern', () => {
      const EASTERN = 'America/New_York';

      it('a tenant with NO tenant_settings row does not resolve "the 2pm"', async () => {
        // Omitting `timezone` seeds no tenant_settings row at all.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(EASTERN, 14));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the 2pm',
          kind: 'appointment',
        });
        expect(result.kind).toBe('not_found');
      });

      it('an explicit NULL timezone refuses the same way — migration 263 made "unchosen" representable precisely so it could be told apart from a real Eastern tenant', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await pool.query(
          `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
           VALUES ($1, $2, $3, NULL, 'TX')`,
          [crypto.randomUUID(), seed.tenantId, 'Zoneless Shop'],
        );
        await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(EASTERN, 14));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the 2pm',
          kind: 'appointment',
        });
        expect(result.kind).toBe('not_found');
      });

      it('an UNRECOGNIZED timezone string refuses too — a garbage zone is not a chosen one', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await pool.query(
          `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
           VALUES ($1, $2, $3, $4, 'TX')`,
          [crypto.randomUUID(), seed.tenantId, 'Typo Shop', 'Amerca/Phoenix'],
        );
        await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(EASTERN, 14));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the 2pm',
          kind: 'appointment',
        });
        expect(result.kind).toBe('not_found');
      });

      it('CONTROL: the identical fixture DOES resolve once the tenant actually states Eastern — so the refusals above are the missing zone, not an unmatchable appointment', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
          timezone: EASTERN,
        });
        const target = await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(EASTERN, 14));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the 2pm',
          kind: 'appointment',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(target);
      });

      it('a NAME-bearing clock reference in a zoneless tenant refuses rather than quietly answering by name', async () => {
        // "the 2pm Garcia job" would otherwise fall through to the customer
        // traversal and resolve Garcia's ONLY appointment — which is at 9am,
        // i.e. not the 2pm anything. Returning a resolved id there would
        // still be answering a time question without knowing the time, so the
        // refusal is terminal rather than a fall-through. (With a zone set,
        // the fall-through behavior is unchanged — pinned by "a clock time
        // that matches nothing falls THROUGH" above.)
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedAppointmentAt(seed, seed.jobId, nextLocalHourUtc(EASTERN, 9));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the 2pm Garcia job',
          kind: 'appointment',
        });
        expect(result.kind).toBe('not_found');
      });
    });

    // -- kind: 'job' ------------------------------------------------------
    //
    // The SAME defect, one branch over. `JOB_REF_INTENTS`
    // (agents/customer-calling/entity-resolution.ts:92) routes update_job,
    // log_time_entry, create_invoice, draft_estimate, add_note, notify_delay
    // and request_feedback through `kind: 'job'`, so "note on the Garcia job"
    // (B7.4) and "clock two hours on the Garcia job" (B6.3) were failing for
    // exactly the reason the appointment branch was. Same fixture rule: the
    // summary says what the WORK is, and the surname exists only on the
    // customer row.
    describe('kind: job — the same traversal, for JOB_REF_INTENTS', () => {
      it('a spoken surname resolves a job whose summary is "AC repair"', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });

        // "Garcia" appears on the customer row and NOWHERE a job query could
        // reach it. Asserted so the planting cannot creep back.
        const planted = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM jobs j
             LEFT JOIN appointments a ON a.job_id = j.id
            WHERE j.tenant_id = $1
              AND (j.summary ILIKE '%garcia%' OR j.job_number ILIKE '%garcia%'
                   OR COALESCE(a.notes,'') ILIKE '%garcia%')`,
          [seed.tenantId],
        );
        expect(planted.rows[0].n).toBe('0');

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia job',
          kind: 'job',
        });

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(seed.jobId);
          expect(result.candidate.kind).toBe('job');
          // The label is still the summary — this resolved THROUGH the
          // customer, it did not start matching customers as jobs.
          expect(result.candidate.label).toBe('AC repair');
        }
      });

      it('a prefix-sharing customer is NOT reachable — "Khanna" is a different person', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Aisha Khan',
          jobSummary: 'Water heater replacement',
        });
        await addRealisticJob(seed, {
          displayName: 'Priya Khanna',
          jobSummary: 'Drain cleaning',
        });

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Khan job',
          kind: 'job',
        });

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(seed.jobId);
      });

      it('two customers sharing a surname stay a one-tap clarification, never a guess', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const otherGarciaJobId = await addRealisticJob(seed, {
          displayName: 'Marco Garcia',
          jobSummary: 'Thermostat swap',
        });

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia job',
          kind: 'job',
        });

        expect(result.kind).toBe('ambiguous');
        if (result.kind !== 'ambiguous') return;
        for (const c of result.candidates) expect(c.kind).toBe('job');
        expect(result.candidates.map((c) => c.id).sort()).toEqual(
          [seed.jobId, otherGarciaJobId].sort(),
        );
      });

      it('a reference naming the WORK still resolves by summary, at the identical score', async () => {
        // The pre-existing path, pinned: widening the query must not change
        // what a work-named reference scores, or the τ_ent bands shift under
        // every other caller.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'Water heater replacement',
        });

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'Water heater replacement',
          kind: 'job',
        });

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(seed.jobId);
          expect(result.candidate.score).toBe(1);
        }
      });

      it('a purely filler reference matches nothing — an empty needle must not match every customer', async () => {
        // "that job" reduces to no name at all. The customer half of the
        // GREATEST gets an empty needle, which must score 0 rather than
        // matching every job in the tenant.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await addRealisticJob(seed, { displayName: 'Linh Nguyen', jobSummary: 'Furnace tune-up' });

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'that job',
          kind: 'job',
        });
        expect(result.kind).toBe('not_found');
      });

      it('a customer with MORE jobs than a picker can show escalates instead of offering an arbitrary five', async () => {
        // A commercial account with six open jobs is ordinary, and the
        // surname matches every one of them at 1.000. `LIMIT 5` would have
        // returned a picker that need not even contain the right job.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        for (const summary of [
          'Furnace tune-up',
          'Thermostat swap',
          'Duct cleaning',
          'Condenser replacement',
          'Refrigerant top-up',
        ]) {
          await addRealisticJob(seed, { displayName: 'Jamie Garcia', jobSummary: summary });
        }

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia job',
          kind: 'job',
        });
        expect(result.kind).toBe('not_found');
      });

      it('never resolves a job by customer name across tenants', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        void seed;
        const stranger = await createTestTenant(pool);

        const result = await resolver.resolve({
          tenantId: stranger.tenantId,
          reference: 'the Garcia job',
          kind: 'job',
        });
        expect(result.kind).toBe('not_found');
      });

      it('an ARCHIVED customer cannot answer a job reference', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await pool.query(`UPDATE customers SET is_archived = true WHERE id = $1`, [
          seed.customerId,
        ]);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia job',
          kind: 'job',
        });
        expect(result.kind).toBe('not_found');
      });
    });

    // -- kind: 'estimate' --------------------------------------------------
    //
    // B7.6. The estimate branch was the last one still answering ONLY an
    // exact document number, so "the Garcia estimate" — which is how an
    // operator actually names one — resolved to nothing, and every spoken
    // `update_estimate` / `send_estimate` reference arrived at its task
    // handler unresolved. `estimates` has no customer_id, so the only real
    // path from a person's name to their estimates is customer → jobs →
    // estimates, the same hop SendEstimateNudgeTaskHandler makes.
    //
    // Same fixture rule as the two blocks above, and it matters more here
    // than anywhere: the surname exists ONLY on the customer row. Planting it
    // in `estimates.customer_message` is precisely what made
    // estimate-nudge.test.ts a green test for a feature that did not work
    // (docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-
    // nothing.md), so these estimates carry an ordinary message and the
    // absence of the planting is asserted, not assumed.
    describe('kind: estimate — customer → jobs → estimates', () => {
      async function seedEstimateForJob(
        seed: RealisticSeed,
        jobId: string,
        opts?: { customerMessage?: string },
      ): Promise<string> {
        const localEstimateRepo = new PgEstimateRepository(pool);
        const estimate = await createEstimate(
          {
            tenantId: seed.tenantId,
            jobId,
            estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
            lineItems: [buildLineItem('li-1', 'Diagnostic', 1, 9900, 0, true, 'labor')],
            customerMessage:
              opts?.customerMessage ?? 'Here is the quote for the work we talked through.',
            createdBy: seed.userId,
          },
          localEstimateRepo,
        );
        return estimate.id;
      }

      it('a spoken surname resolves an estimate whose own text names nobody', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const estimateId = await seedEstimateForJob(seed, seed.jobId);

        // "Garcia" must be unreachable from every column an estimate query
        // could touch. Asserted so the planting cannot creep back in.
        const planted = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM estimates e
             JOIN jobs j ON j.id = e.job_id
            WHERE e.tenant_id = $1
              AND (e.estimate_number ILIKE '%garcia%'
                   OR COALESCE(e.customer_message,'') ILIKE '%garcia%'
                   OR COALESCE(e.internal_notes,'') ILIKE '%garcia%'
                   OR j.summary ILIKE '%garcia%'
                   OR j.job_number ILIKE '%garcia%')`,
          [seed.tenantId],
        );
        expect(planted.rows[0].n).toBe('0');

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(estimateId);
          expect(result.candidate.kind).toBe('estimate');
        }
      });

      it('"the Garcia quote" resolves the same estimate — the document noun is stripped, not matched', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const estimateId = await seedEstimateForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia quote',
          kind: 'estimate',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(estimateId);
      });

      it('an exact estimate number still resolves — the fast path is untouched', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const localEstimateRepo = new PgEstimateRepository(pool);
        const estimate = await createEstimate(
          {
            tenantId: seed.tenantId,
            jobId: seed.jobId,
            estimateNumber: 'EST-0042',
            lineItems: [buildLineItem('li-1', 'Diagnostic', 1, 9900, 0, true, 'labor')],
            createdBy: seed.userId,
          },
          localEstimateRepo,
        );

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'EST-0042',
          kind: 'estimate',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(estimate.id);
          expect(result.candidate.score).toBe(1.0);
        }
      });

      it('a prefix-sharing customer is NOT reachable — "Khanna" is a different person', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Aisha Khan',
          jobSummary: 'Water heater replacement',
        });
        const khanEstimateId = await seedEstimateForJob(seed, seed.jobId);
        const khannaJobId = await addRealisticJob(seed, {
          displayName: 'Priya Khanna',
          jobSummary: 'Drain cleaning',
        });
        await seedEstimateForJob(seed, khannaJobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Khan estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(khanEstimateId);
      });

      it('two estimates for the SAME customer stay a one-tap clarification, never a guess', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const first = await seedEstimateForJob(seed, seed.jobId);
        const second = await seedEstimateForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.candidates.map((c) => c.id).sort()).toEqual([first, second].sort());
        }
      });

      it('a customer with MORE estimates than a picker can show escalates instead of offering an arbitrary five', async () => {
        // The overflow trap `resolveJob` already guards, one table over: the
        // surname matches EVERY estimate of theirs at 1.000, so `LIMIT 5`
        // would return a picker that need not contain the right one.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        for (let i = 0; i < 6; i++) await seedEstimateForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('not_found');
      });

      it('a purely filler reference matches nothing — an empty needle must not match every customer', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedEstimateForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('not_found');
      });

      it('a SOFT-DELETED estimate is not reachable by the customer name either', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const estimateId = await seedEstimateForJob(seed, seed.jobId);
        await pool.query(`UPDATE estimates SET deleted_at = now() WHERE id = $1`, [estimateId]);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('not_found');
      });

      it('never resolves an estimate by customer name across tenants', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedEstimateForJob(seed, seed.jobId);
        const stranger = await createTestTenant(pool);

        const result = await resolver.resolve({
          tenantId: stranger.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('not_found');
      });

      it('an ARCHIVED customer cannot answer an estimate reference', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedEstimateForJob(seed, seed.jobId);
        await pool.query(`UPDATE customers SET is_archived = true WHERE id = $1`, [
          seed.customerId,
        ]);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia estimate',
          kind: 'estimate',
        });
        expect(result.kind).toBe('not_found');
      });

      // Status floor (2026-08-31), grounded in the execution handlers that
      // consume the resolved estimateId: SendEstimateNudgeExecutionHandler
      // hard-rejects anything but 'sent', and UpdateEstimateExecutionHandler
      // (assertEstimateEditable, estimates/estimate.ts) hard-rejects
      // 'rejected'/'expired' unconditionally — no consumer's opt-out
      // ('sent' via revise, 'accepted' via RV-042 invalidation) ever reaches
      // those two. This is what the sweep harness's own quarantine strategy
      // depends on: declining a stale nudge-fixture estimate must actually
      // remove it from the candidate set, the same way voiding an invoice
      // does (#944).
      describe('status floor — rejected/expired excluded, draft and accepted stay reachable', () => {
        it('a REJECTED estimate never becomes a candidate — the one DRAFT estimate resolves cleanly', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const draftId = await seedEstimateForJob(seed, seed.jobId);
          const rejectedId = await seedEstimateForJob(seed, seed.jobId);
          await pool.query(`UPDATE estimates SET status = 'rejected' WHERE id = $1`, [
            rejectedId,
          ]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia estimate',
            kind: 'estimate',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(draftId);
        });

        it('an EXPIRED estimate never becomes a candidate either', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const draftId = await seedEstimateForJob(seed, seed.jobId);
          const expiredId = await seedEstimateForJob(seed, seed.jobId);
          await pool.query(`UPDATE estimates SET status = 'expired' WHERE id = $1`, [expiredId]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia estimate',
            kind: 'estimate',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(draftId);
        });

        it('a customer whose ONLY estimate is rejected/expired resolves not_found, never a guess', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const rejectedId = await seedEstimateForJob(seed, seed.jobId);
          await pool.query(`UPDATE estimates SET status = 'rejected' WHERE id = $1`, [
            rejectedId,
          ]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia estimate',
            kind: 'estimate',
          });
          expect(result.kind).toBe('not_found');
        });

        // 'accepted' is deliberately NOT filtered: update_estimate resolves
        // this identical estimateId field to reach an accepted estimate via
        // RV-042's own documented acceptance-invalidation edit path.
        it('an ACCEPTED estimate still resolves — accepted is not in the excluded status set', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const acceptedId = await seedEstimateForJob(seed, seed.jobId);
          await pool.query(`UPDATE estimates SET status = 'accepted' WHERE id = $1`, [
            acceptedId,
          ]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia estimate',
            kind: 'estimate',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(acceptedId);
        });

        // 'sent' is deliberately NOT filtered either: send_estimate_nudge
        // REQUIRES it, and send_estimate has no status restriction at all.
        it('a SENT estimate still resolves — sent is not in the excluded status set', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const sentId = await seedEstimateForJob(seed, seed.jobId);
          await pool.query(`UPDATE estimates SET status = 'sent' WHERE id = $1`, [sentId]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia estimate',
            kind: 'estimate',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(sentId);
        });
      });
    });

    // -- A11 (2026-08-31 live sweep) ------------------------------------
    //
    // Live evidence: proposal ebb0067d (tenant a948cc66, sweep
    // 2026-08-31T05-59) — "qa-matrix-A-customer's tune-up appointment"
    // resolved not_found even though the tune-up appointment existed and a
    // PRIOR sweep resolved the same reference SHAPE to a 2-candidate ask.
    // Root cause: `extractNameLikeToken` does not strip work-type
    // descriptor nouns ("tune-up" → "tune up" once hyphens are normalized
    // to spaces), so they ride along into the customer-name needle
    // `resolveJob` / `resolveJobIdsForCustomerName` score against
    // `customers.display_name` — diluting a confident match into
    // `low_confidence`, which `resolveAppointment`'s named branch already
    // (correctly) treats as "not confident enough to answer" rather than
    // guess. Not a #951 regression: #951 only made the resulting
    // not_found honest instead of silent; this pins why it WAS a
    // not_found underneath that honest reply.
    describe('qualified appointment reference — work-type descriptor stripped from the customer needle (A11)', () => {
      it('"<customer>\'s tune-up appointment" resolves — the qualified form matches the bare form', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'qa-matrix-A-customer',
          jobSummary: 'Furnace tune-up',
        });
        const appointmentId = await seedAppointmentAt(seed, seed.jobId, daysOut(3));

        const bare = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: "qa-matrix-A-customer's appointment",
          kind: 'appointment',
        });
        const qualified = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: "qa-matrix-A-customer's tune-up appointment",
          kind: 'appointment',
        });

        expect(bare.kind).toBe('resolved');
        expect(qualified.kind).toBe('resolved');
        if (bare.kind === 'resolved' && qualified.kind === 'resolved') {
          expect(bare.candidate.id).toBe(appointmentId);
          expect(qualified.candidate.id).toBe(appointmentId);
        }
      });

      it('other evidenced work-type qualifiers ("inspection", "repair", "follow-up") resolve the same appointment', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const appointmentId = await seedAppointmentAt(seed, seed.jobId, daysOut(2));

        for (const phrase of [
          "the Garcia inspection appointment",
          "the Garcia repair appointment",
          "the Garcia follow-up appointment",
          "the Garcia maintenance visit",
        ]) {
          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: phrase,
            kind: 'appointment',
          });
          expect(result.kind, `"${phrase}" should resolve`).toBe('resolved');
          if (result.kind === 'resolved') {
            expect(result.candidate.id, `"${phrase}"`).toBe(appointmentId);
          }
        }
      });

      it('a qualified reference to a customer with TWO appointments asks — the same 2-candidate ambiguity the bare form gets, not a silent not_found', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'qa-matrix-A-customer',
          jobSummary: 'Furnace tune-up',
        });
        const first = await seedAppointmentAt(seed, seed.jobId, daysOut(2));
        const secondJobId = await addRealisticJob(seed, {
          displayName: 'qa-matrix-A-customer',
          jobSummary: 'Duct cleaning',
        });
        const second = await seedAppointmentAt(seed, secondJobId, daysOut(5));

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: "qa-matrix-A-customer's tune-up appointment",
          kind: 'appointment',
        });

        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          const ids = result.candidates.map((c) => c.id).sort();
          expect(ids).toEqual([first, second].sort());
        }
      });

      it('the job-SUMMARY half is unaffected — a work-type word matches a job summary directly, driven by the RAW reference, not the stripped customer needle', async () => {
        // Guards against an over-broad fix: `appointmentCustomerNeedle` only
        // replaces the CUSTOMER-half needle (SCORE_EXPR's `strict_word_
        // similarity($4, c.display_name)` argument) — the job-SUMMARY half
        // (`similarity(j.summary, $2)`) must keep seeing the ORIGINAL,
        // unstripped reference, so a job actually summarized with a
        // work-type word is still reachable by it. Deliberately a bare,
        // near-exact phrase (not a full sentence): `similarity()` is
        // whole-string and dilutes with any surrounding words REGARDLESS of
        // this fix (measured: similarity('Tune-up','the tune-up
        // appointment') = 0.35, well under τ_ent_confirm_low, on customer
        // 'Priya Nair' whose name shares nothing with 'tune-up' — every
        // OTHER test in this describe block resolves through the customer
        // half for exactly that reason), so isolating the summary half on
        // its own requires a tight match, not a realistic sentence.
        const seed = await seedRealisticTenant({
          displayName: 'Priya Nair',
          jobSummary: 'Tune-up',
        });
        const appointmentId = await seedAppointmentAt(seed, seed.jobId, daysOut(4));

        // customerNeedleOverride resolves to '' here (both "tune" and "up"
        // are APPOINTMENT_WORK_TYPE_STOPWORDS), so a resolve is only
        // possible via the summary half — proving it independently of the
        // customer-needle change this test guards.
        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'tune-up',
          kind: 'appointment',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(appointmentId);
      });
    });

    // -- kind: 'invoice' -----------------------------------------------------
    //
    // #909 live-sweep regression (2026-08-30, A20 send_payment_reminder / A21
    // apply_late_fee) — `resolveInvoice`'s customer traversal (added on
    // fix/ref-lift-live-misses, merged as PR #930) shipped with ONLY the
    // mocked-Pool unit suite behind it (test/ai/resolution/pg-entity-
    // resolver.test.ts), never against real Postgres. These tests pin it the
    // same way `kind: estimate` above pins B7.6.
    describe('kind: invoice — customer → jobs → invoices', () => {
      async function seedInvoiceForJob(
        seed: RealisticSeed,
        jobId: string,
        opts?: { invoiceNumber?: string },
      ): Promise<string> {
        const localInvoiceRepo = new PgInvoiceRepository(pool);
        const invoice = await createInvoice(
          {
            tenantId: seed.tenantId,
            jobId,
            invoiceNumber: opts?.invoiceNumber ?? `INV-${crypto.randomUUID().slice(0, 8)}`,
            lineItems: [buildLineItem('li-1', 'Diagnostic', 1, 9900, 0, true, 'labor')],
            createdBy: seed.userId,
          },
          localInvoiceRepo,
        );
        return invoice.id;
      }

      it('a spoken surname resolves an invoice whose own text names nobody', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const invoiceId = await seedInvoiceForJob(seed, seed.jobId);

        // "Garcia" must be unreachable from every column an invoice-number
        // query could touch. Asserted so the planting cannot creep back in.
        const planted = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM invoices i
             JOIN jobs j ON j.id = i.job_id
            WHERE i.tenant_id = $1
              AND (i.invoice_number ILIKE '%garcia%'
                   OR COALESCE(i.customer_message,'') ILIKE '%garcia%'
                   OR j.summary ILIKE '%garcia%'
                   OR j.job_number ILIKE '%garcia%')`,
          [seed.tenantId],
        );
        expect(planted.rows[0].n).toBe('0');

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia invoice',
          kind: 'invoice',
        });

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(invoiceId);
          expect(result.candidate.kind).toBe('invoice');
        }
      });

      it('"the Garcia bill" resolves the same invoice — the document noun is stripped, not matched', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const invoiceId = await seedInvoiceForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia bill',
          kind: 'invoice',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(invoiceId);
      });

      it('an exact invoice number still resolves — the fast path is untouched', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const invoiceId = await seedInvoiceForJob(seed, seed.jobId, {
          invoiceNumber: 'INV-0042',
        });

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'INV-0042',
          kind: 'invoice',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.candidate.id).toBe(invoiceId);
          expect(result.candidate.score).toBe(1.0);
        }
      });

      it('a prefix-sharing customer is NOT reachable — "Khanna" is a different person', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Aisha Khan',
          jobSummary: 'Water heater replacement',
        });
        const khanInvoiceId = await seedInvoiceForJob(seed, seed.jobId);
        const khannaJobId = await addRealisticJob(seed, {
          displayName: 'Priya Khanna',
          jobSummary: 'Drain cleaning',
        });
        await seedInvoiceForJob(seed, khannaJobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Khan invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidate.id).toBe(khanInvoiceId);
      });

      it('two invoices for the SAME customer stay a one-tap clarification, never a guess', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        const first = await seedInvoiceForJob(seed, seed.jobId);
        const second = await seedInvoiceForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.candidates.map((c) => c.id).sort()).toEqual([first, second].sort());
        }
      });

      // The live-verified fixture shape (e2e/qa-matrix/fixtures/seed.ts):
      // first_name 'QA', last_name '<slug>', display_name '<slug>-customer'.
      // The hyphenated display_name is the literal reference the classifier
      // hands `resolveInvoice` when it extracted no document number — this is
      // the exact string that stayed gated live on proposal
      // a3e1d302-fecf-4f8c-bd4b-756eef4131d2 (tenant
      // a948cc66-7279-44bd-9718-4ef7721f9422) with no pendingEntityAmbiguity
      // attached. Three invoices, matching the live fixture's 3-invoice count
      // and MAX_INVOICE_CANDIDATES=5's honest-ambiguity ceiling.
      it('a hyphenated slug customerName ("qa-matrix-A-customer") with 3 invoices attaches a 3-candidate ambiguity', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'qa-matrix-A-customer',
          jobSummary: 'QA Matrix job for qa-matrix-A',
        });
        const first = await seedInvoiceForJob(seed, seed.jobId);
        const second = await seedInvoiceForJob(seed, seed.jobId);
        const third = await seedInvoiceForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'qa-matrix-A-customer',
          kind: 'invoice',
        });

        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.candidates.map((c) => c.id).sort()).toEqual(
            [first, second, third].sort(),
          );
        }
      });

      it('a customer with MORE invoices than a picker can show escalates instead of offering an arbitrary five', async () => {
        // Same overflow trap `resolveJob`/`resolveEstimate` already guard: a
        // customer's name matches EVERY invoice of theirs at 1.000, so a
        // repeat customer with six is ordinary, not exotic — `LIMIT 5` would
        // hand back a picker that need not contain the right one.
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        for (let i = 0; i < 6; i++) await seedInvoiceForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('not_found');
      });

      it('a purely filler reference matches nothing — an empty needle must not match every customer', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedInvoiceForJob(seed, seed.jobId);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('not_found');
      });

      it('never resolves an invoice by customer name across tenants', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedInvoiceForJob(seed, seed.jobId);
        const stranger = await createTestTenant(pool);

        const result = await resolver.resolve({
          tenantId: stranger.tenantId,
          reference: 'the Garcia invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('not_found');
      });

      it('an ARCHIVED customer cannot answer an invoice reference', async () => {
        const seed = await seedRealisticTenant({
          displayName: 'Jamie Garcia',
          jobSummary: 'AC repair',
        });
        await seedInvoiceForJob(seed, seed.jobId);
        await pool.query(`UPDATE customers SET is_archived = true WHERE id = $1`, [
          seed.customerId,
        ]);

        const result = await resolver.resolve({
          tenantId: seed.tenantId,
          reference: 'the Garcia invoice',
          kind: 'invoice',
        });
        expect(result.kind).toBe('not_found');
      });

      // Status floor, grounded in the execution handlers that consume the
      // resolved invoiceId: apply-late-fee-handler.ts and apply-credit-
      // handler.ts both hard-reject anything but 'open'/'partially_paid',
      // and send-payment-reminder's dunning guard treats 'void' as a send
      // that must never happen. No invoice-doc intent that reaches this
      // traversal ever wants a 'void' or 'canceled' invoice as its target —
      // sweep-tooling commit #940 independently observed "the customer->
      // invoice traversal has no status filter" forcing an unnecessary
      // disambiguation ask even on a clean two-invoice seed.
      describe('status floor — void/canceled excluded, draft stays reachable', () => {
        it('a VOID invoice never becomes a candidate — the one OPEN invoice resolves cleanly', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const openId = await seedInvoiceForJob(seed, seed.jobId);
          const voidId = await seedInvoiceForJob(seed, seed.jobId);
          await pool.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [voidId]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia invoice',
            kind: 'invoice',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(openId);
        });

        it('a CANCELED invoice never becomes a candidate either', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const openId = await seedInvoiceForJob(seed, seed.jobId);
          const canceledId = await seedInvoiceForJob(seed, seed.jobId);
          await pool.query(`UPDATE invoices SET status = 'canceled' WHERE id = $1`, [
            canceledId,
          ]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia invoice',
            kind: 'invoice',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(openId);
        });

        it('a customer whose ONLY invoice is void/canceled resolves not_found, never a guess', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const voidId = await seedInvoiceForJob(seed, seed.jobId);
          await pool.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [voidId]);

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia invoice',
            kind: 'invoice',
          });
          expect(result.kind).toBe('not_found');
        });

        // 'draft' is deliberately NOT filtered: send_invoice
        // (SendInvoiceTaskHandler) resolves this identical `invoiceId` field
        // to reach a draft invoice that has not gone out yet — the ordinary
        // case for that intent — and IssueInvoiceExecutionHandler requires
        // status === 'draft'. Excluding it here would silently break that
        // intent's resolution while fixing this one.
        it('a DRAFT invoice still resolves — draft is not in the excluded status set', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const localInvoiceRepo = new PgInvoiceRepository(pool);
          const draft = await createInvoice(
            {
              tenantId: seed.tenantId,
              jobId: seed.jobId,
              invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
              lineItems: [buildLineItem('li-1', 'Diagnostic', 1, 9900, 0, true, 'labor')],
              createdBy: seed.userId,
            },
            localInvoiceRepo,
          );
          expect(draft.status).toBe('draft');

          const result = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: 'the Garcia invoice',
            kind: 'invoice',
          });
          expect(result.kind).toBe('resolved');
          if (result.kind === 'resolved') expect(result.candidate.id).toBe(draft.id);
        });
      });

      // A21 (2026-08-31 live sweep) — same class one kind over from A11's
      // APPOINTMENT_WORK_TYPE_STOPWORDS fix: "qa-matrix-A-customer's
      // overdue invoice" got the honest can't-match line (#951/#954's
      // generalized reply layer working correctly) because the underlying
      // resolution genuinely came back not_found/low_confidence — the
      // status descriptor "overdue" polluted `invoiceNameNeedle`'s
      // customer-name needle exactly the way "tune-up" polluted the
      // appointment one.
      describe('qualified invoice reference — status descriptor stripped from the customer needle (A21)', () => {
        it('"<customer>\'s overdue invoice" resolves — the qualified form matches the bare form', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'qa-matrix-A-customer',
            jobSummary: 'Furnace tune-up',
          });
          const invoiceId = await seedInvoiceForJob(seed, seed.jobId);

          const bare = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: "qa-matrix-A-customer's invoice",
            kind: 'invoice',
          });
          const qualified = await resolver.resolve({
            tenantId: seed.tenantId,
            reference: "qa-matrix-A-customer's overdue invoice",
            kind: 'invoice',
          });

          expect(bare.kind).toBe('resolved');
          expect(qualified.kind).toBe('resolved');
          if (bare.kind === 'resolved' && qualified.kind === 'resolved') {
            expect(bare.candidate.id).toBe(invoiceId);
            expect(qualified.candidate.id).toBe(invoiceId);
          }
        });

        it('other evidenced status descriptors ("unpaid", "outstanding", "past due") resolve the same invoice', async () => {
          const seed = await seedRealisticTenant({
            displayName: 'Jamie Garcia',
            jobSummary: 'AC repair',
          });
          const invoiceId = await seedInvoiceForJob(seed, seed.jobId);

          for (const phrase of [
            'the Garcia unpaid invoice',
            'the Garcia outstanding bill',
            'the Garcia past due invoice',
          ]) {
            const result = await resolver.resolve({
              tenantId: seed.tenantId,
              reference: phrase,
              kind: 'invoice',
            });
            expect(result.kind, `"${phrase}" should resolve`).toBe('resolved');
            if (result.kind === 'resolved') {
              expect(result.candidate.id, `"${phrase}"`).toBe(invoiceId);
            }
          }
        });
      });
    });
  });

  // #909 (live sweeps 9/10) — catalogItemId gate had no resolver behind it
  // at all until now. `resolveLineItemToCatalog` (ai/resolution/
  // catalog-resolver.ts) is pinned by its own real-Postgres-independent unit
  // suite (it is a pure function over a preloaded array); this pins the NEW
  // SQL specifically — the exact live sweep's own duplicate-name shape
  // (`add_catalog_item` minting a fresh identically-named row every run).
  describe('catalogItem kind (#909, live sweeps 9/10)', () => {
    let catalogRepo: PgCatalogItemRepository;

    beforeAll(() => {
      catalogRepo = new PgCatalogItemRepository(pool);
    });

    async function seedCatalogItem(
      tenantId: string,
      name: string,
      unitPriceCents: number,
      createdBy: string,
    ): Promise<string> {
      const item = await catalogRepo.create(
        createCatalogItem({
          tenantId,
          name,
          category: 'Labor',
          unit: 'each',
          unitPriceCents,
        }),
      );
      return item.id;
    }

    it('an exact name match resolves with score 1.0', async () => {
      // A fresh tenant per test — NOT the file's shared `tenant` fixture —
      // so this suite's own duplicate-name tests below can never pollute
      // (or be polluted by) this one's candidate count.
      const seed = await createTestTenant(pool);
      const id = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        38500,
        seed.userId,
      );

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'QA Sweep Smart Thermostat Install',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(id);
        expect(result.candidate.score).toBe(1);
        expect(result.candidate.hint).toBe('$385.00');
      }
    });

    it('a partial reference ("the thermostat install") still resolves via strict_word_similarity', async () => {
      const seed = await createTestTenant(pool);
      const id = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        38500,
        seed.userId,
      );

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'the thermostat install',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') expect(result.candidate.id).toBe(id);
    });

    // The exact live-sweep shape: `add_catalog_item` mints a fresh, IDENTICALLY
    // named row every sweep round with nothing to quarantine the prior
    // rounds' copies. The resolver must ask, never guess which specific row
    // "89 dollars" was meant for.
    it('two duplicate-named ACTIVE items resolve as ambiguous, never a guess', async () => {
      const seed = await createTestTenant(pool);
      const first = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        38500,
        seed.userId,
      );
      const second = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        8900,
        seed.userId,
      );

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'QA Sweep Smart Thermostat Install',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.candidates.map((c) => c.id).sort()).toEqual([first, second].sort());
        // The one thing that tells two identically-named rows apart in a
        // picker a human can read — see gated-reference-resolution.ts's
        // `buildDisambiguationQuestion` same-name/distinct-hint branch.
        expect(result.candidates.map((c) => c.hint).sort()).toEqual(['$385.00', '$89.00'].sort());
      }
    });

    // An ARCHIVED duplicate is exactly what quarantining a stale sweep-run
    // copy looks like (see this file's own header note + the round's
    // report): `archive()` is the same repo method the Catalog screen's own
    // archive action calls, setting `archived_at`. Once archived, a
    // duplicate must stop contributing to the ambiguity — the resolver
    // should cleanly resolve the one still-active row.
    it('an ARCHIVED duplicate drops out — resolving cleanly to the one active row', async () => {
      const seed = await createTestTenant(pool);
      const active = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        8900,
        seed.userId,
      );
      const staleId = await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        38500,
        seed.userId,
      );
      const archived = await catalogRepo.archive(seed.tenantId, staleId);
      expect(archived).toBe(true);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'QA Sweep Smart Thermostat Install',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') expect(result.candidate.id).toBe(active);
    });

    it('no match at all returns not_found', async () => {
      const seed = await createTestTenant(pool);
      await seedCatalogItem(seed.tenantId, 'Water heater install', 145000, seed.userId);

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'flux capacitor',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('not_found');
    });

    it('never resolves a catalog item across tenants', async () => {
      const seed = await createTestTenant(pool);
      await seedCatalogItem(
        seed.tenantId,
        'QA Sweep Smart Thermostat Install',
        8900,
        seed.userId,
      );
      const stranger = await createTestTenant(pool);

      const result = await resolver.resolve({
        tenantId: stranger.tenantId,
        reference: 'QA Sweep Smart Thermostat Install',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('not_found');
    });

    it('a customer with MORE same-named items than a picker can show escalates instead of offering an arbitrary five', async () => {
      const seed = await createTestTenant(pool);
      for (let i = 0; i < 6; i++) {
        await seedCatalogItem(seed.tenantId, 'Filter replacement', 4500, seed.userId);
      }

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'Filter replacement',
        kind: 'catalogItem',
      });

      expect(result.kind).toBe('not_found');
    });
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
