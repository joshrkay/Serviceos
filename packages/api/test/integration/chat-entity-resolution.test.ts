/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * #909 — the chat entity-resolution loop against REAL Postgres.
 *
 * Two things can only be proven here, and both have bitten this repo before:
 *
 *  1. **The SQL is real.** The `lead` kind added for convert_lead /
 *     mark_lead_lost is brand-new SQL over a table the resolver had never
 *     touched. This module's unit suite mocks the Pool — which is EXACTLY how
 *     the entity resolver once shipped with column names that did not exist
 *     (name vs display_name, title vs summary; see the header on
 *     test/integration/entity-resolution.test.ts). A mocked Pool would happily
 *     accept `SELECT nonsense FROM leads`.
 *
 *  2. **The chain actually closes.** The live sweep's failure was not "the
 *     card looks wrong" — it was `POST /api/proposals/:id/approve` returning
 *     400 {missingFields:[...]} forever. So these tests drive the REAL chat
 *     route with the REAL PgEntityResolver over REAL seeded rows, then
 *     approve through the REAL guard and execute through the PRODUCTION
 *     execution registry, and assert the EXECUTED EFFECT in the database
 *     (P-44): the appointment actually moved.
 *
 * The classifier is the one stub — it is an LLM, and its extraction shape is
 * pinned by the handler-level suite (test/routes/assistant-entity-resolution.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  type ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TZ = 'America/Phoenix';
const CUSTOMER_NAME = 'qa-matrix-A-customer';

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('Integration — #909 chat entity resolution (real Postgres + real resolver)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;
  let leadRepo: PgLeadRepository;
  let catalogRepo: PgCatalogItemRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    leadRepo = new PgLeadRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    setSupervisorPresenceLoader(async () => true);
  });

  afterAll(async () => {
    _resetSupervisorPresenceCache();
    await closeSharedTestDb();
  });

  interface Seed {
    tenantId: string;
    userId: string;
    customerId: string;
    jobId: string;
  }

  /** Tenant (with a real zone) + a named customer + location + one job. */
  async function seedTenant(customerName = CUSTOMER_NAME): Promise<Seed> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
       VALUES ($1, $2, 'Sweep Test Shop', $3, 'AZ')`,
      [crypto.randomUUID(), t.tenantId, TZ],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: customerName,
      lastName: '',
      displayName: customerName,
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
      street1: '9 Elm Court',
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85201',
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
      jobNumber: `JOB-909-${jobId.slice(0, 8)}`,
      summary: 'Furnace tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { tenantId: t.tenantId, userId: t.userId, customerId, jobId };
  }

  async function seedAppointment(seed: Seed, start: Date): Promise<string> {
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id,
      tenantId: seed.tenantId,
      jobId: seed.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  /**
   * A second, unrelated customer with their own job and appointment — so the
   * tenant genuinely has more than one active appointment. Named nothing like
   * the customer under test, so it is a NEGATIVE control too: resolution must
   * pick the right one, not merely "an" appointment.
   */
  async function seedOtherCustomerWithAppointment(seed: Seed, start: Date): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: seed.tenantId,
      firstName: 'Wendell',
      lastName: 'Okonkwo',
      displayName: 'Wendell Okonkwo',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: seed.tenantId,
      customerId,
      street1: '41 Saguaro Way',
      city: 'Tempe',
      state: 'AZ',
      postalCode: '85281',
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
      tenantId: seed.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-909B-${jobId.slice(0, 8)}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: seed.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return appointmentId;
  }

  async function seedLead(
    seed: Seed,
    firstName: string,
    lastName: string,
    stage: 'new' | 'qualified' | 'won' | 'lost' = 'qualified',
  ): Promise<string> {
    const id = crypto.randomUUID();
    await leadRepo.create({
      id,
      tenantId: seed.tenantId,
      firstName,
      lastName,
      source: 'referral',
      stage,
      ...(stage === 'lost' ? { lostReason: 'seeded lost' } : {}),
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<PgLeadRepository['create']>[0]);
    return id;
  }

  /**
   * #909 (live sweep fix, 2026-08-30) — extra jobs for the SAME customer,
   * unrelated to scheduling (no appointment of their own). Replicates the
   * AI-catalog sweep's qa-matrix-A-customer fixture, which accumulates 7
   * jobs over one run (invoices, estimates, warranty notes, ...) — the
   * shape that tripped `resolveJob`'s job-count overflow guard and, through
   * it, blocked appointment resolution entirely (see pg-entity-resolver.ts,
   * `resolveJobIdsForCustomerName`'s doc comment).
   */
  async function seedExtraJobs(seed: Seed, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const jobId = crypto.randomUUID();
      await jobRepo.create({
        id: jobId,
        tenantId: seed.tenantId,
        customerId: seed.customerId,
        locationId: (await pool.query<{ id: string }>(
          `SELECT id FROM service_locations WHERE tenant_id = $1 AND customer_id = $2 LIMIT 1`,
          [seed.tenantId, seed.customerId],
        )).rows[0]!.id,
        jobNumber: `JOB-909X-${jobId.slice(0, 8)}`,
        summary: `Unrelated job ${i}`,
        status: 'new',
        priority: 'normal',
        createdBy: seed.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  /**
   * #909 (live sweep fix, 2026-08-30) — a real `invoices` row for the seed
   * job, inserted directly (no `InvoiceRepository` wired into this suite)
   * so the new customer→job→invoice traversal in `resolveInvoice` has a
   * real row to find. Mirrors migration 024's required columns.
   */
  async function seedInvoice(
    seed: Seed,
    invoiceNumber: string,
    status: string = 'open',
  ): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO invoices (id, tenant_id, job_id, invoice_number, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, seed.tenantId, seed.jobId, invoiceNumber, status, seed.userId],
    );
    return id;
  }

  /** The REAL chat route, wired the way app.ts wires it. */
  function buildApp(seed: Seed, proposalRepo: InMemoryProposalRepository, gateway: LLMGateway) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seed.userId,
        sessionId: 'sess-909-int',
        tenantId: seed.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway,
        proposalRepo,
        entityResolver: resolver,
        appointmentRepo,
        jobRepo,
        customerRepo,
        auditRepo,
        catalogRepo,
        tenantTimezoneResolver: async () => TZ,
      }),
    );
    return app;
  }

  async function executeApproved(proposal: Proposal): Promise<{ success: boolean; error?: string }> {
    const executionProposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — the same construction app.ts uses.
    const handlers = createExecutionHandlerRegistry({
      appointmentRepo,
      assignmentRepo,
      jobRepo,
      customerRepo,
      locationRepo,
      leadRepo,
      auditRepo,
    });
    const guard = new IdempotencyGuard(executionRepo, executionProposalRepo);
    const executor = new ProposalExecutor(handlers, executionProposalRepo, guard, auditRepo);
    // The undo window must have closed before the executor will act.
    const ready = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await executionProposalRepo.create(ready);
    const context: ExecutionContext = { tenantId: ready.tenantId, executedBy: ready.tenantId };
    const { result } = await executor.execute(ready, context);
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────
  // THE chain the issue is about: chat draft → resolve → approve → execute.
  // ───────────────────────────────────────────────────────────────────────
  it('A11 reschedule_appointment by CUSTOMER NAME: chat draft → resolve → approve → execute moves the real row', async () => {
    const seed = await seedTenant();
    const originalStart = DateTime.now()
      .setZone(TZ)
      .plus({ days: 2 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const appointmentId = await seedAppointment(seed, originalStart.toUTC().toJSDate());

    // A SECOND customer with their own appointment, on purpose. With exactly
    // one active appointment in the whole tenant, the drafting handler's
    // `resolveActiveAppointmentId` fallback auto-picks it tenant-wide and
    // the resolver is never exercised at all — the test would pass while
    // proving nothing. A real shop has more than one appointment, so this is
    // the honest fixture AND the one that forces the resolution under test.
    const other = await seedOtherCustomerWithAppointment(
      seed,
      originalStart.plus({ hours: 3 }).toUTC().toJSDate(),
    );
    expect(other).not.toBe(appointmentId);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('reschedule_appointment', {
          customerName: CUSTOMER_NAME,
          appointmentReference: `${CUSTOMER_NAME}'s tune-up appointment`,
          newDateTimeDescription: 'Friday at 10am',
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: `Move ${CUSTOMER_NAME}'s tune-up appointment to Friday at 10am`,
          },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('reschedule_appointment');

    // The resolver found the REAL appointment through the REAL customer name
    // (jobs joined to customers — the columns must actually exist).
    expect(drafted.payload.appointmentId).toBe(appointmentId);
    expect(missingFieldsFor(drafted)).toEqual([]);

    // The exact call that answered 400 in the live sweep.
    const approved = await approveProposal(
      proposalRepo,
      seed.tenantId,
      drafted.id,
      seed.userId,
      'owner',
    );
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);

    // EXECUTED EFFECT: the appointment actually moved in Postgres.
    const { rows } = await pool.query<{ scheduled_start: Date }>(
      `SELECT scheduled_start FROM appointments WHERE tenant_id = $1 AND id = $2`,
      [seed.tenantId, appointmentId],
    );
    expect(rows).toHaveLength(1);
    const moved = DateTime.fromJSDate(rows[0].scheduled_start).setZone(TZ);
    expect(moved.hour).toBe(10);
    expect(moved.toMillis()).not.toBe(originalStart.toMillis());
  });

  // ───────────────────────────────────────────────────────────────────────
  // The new `lead` SQL, against the real table.
  // ───────────────────────────────────────────────────────────────────────
  describe('lead kind — new SQL, pinned against the real leads table', () => {
    it('A26 convert_lead: resolves a real lead row and lifts the leadId gate', async () => {
      const seed = await seedTenant();
      const leadId = await seedLead(seed, 'Dana', 'Johnson');
      // A decoy under the same tenant that must NOT match.
      await seedLead(seed, 'Priya', 'Shah');

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([classifierReply('convert_lead', { leadReference: 'the Johnson lead' })]),
      );

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: 'Convert the Johnson lead to a customer' }] });
      expect(res.status).toBe(200);

      const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
      expect(drafted.proposalType).toBe('convert_lead');
      expect(drafted.payload.leadId).toBe(leadId);
      expect(missingFieldsFor(drafted)).not.toContain('leadId');

      await expect(
        approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });

    it('A28 mark_lead_lost: same resolution on the other lead intent', async () => {
      const seed = await seedTenant();
      const leadId = await seedLead(seed, 'Minh', 'Nguyen');

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([
          classifierReply('mark_lead_lost', {
            leadReference: 'the Nguyen lead',
            lostReason: 'went with a competitor',
          }),
        ]),
      );

      await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            { role: 'user', content: 'Mark the Nguyen lead lost, went with a competitor' },
          ],
        });

      const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
      expect(drafted.payload.leadId).toBe(leadId);
      expect(missingFieldsFor(drafted)).not.toContain('leadId');
    });

    it('a WON or LOST lead is never resolved — converting one again would mint a duplicate', async () => {
      const seed = await seedTenant();
      await seedLead(seed, 'Casey', 'Winford', 'won');
      await seedLead(seed, 'Casey', 'Winford', 'lost');

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'Casey Winford',
        kind: 'lead',
      });
      expect(result.kind).toBe('not_found');
    });

    it('is tenant-scoped: another tenant\'s lead is invisible', async () => {
      const mine = await seedTenant();
      const theirs = await seedTenant('other-tenant-customer');
      await seedLead(theirs, 'Dana', 'Johnson');

      const result = await resolver.resolve({
        tenantId: mine.tenantId,
        reference: 'the Johnson lead',
        kind: 'lead',
      });
      expect(result.kind).toBe('not_found');
    });

    it('two same-named live leads are AMBIGUOUS — a picker, never a guess', async () => {
      const seed = await seedTenant();
      const a = await seedLead(seed, 'Dana', 'Johnson');
      const b = await seedLead(seed, 'Marcus', 'Johnson');

      const result = await resolver.resolve({
        tenantId: seed.tenantId,
        reference: 'Johnson',
        kind: 'lead',
      });
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.candidates.map((c) => c.id).sort()).toEqual([a, b].sort());
      // Labels are readable, so the question this becomes is answerable.
      expect(result.candidates.every((c) => c.label.trim().length > 0)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ambiguity round trip, end to end, over real rows.
  // ───────────────────────────────────────────────────────────────────────
  it('ambiguity asks ONE question; the next chat turn answers it and approval unblocks', async () => {
    const seed = await seedTenant();
    await seedLead(seed, 'Dana', 'Johnson');
    const marcus = await seedLead(seed, 'Marcus', 'Johnson');

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      seed,
      proposalRepo,
      // ONE classifier script entry: the answer turn must not reclassify.
      scriptedGateway([classifierReply('convert_lead', { leadReference: 'the Johnson lead' })]),
    );
    const conversationId = crypto.randomUUID();

    const first = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: 'Convert the Johnson lead to a customer' }],
        conversationId,
      });
    expect(first.status).toBe(200);
    expect(first.body.message.content).toContain('Which lead did you mean');

    const [gated] = await proposalRepo.findByTenant(seed.tenantId);
    expect(gated.payload.leadId).toBeUndefined();
    await expect(
      approveProposal(proposalRepo, seed.tenantId, gated.id, seed.userId, 'owner'),
    ).rejects.toThrow(/leadId/);

    const second = await supertest(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Marcus' }], conversationId });
    expect(second.status).toBe(200);
    expect(second.body.taskType).toBe('assistant.entity_resolution');

    const [resolved] = await proposalRepo.findByTenant(seed.tenantId);
    expect(resolved.payload.leadId).toBe(marcus);
    await expect(
      approveProposal(proposalRepo, seed.tenantId, resolved.id, seed.userId, 'owner'),
    ).resolves.toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────
  // The gate must still hold when nothing resolves — no silent widening.
  // ───────────────────────────────────────────────────────────────────────
  it('an unknown reference keeps the gate and approval keeps refusing', async () => {
    const seed = await seedTenant();
    await seedLead(seed, 'Dana', 'Johnson');

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Zzyzx lead' }),
      ]),
    );

    await supertest(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Convert the Zzyzx lead' }] });

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted.payload.leadId).toBeUndefined();
    expect(missingFieldsFor(drafted)).toContain('leadId');
    await expect(
      approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner'),
    ).rejects.toThrow(/leadId/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // #909 (live sweep fix, 2026-08-30) — a customer with MANY jobs must not
  // lose appointment resolution to `resolveJob`'s job-count overflow guard.
  // Root cause: the 2026-08-30 AI-catalog sweep found cancel_appointment /
  // reassign_appointment / add_crew_member / remove_crew_member all drafting
  // with `appointmentReference` present and `missingFields: ['appointmentId']`
  // NEVER lifting — approve 400 VALIDATION_ERROR forever. The qa-matrix-A-
  // customer fixture accumulates 7 jobs over one sweep run but has only 2
  // live appointments; `resolveJob`'s own overflow guard (more than
  // MAX_JOB_CANDIDATES=5 confident matches) fired on the JOB count and
  // `resolveAppointment`'s named-reference branch treated that as a
  // terminal not_found, discarding a lookup that has no real ambiguity at
  // the APPOINTMENT level at all. These tests replicate that exact shape
  // against real Postgres.
  // ───────────────────────────────────────────────────────────────────────
  describe('appointment resolution — a customer with many jobs (live sweep A12–A15)', () => {
    it('A12 cancel_appointment by BARE customer name: gate lifts even with 7 unrelated jobs on the account', async () => {
      const seed = await seedTenant();
      const appointmentId = await seedAppointment(
        seed,
        DateTime.now().setZone(TZ).plus({ days: 1 }).toUTC().toJSDate(),
      );
      // 6 more jobs (7 total with seedTenant's own) — one more than
      // MAX_JOB_CANDIDATES, so `resolveJob`'s SQL (LIMIT 6) returns 6
      // confident matches and its overflow guard fires. None of these jobs
      // has an appointment of its own.
      await seedExtraJobs(seed, 6);

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([
          classifierReply('cancel_appointment', {
            // The EXACT live shape: a bare customer name, no job/date/time
            // words at all (corpus.json A12: "Cancel {{FIXTURE_CUSTOMER}}'s
            // appointment, customer request").
            appointmentReference: CUSTOMER_NAME,
            cancellationReason: 'customer request',
          }),
        ]),
      );

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            { role: 'user', content: `Cancel ${CUSTOMER_NAME}'s appointment, customer request` },
          ],
        });
      expect(res.status).toBe(200);

      const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
      expect(drafted.proposalType).toBe('cancel_appointment');
      expect(drafted.payload.appointmentId).toBe(appointmentId);
      expect(missingFieldsFor(drafted)).toEqual([]);

      // The exact call that answered 400 VALIDATION_ERROR live.
      const approved = await approveProposal(
        proposalRepo,
        seed.tenantId,
        drafted.id,
        seed.userId,
        'owner',
      );
      expect(approved.status).toBe('approved');

      const result = await executeApproved(approved);
      expect(result.success, result.error).toBe(true);

      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2`,
        [seed.tenantId, appointmentId],
      );
      expect(rows[0]!.status).toBe('canceled');
    });

    it("A13 reassign_appointment by \"<customer>'s appointment\": both technicianId AND appointmentId lift in one pass", async () => {
      const seed = await seedTenant();
      const appointmentId = await seedAppointment(
        seed,
        DateTime.now().setZone(TZ).plus({ days: 1 }).toUTC().toJSDate(),
      );
      await seedExtraJobs(seed, 6);

      const techId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, 'Tom', 'Baker', 'technician')`,
        [techId, seed.tenantId, `clerk-${techId.slice(0, 8)}`, `tom-${techId.slice(0, 8)}@example.test`],
      );

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([
          classifierReply('reassign_appointment', {
            // corpus.json A13: "Reassign {{FIXTURE_CUSTOMER}}'s appointment
            // to {{NEW_TECH_NAME}}".
            appointmentReference: `${CUSTOMER_NAME}'s appointment`,
            targetTechnicianName: 'Tom Baker',
          }),
        ]),
      );

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            { role: 'user', content: `Reassign ${CUSTOMER_NAME}'s appointment to Tom Baker` },
          ],
        });
      expect(res.status).toBe(200);

      const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
      expect(drafted.proposalType).toBe('reassign_appointment');
      expect(drafted.payload.toTechnicianId).toBe(techId);
      expect(drafted.payload.appointmentId).toBe(appointmentId);
      expect(missingFieldsFor(drafted)).toEqual([]);

      await expect(
        approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // #909 (live sweep fix, 2026-08-30) — invoice resolution has no
  // document-number reference to work with when the classifier extracts
  // (or the handler falls back to) a CUSTOMER NAME instead. Root cause:
  // send_payment_reminder's `invoiceReference` fallback writes the
  // customer's name onto the payload when no `jobReference`-shaped document
  // number was extracted (ApplyLateFeeTaskHandler / SendPaymentReminderTask
  // Handler, ai/tasks/voice-extended-tasks.ts), and `resolveInvoice` had NO
  // path from a name to an invoice at all — unlike `resolveEstimate`'s B7.6
  // customer→job→estimate traversal. These tests pin the new customer→
  // job→invoice traversal against real Postgres.
  // ───────────────────────────────────────────────────────────────────────
  describe('invoice resolution — customer-name traversal (live sweep A20)', () => {
    it('A20 send_payment_reminder by CUSTOMER NAME (no document number extracted): gate lifts to the one open invoice', async () => {
      const seed = await seedTenant();
      const invoiceId = await seedInvoice(seed, 'INV-0001', 'open');

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([
          classifierReply('send_payment_reminder', {
            // The EXACT live shape (2026-08-30 sweep, proposal
            // 6f0ee847-7465-45e7-887f-3dac092289a8): no jobReference at
            // all, only customerName — the classifier never extracted
            // "INV-0001" into the shared jobReference field, so the
            // handler's fallback wrote the customer's name onto
            // invoiceReference instead.
            customerName: CUSTOMER_NAME,
          }),
        ]),
      );

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            {
              role: 'user',
              content: `Send ${CUSTOMER_NAME} a payment reminder on invoice INV-0001`,
            },
          ],
        });
      expect(res.status).toBe(200);

      const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
      expect(drafted.proposalType).toBe('send_payment_reminder');
      expect(drafted.payload.invoiceReference).toBe(CUSTOMER_NAME);
      expect(drafted.payload.invoiceId).toBe(invoiceId);
      expect(missingFieldsFor(drafted)).toEqual([]);

      // The exact call that answered 400 VALIDATION_ERROR live.
      await expect(
        approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });

    it('two invoices on the same customer are AMBIGUOUS — one question, never a guess, and approval unblocks after the answer', async () => {
      const seed = await seedTenant();
      const first = await seedInvoice(seed, 'INV-0001', 'partially_paid');
      const second = await seedInvoice(seed, 'INV-0002', 'draft');

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        // ONE classifier script entry: the answer turn must not reclassify.
        scriptedGateway([
          classifierReply('apply_late_fee', { customerName: CUSTOMER_NAME, amount: 2500 }),
        ]),
      );
      const conversationId = crypto.randomUUID();

      const first_res = await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            { role: 'user', content: `Apply a 25 dollar late fee to ${CUSTOMER_NAME}'s invoice` },
          ],
          conversationId,
        });
      expect(first_res.status).toBe(200);
      expect(first_res.body.message.content).toContain('Which invoice did you mean');

      const [gated] = await proposalRepo.findByTenant(seed.tenantId);
      expect(gated.payload.invoiceId).toBeUndefined();
      await expect(
        approveProposal(proposalRepo, seed.tenantId, gated.id, seed.userId, 'owner'),
      ).rejects.toThrow(/invoiceId/);

      // Both candidates score IDENTICALLY on the customer-name match (same
      // customer, same needle), so which one Postgres returns "first" on a
      // tied `ORDER BY score DESC` is not something to assert on. Answer by
      // NAME instead — a real operator naming the invoice number is exactly
      // what `isDisambiguationAnswer`/`matchDisambiguationFollowUp` are for,
      // and it pins a specific, deterministic outcome.
      const secondRes = await supertest(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: 'INV-0001' }], conversationId });
      expect(secondRes.status).toBe(200);

      const [resolved] = await proposalRepo.findByTenant(seed.tenantId);
      expect(resolved.payload.invoiceId).toBe(first);
      expect(resolved.payload.invoiceId).not.toBe(second);
      await expect(
        approveProposal(proposalRepo, seed.tenantId, resolved.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // #909 (live sweeps 9/10) — catalog item resolution, update_catalog_item.
  //
  // Root cause: UpdateCatalogItemTaskHandler (ai/tasks/voice-extended-tasks.ts)
  // dropped BOTH the spoken item reference and the spoken price from the
  // payload whenever its own draft-time resolution (resolveLineItemToCatalog)
  // could not confidently pick a row — `payload.proposedUnitPriceCents` was
  // written ONLY inside `if (resolvedItem)`, so a genuinely valid spoken
  // price vanished with no trace and no gate to explain the loss. Separately,
  // `catalogItemId` had no entry in GATED_REFERENCE_SOURCES at all — a gate
  // with no resolver behind it (#909's own defect class), so even a
  // preserved reference had nowhere to go on chat. These tests pin the exact
  // live shape: proposal 4d370bef-08a6-4745-93e0-df3140fc7638 (tenant
  // a948cc66), "Raise the QA Sweep Smart Thermostat Install price to 89
  // dollars", against the sweep's own fixture defect — `add_catalog_item`
  // mints a fresh, identically-named catalog row every run with nothing to
  // quarantine the prior runs' copies, so by round 9/10 the reference is
  // genuinely ambiguous, not merely unresolved.
  // ───────────────────────────────────────────────────────────────────────
  describe('catalog item resolution — update_catalog_item (live sweep A36, #909)', () => {
    async function seedCatalogItemFor(
      seed: Seed,
      name: string,
      unitPriceCents: number,
    ): Promise<string> {
      const item = await catalogRepo.create(
        createCatalogItem({
          tenantId: seed.tenantId,
          name,
          category: 'Labor',
          unit: 'each',
          unitPriceCents,
        }),
      );
      return item.id;
    }

    it('the exact live utterance against a DUPLICATE-named catalog (sweep 9/10 shape): asks instead of dropping the price silently', async () => {
      const seed = await seedTenant();
      const first = await seedCatalogItemFor(seed, 'QA Sweep Smart Thermostat Install', 38500);
      const second = await seedCatalogItemFor(seed, 'QA Sweep Smart Thermostat Install', 8900);

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        // ONE classifier script entry: the answer turn must not reclassify.
        scriptedGateway([
          classifierReply('update_catalog_item', {
            catalogItemReference: 'QA Sweep Smart Thermostat Install',
            unitPriceCents: 8900,
          }),
        ]),
      );
      const conversationId = crypto.randomUUID();

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({
          messages: [
            {
              role: 'user',
              content: 'Raise the QA Sweep Smart Thermostat Install price to 89 dollars',
            },
          ],
          conversationId,
        });
      expect(res.status).toBe(200);
      // The live-broken behavior this test pins RED against: before the
      // fix, payload carried nothing but `_meta` and the reply never asked
      // anything — approve just 400'd forever with no way to tell why. Both
      // candidates share a name, so this hits `buildDisambiguationQuestion`'s
      // same-name branch ("Which one?"), not the distinct-names phrasing.
      expect(res.body.message.content).toContain('matching "QA Sweep Smart Thermostat Install"');
      expect(res.body.message.content).toContain('Which one?');

      const [gated] = await proposalRepo.findByTenant(seed.tenantId);
      expect(missingFieldsFor(gated)).toEqual(['catalogItemId']);
      expect(gated.payload.itemReference).toBe('QA Sweep Smart Thermostat Install');
      expect(gated.payload.proposedUnitPriceCents).toBe(8900);
      const pending = (gated.sourceContext as Record<string, unknown>).pendingEntityAmbiguity as
        | Record<string, unknown>
        | undefined;
      expect(pending).toBeTruthy();
      const candidateIds = (pending!.candidates as Array<{ id: string }>).map((c) => c.id).sort();
      expect(candidateIds).toEqual([first, second].sort());
      await expect(
        approveProposal(proposalRepo, seed.tenantId, gated.id, seed.userId, 'owner'),
      ).rejects.toThrow(/catalogItemId/);

      // The two candidates share a name, so `buildDisambiguationQuestion`'s
      // same-name branch must fall back to the one thing that DOES tell
      // them apart — price — rather than the customer-shaped "address or
      // phone number" prompt.
      expect(res.body.message.content).toMatch(/\$385\.00/);
      expect(res.body.message.content).toMatch(/\$89\.00/);
      expect(res.body.message.content).not.toMatch(/address or phone/i);

      // Answer by ordinal — `parseOrdinalIndex`/`matchDisambiguationFollowUp`
      // resolve "1"/"2" deterministically regardless of which candidate a
      // tied `ORDER BY score DESC` happened to return first, so this does
      // not assert WHICH of the two same-priced-looking-but-not rows won —
      // only that the gate lifts to ONE of them and the proposal then
      // approves, D-029's answer turn closed.
      const secondRes = await supertest(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: '1' }], conversationId });
      expect(secondRes.status).toBe(200);

      const [resolved] = await proposalRepo.findByTenant(seed.tenantId);
      expect([first, second]).toContain(resolved.payload.catalogItemId);
      expect(missingFieldsFor(resolved)).toEqual([]);
      await expect(
        approveProposal(proposalRepo, seed.tenantId, resolved.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });

    it('a unique item name resolves the gate unambiguously — no ask needed', async () => {
      const seed = await seedTenant();
      const itemId = await seedCatalogItemFor(seed, 'AC diagnostic fee', 7900);

      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp(
        seed,
        proposalRepo,
        scriptedGateway([
          classifierReply('update_catalog_item', {
            catalogItemReference: 'AC diagnostic fee',
            unitPriceCents: 8900,
          }),
        ]),
      );

      const res = await supertest(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: 'Raise the AC diagnostic fee to 89 dollars' }] });
      expect(res.status).toBe(200);

      const [resolved] = await proposalRepo.findByTenant(seed.tenantId);
      expect(resolved.payload.catalogItemId).toBe(itemId);
      expect(resolved.payload.proposedUnitPriceCents).toBe(8900);
      expect(missingFieldsFor(resolved)).toEqual([]);
      await expect(
        approveProposal(proposalRepo, seed.tenantId, resolved.id, seed.userId, 'owner'),
      ).resolves.toBeTruthy();
    });
  });
});
