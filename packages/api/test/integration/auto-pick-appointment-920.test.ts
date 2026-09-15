/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * #920 (found during WS-A's #909 integration testing, live-evidenced by the
 * 2026-08-30 sweep, rows A11 reschedule_appointment / A27 confirm_appointment):
 * when a tenant has exactly ONE active appointment, `RescheduleAppointment
 * TaskHandler` / `ConfirmAppointmentTaskHandler`'s shared `resolveActive
 * AppointmentId` fallback auto-picks it TENANT-WIDE (neither
 * `reschedule_appointment` nor `confirm_appointment` is in routes/
 * assistant.ts's `CHAT_CONTEXT_CUSTOMER_ID_INTENTS` allowlist, so chat never
 * threads `context.customerId` for these two intents and the resolver's
 * customer-scoping branch never activates — the ONLY branch left is the
 * bare "exactly one active appointment in the tenant" fallback). That auto-
 * picked id is a REAL repo lookup, but neither handler recorded it in
 * `sourceContext.verifiedIds`, so routes/assistant.ts's `dropUnverifiedIds`
 * scrub — which deletes any id-shaped payload value that isn't verbatim in
 * the operator's words unless it's allowlisted there — stripped it right
 * back out (a spoken customer name never contains the appointment's UUID).
 * Because the handler's resolved branch never pushes 'appointmentId' onto
 * `missing` either (it only does that in the ELSE branches), the resulting
 * proposal carried NEITHER the id NOR a missingFields gate: it read as
 * fully approvable in the inbox, and `approveProposal` waved it through —
 * only to die at execution (sweep A11: `invalid input syntax for type
 * uuid: ""`; A27: `confirm_appointment requires a resolved appointmentId`).
 *
 * Fixed exactly like the A31 notify_delay case (approve-stall-five.test.ts)
 * already fixed for its own handler: whichever branch resolves
 * `payload.appointmentId` — the router-verified id OR the single-active-
 * appointment fallback — now also stamps `sourceContext.verifiedIds.
 * appointmentId`, so `dropUnverifiedIds` preserves it (ai/tasks/
 * voice-extended-tasks.ts, RescheduleAppointmentTaskHandler /
 * ConfirmAppointmentTaskHandler).
 *
 * This file proves the fix end to end against a real seeded Postgres row —
 * for BOTH handlers — and pins the multi-appointment case (still ambiguous,
 * still correctly gated) as a regression guard: the fix must never widen
 * resolution to "just pick one" when the tenant actually has more than one
 * active appointment tenant-wide.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { ValidationError } from '../../src/shared/errors';
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
const CUSTOMER_NAME = 'qa-920-customer';

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

describe('Integration — #920 auto-picked appointmentId survives dropUnverifiedIds', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
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
      jobNumber: `JOB-920-${jobId.slice(0, 8)}`,
      summary: 'Furnace tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { tenantId: t.tenantId, userId: t.userId, customerId, jobId };
  }

  async function seedAppointment(seed: Seed, start: Date, jobId = seed.jobId): Promise<string> {
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id,
      tenantId: seed.tenantId,
      jobId,
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

  /** A second, unrelated customer with their own job + appointment — makes
   * the tenant genuinely ambiguous (>1 active appointment tenant-wide). */
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
      jobNumber: `JOB-920B-${jobId.slice(0, 8)}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return seedAppointment(seed, start, jobId);
  }

  /** The REAL chat route, wired the way app.ts wires it. */
  function buildChatApp(seed: Seed, proposalRepo: InMemoryProposalRepository, gateway: LLMGateway) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seed.userId,
        sessionId: 'sess-920-int',
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
        locationRepo,
        auditRepo,
        tenantTimezoneResolver: async () => TZ,
      }),
    );
    return app;
  }

  async function executeApproved(
    proposal: Proposal,
  ): Promise<{ success: boolean; error?: string; resultEntityId?: string }> {
    const executionProposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      customerRepo,
      locationRepo,
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

  // ─────────────────────────────────────────────────────────────────────
  // A11 — reschedule_appointment, single-active-appointment tenant. This is
  // the exact #920 scenario: the tenant has ONE active appointment, chat
  // never threads customerId for this intent, so resolveActiveAppointmentId
  // falls through to its bare tenant-wide single-active branch. Pre-fix the
  // resulting proposal shipped with `appointmentId` set but NOT gated and
  // NOT verified — dropUnverifiedIds silently deleted it, leaving no id and
  // no gate.
  // ─────────────────────────────────────────────────────────────────────
  it('A11 reschedule_appointment: single active appointment auto-picks, survives dropUnverifiedIds, approves, executes', async () => {
    const seed = await seedTenant();
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const appointmentId = await seedAppointment(seed, start);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('reschedule_appointment', {
          customerName: CUSTOMER_NAME,
          appointmentReference: 'tune-up appointment',
          newDateTimeDescription: 'Friday at 10am',
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        // Corpus utterance shape (A11): "Move {{FIXTURE_CUSTOMER}}'s tune-up
        // appointment to Friday at 10am".
        messages: [
          { role: 'user', content: `Move ${CUSTOMER_NAME}'s tune-up appointment to Friday at 10am` },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('reschedule_appointment');
    // The fix's defining assertion: the auto-picked id survived
    // dropUnverifiedIds because it is now recorded in verifiedIds.
    expect(drafted.payload.appointmentId).toBe(appointmentId);
    expect(drafted.sourceContext?.verifiedIds).toMatchObject({ appointmentId });
    expect(missingFieldsFor(drafted)).toEqual([]);

    // The exact call that used to either 400 on a stripped id or approve a
    // doomed proposal in the live sweep (A11: executionError `invalid input
    // syntax for type uuid: ""`).
    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);
    expect(result.resultEntityId).toBe(appointmentId);

    const updated = await appointmentRepo.findById(seed.tenantId, appointmentId);
    expect(updated).toBeTruthy();
    // Friday 10am America/Phoenix (no DST, fixed UTC-7) — the resolver
    // picks the next Friday from `now`.
    expect(updated!.scheduledStart.getUTCHours()).toBe(17);
  });

  // ─────────────────────────────────────────────────────────────────────
  // A27 — confirm_appointment, single-active-appointment tenant. Same root
  // cause as A11, same fix, second handler. Pre-fix this died at execution
  // with "confirm_appointment requires a resolved appointmentId" — the
  // executor's own literal error text (full-app-voice-handlers.ts).
  // ─────────────────────────────────────────────────────────────────────
  it('A27 confirm_appointment: single active appointment auto-picks, survives dropUnverifiedIds, approves, executes', async () => {
    const seed = await seedTenant();
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const appointmentId = await seedAppointment(seed, start);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('confirm_appointment', { customerName: CUSTOMER_NAME }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      // Corpus utterance shape (A27): "Confirm {{FIXTURE_CUSTOMER}}'s
      // appointment".
      .send({ messages: [{ role: 'user', content: `Confirm ${CUSTOMER_NAME}'s appointment` }] });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('confirm_appointment');
    expect(drafted.payload.appointmentId).toBe(appointmentId);
    expect(drafted.sourceContext?.verifiedIds).toMatchObject({ appointmentId });
    expect(missingFieldsFor(drafted)).toEqual([]);

    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);
    expect(result.resultEntityId).toBe(appointmentId);

    const updated = await appointmentRepo.findById(seed.tenantId, appointmentId);
    expect(updated?.status).toBe('confirmed');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression guard: the fix must never widen resolution. With TWO active
  // appointments tenant-wide (and no customerId threaded for either intent
  // on chat — see the file doc comment), resolveActiveAppointmentId's
  // single-active fallback still correctly returns undefined, so both
  // handlers still gate on `missingFields: ['appointmentId']` and
  // `approveProposal` still refuses. The proposal keeps asking, exactly as
  // #920's own issue text specifies ("the multi-appointment ambiguity case
  // still asking").
  // ─────────────────────────────────────────────────────────────────────
  it('reschedule_appointment stays gated (still asks) when the tenant has more than one active appointment', async () => {
    const seed = await seedTenant();
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await seedAppointment(seed, start);
    await seedOtherCustomerWithAppointment(seed, new Date(start.getTime() + 5 * 60 * 60 * 1000));

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('reschedule_appointment', {
          customerName: CUSTOMER_NAME,
          appointmentReference: 'tune-up appointment',
          newDateTimeDescription: 'Friday at 10am',
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: `Move ${CUSTOMER_NAME}'s tune-up appointment to Friday at 10am` },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('reschedule_appointment');
    // NOT auto-picked — genuinely ambiguous tenant-wide.
    expect(drafted.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(drafted)).toContain('appointmentId');

    await expect(
      approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner'),
    ).rejects.toThrow(ValidationError);
  });
});
