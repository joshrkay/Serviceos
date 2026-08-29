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
});
