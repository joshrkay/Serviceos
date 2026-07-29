/**
 * rivet-voice-19 focus items — operator entity-resolution closed loop
 * (real Postgres).
 *
 * GAP THIS CLOSES (run-log.md decisions #8/#9): `test/voice/operator-ops-loop.test.ts`
 * drives the REAL `createVoiceActionRouterWorker` with a scripted LLM gateway
 * against `test/voice/fixtures/operator-ops-top-40.json`, proving
 * utterance → classified intent → proposal type → missingFields/action-class
 * gates. But it constructs the worker with only `{ gateway, proposalRepo }` —
 * no entity resolver, no repos — so it proves classification and gating, but
 * NOT entity resolution. Separately, the focus items' own integration tests
 * (add-note-voice-execution.test.ts, log-time-entry-execution.test.ts,
 * reassign-appointment-voice.test.ts, reschedule-appointment-voice.test.ts,
 * cancel-appointment-voice.test.ts) all hand-supply the resolved id directly
 * on `TaskContext.existingEntities` — they prove the task handler works
 * GIVEN a resolved id, not that the spoken sentence PRODUCES that id.
 *
 * This suite is the sibling that closes that gap: fixture JSON (one case per
 * operator-reachable focus item, entities as bare free text — no ids) →
 * scripted LLM gateway (classification only; these handlers are documented
 * passthroughs, no second drafting round-trip) → the REAL
 * `createVoiceActionRouterWorker`, wired with the REAL `PgEntityResolver`
 * plus `PgJobRepository` / `PgAppointmentRepository` against a
 * Postgres-seeded tenant → asserts the resolved id lands on the drafted
 * proposal's payload.
 *
 * FORM CHOICE: an in-memory/fake `EntityResolver` was rejected. The negative
 * case (B5.3's resolver fix — a NAMED job reference that matches nothing must
 * never fall through to the tenant-wide "soonest upcoming appointment"
 * fallback) is a property of `PgEntityResolver.resolveAppointment`'s OWN
 * fallback logic (pg-entity-resolver.ts, b5.3-design.md §3), not of the
 * router. A fake resolver written for this file would just be re-testing
 * whatever fallback behavior *this file* implements — it would prove nothing
 * about the real fix. So this is a real-Postgres integration test
 * (`test/integration/`, testcontainers-gated), not a `test/voice/` fixture
 * harness — matching the master task's documented fallback option.
 *
 * Runs only under `npm run test:integration`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { assignTechnician } from '../../src/appointments/assignment';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
  actionClassForProposalType,
  type ProposalType,
  type ActionClass,
} from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures/rivet-voice-19-focus.json');

// Matches reschedule-appointment-voice.test.ts's fixed NOW + tenant timezone
// + phrase exactly — that pairing is already proven (by that file) to
// resolve "Thursday at 10" deterministically via resolveDateTime.
const NOW = new Date('2026-08-03T17:00:00.000Z');
const TENANT_TIMEZONE = 'America/Chicago';

interface CaseExpect {
  proposalType: ProposalType;
  status?: string;
  actionClass?: ActionClass;
  missingFieldsExact?: string[];
  missingFieldsContains?: string[];
  payloadContains?: Record<string, unknown>;
  /** payload key -> key into the runner's seedIds map (resolved at test time). */
  payloadContainsSeedRefs?: Record<string, string>;
  /** B5.3 negative case: the payload must carry NO appointmentId at all. */
  payloadAppointmentIdMustBeUnset?: boolean;
}

interface FocusCase {
  id: string;
  focusItem: string;
  op: string;
  utterance: string;
  note?: string;
  llmResponse: { intentType: string; confidence: number; extractedEntities: Record<string, unknown> };
  expect: CaseExpect;
}

interface FocusCorpus {
  version: number;
  title: string;
  description: string;
  cases: FocusCase[];
}

function loadCorpus(): FocusCorpus {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FocusCorpus;
}

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function scriptedGateway(responses: unknown[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(responses[Math.min(i++, responses.length - 1)]),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
  };
}

const corpus = loadCorpus();

describe('rivet-voice-19 focus items — operator entity-resolution closed loop (real Postgres)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let entityResolver: PgEntityResolver;
  let tenant: TestTenant;
  let seedIds: Record<string, string>;

  /**
   * Seeds a customer + location + job whose `summary` is set to the EXACT
   * text the case's extractedEntities reference — the same technique
   * test/integration/entity-resolution.test.ts's AC-3 suite uses
   * (`seedTenantWithJobAppointments`) to get a deterministic score-1.0
   * trigram match, so a case failing to resolve can only be a real
   * regression, never fixture-text drift.
   */
  async function seedJob(name: string, jobSummary: string): Promise<{ customerId: string; jobId: string }> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: name,
      lastName: 'Customer',
      displayName: name,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: `1 ${name} Way`,
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
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${name.toUpperCase()}-${jobId.slice(0, 8)}`,
      summary: jobSummary,
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { customerId, jobId };
  }

  async function seedAppointment(
    jobId: string,
    daysOut: number,
    technicianId?: string,
  ): Promise<string> {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + daysOut);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: TENANT_TIMEZONE,
      status: 'scheduled',
      holdPendingApproval: false,
      notes: 'seeded for rivet-voice-19-focus',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (technicianId) {
      await assignTechnician(
        {
          tenantId: tenant.tenantId,
          appointmentId,
          technicianId,
          technicianRole: 'technician',
          isPrimary: true,
          assignedBy: tenant.userId,
        },
        assignmentRepo,
      );
    }
    return appointmentId;
  }

  async function seedTechnician(firstName: string, lastName: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
      [
        id,
        tenant.tenantId,
        `clerk-${id}`,
        `${firstName}.${lastName}.${id.slice(0, 8)}@example.com`.toLowerCase(),
        firstName,
        lastName,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    entityResolver = new PgEntityResolver(pool);
    tenant = await createTestTenant(pool);

    // B7.4 / B6.3 — "the Patel job" (no appointment needed for either case).
    const { jobId: patelJobId } = await seedJob('Patel', 'the Patel job');

    // B5.3 — "the Johnson job" with ONE upcoming appointment, initially
    // assigned to a DIFFERENT technician than the reassignment target
    // (mirrors reassign-appointment-voice.test.ts's techA/techB shape).
    const aidenId = await seedTechnician('Aiden', 'Cole');
    const carlosId = await seedTechnician('Carlos', 'Vega');
    const { jobId: johnsonJobId } = await seedJob('Johnson', 'the Johnson job');
    const johnsonAppointmentId = await seedAppointment(johnsonJobId, 3, aidenId);

    // B4.7 — "the Garcia job" with ONE upcoming appointment. Reused for both
    // the reschedule AND cancel cases: neither drafts-only test executes
    // (approve/execute is out of scope here — that's the sibling
    // integration tests' job), so nothing mutates the appointment row.
    const { jobId: garciaJobId } = await seedJob('Garcia', 'the Garcia job');
    const garciaAppointmentId = await seedAppointment(garciaJobId, 5);

    // Tenant now has TWO active upcoming appointments (Johnson + Garcia).
    // That matters: RescheduleAppointmentTaskHandler/CancelAppointmentTaskHandler
    // fall back to `resolveActiveAppointmentId` (tenant-wide "exactly one
    // active appointment") ONLY when the router's resolver seam didn't
    // answer. With two active appointments that fallback returns undefined
    // (ambiguous), so the reschedule/cancel cases below can ONLY pass via
    // the router's job-name → appointment resolution — proving this suite
    // exercises real resolution, not the legacy single-appointment shortcut
    // (the same property reschedule-appointment-voice.test.ts's P-3
    // regression pin checks with hand-fed ids).

    seedIds = {
      patelJobId,
      johnsonJobId,
      johnsonAppointmentId,
      garciaJobId,
      garciaAppointmentId,
      carlosId,
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function buildWorker(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
    return createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      entityResolver,
      jobRepo,
      appointmentRepo,
      tenantSchedulingResolver: async () => ({ timezone: TENANT_TIMEZONE }),
      now: () => NOW,
    });
  }

  for (const c of corpus.cases) {
    it(`${c.id} [${c.focusItem}]: "${c.utterance}" → ${c.expect.proposalType}`, async () => {
      const gateway = scriptedGateway([c.llmResponse]);
      const proposalRepo = new InMemoryProposalRepository();
      const worker = buildWorker(gateway, proposalRepo);

      await worker.handle(
        msg({ tenantId: tenant.tenantId, userId: tenant.userId, transcript: c.utterance }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(tenant.tenantId);
      expect(proposals, `${c.id}: proposal count`).toHaveLength(1);
      const proposal = proposals[0]!;

      expect(proposal.proposalType, `${c.id}: proposalType`).toBe(c.expect.proposalType);

      if (c.expect.status) {
        expect(proposal.status, `${c.id}: status`).toBe(c.expect.status);
      }

      if (c.expect.actionClass) {
        expect(
          actionClassForProposalType(proposal.proposalType),
          `${c.id}: actionClass`,
        ).toBe(c.expect.actionClass);
        if (c.expect.actionClass !== 'capture') {
          expect(proposal.status, `${c.id}: non-capture stays draft`).toBe('draft');
        }
      }

      const missing = missingFieldsFor(proposal);
      if (c.expect.missingFieldsExact) {
        expect(missing, `${c.id}: missingFieldsExact`).toEqual(c.expect.missingFieldsExact);
      }
      if (c.expect.missingFieldsContains) {
        for (const field of c.expect.missingFieldsContains) {
          expect(missing, `${c.id}: missingFieldsContains ${field}`).toContain(field);
        }
      }

      const payload = proposal.payload as Record<string, unknown>;

      if (c.expect.payloadContains) {
        for (const [key, value] of Object.entries(c.expect.payloadContains)) {
          expect(payload[key], `${c.id}: payload.${key}`).toEqual(value);
        }
      }

      if (c.expect.payloadContainsSeedRefs) {
        for (const [key, seedKey] of Object.entries(c.expect.payloadContainsSeedRefs)) {
          const expected = seedIds[seedKey];
          expect(expected, `${c.id}: fixture seedRef '${seedKey}' must exist`).toBeDefined();
          expect(payload[key], `${c.id}: payload.${key} (resolved via '${seedKey}')`).toBe(expected);
        }
      }

      if (c.expect.payloadAppointmentIdMustBeUnset) {
        expect(payload.appointmentId, `${c.id}: payload.appointmentId must be unset`).toBeUndefined();
      }
    });
  }

  // ── B5.3 negative case, the extra proof beyond the generic loop above ──
  //
  // The generic assertion (payload.appointmentId undefined,
  // missingFieldsContains 'appointmentId') already proves the proposal
  // gated. This block proves the STRONGER claim the master task asks for:
  // the router did not merely fail to resolve — it specifically did NOT
  // fall back to the tenant's soonest upcoming appointment (Johnson's,
  // 3 days out — sooner than Garcia's 5). Pre-B5.3-fix, this exact
  // scenario (name-bearing reference, no job match, tenant has upcoming
  // appointments) would have silently returned Johnson's appointment.
  it('B5.3 negative — "the Fitzgerald job" resolves to not_found, never Johnson\'s (the tenant\'s soonest) appointment', async () => {
    const negativeCase = corpus.cases.find((c) => c.id === 'b5-3-negative-named-reference-must-not-fall-back');
    expect(negativeCase, 'fixture must carry the negative case').toBeDefined();

    // Direct resolver-level proof: calling PgEntityResolver exactly the way
    // the router does for this reference returns not_found, not Johnson's
    // (the soonest) appointment id.
    const direct = await entityResolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'the Fitzgerald job',
      kind: 'appointment',
    });
    expect(direct.kind).toBe('not_found');
    if (direct.kind === 'not_found') {
      expect(direct.reference).toBe('the Fitzgerald job');
    }

    // Full-stack proof via the router + real task handler: the drafted
    // proposal's appointmentId is neither Johnson's nor Garcia's — the
    // gate fired instead of guessing at all.
    const gateway = scriptedGateway([negativeCase!.llmResponse]);
    const proposalRepo = new InMemoryProposalRepository();
    const worker = buildWorker(gateway, proposalRepo);
    await worker.handle(
      msg({ tenantId: tenant.tenantId, userId: tenant.userId, transcript: negativeCase!.utterance }),
      silentLogger(),
    );
    const proposals = await proposalRepo.findByTenant(tenant.tenantId);
    expect(proposals).toHaveLength(1);
    const payload = proposals[0]!.payload as Record<string, unknown>;
    expect(payload.appointmentId).toBeUndefined();
    expect(payload.appointmentId).not.toBe(seedIds.johnsonAppointmentId);
    expect(payload.appointmentId).not.toBe(seedIds.garciaAppointmentId);
    // Never silently downgraded to a plain free-text field the review UI
    // can't act on — the reference is still carried for the operator.
    expect(payload.appointmentReference).toBe('the Fitzgerald job');
  });

  it('sanity: the corpus covers exactly the five operator-reachable focus cases plus the one negative case', () => {
    expect(corpus.cases).toHaveLength(6);
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const focusItems = new Set(corpus.cases.map((c) => c.op));
    expect(focusItems).toEqual(
      new Set([
        'add_note',
        'reassign_appointment',
        'log_time_entry',
        'reschedule_appointment',
        'cancel_appointment',
      ]),
    );
  });
});
