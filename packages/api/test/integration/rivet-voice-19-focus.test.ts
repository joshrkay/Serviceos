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
 * scripted LLM gateway → the REAL `createVoiceActionRouterWorker`, wired with
 * the REAL `PgEntityResolver` plus `PgJobRepository` /
 * `PgAppointmentRepository` against a Postgres-seeded tenant → asserts the
 * resolved id lands on the drafted proposal's payload.
 *
 * Most of these handlers are documented passthroughs, so one scripted
 * gateway reply (the classification) is the whole conversation. The ONE
 * exception is `create_appointment`: `CreateAppointmentAITaskHandler` makes
 * its own drafting round-trip, so that case carries a second scripted reply
 * (`taskResponse`). That reply deliberately contains a hallucinated
 * customerId — the resolver's id must win — so the create leg still proves
 * "the spoken sentence produces the id", not "the script hands us the id".
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
  /**
   * Second scripted gateway reply, consumed only by task handlers that make
   * their own drafting round-trip after classification (today: exactly one —
   * `create_appointment`). Absent for the passthrough handlers, which never
   * call the gateway a second time.
   */
  taskResponse?: Record<string, unknown>;
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

/**
 * The full gateway script for one case, in call order: the classification
 * reply first, then (only where the handler round-trips again) the drafting
 * reply. `scriptedGateway` repeats its last entry, so a passthrough handler
 * that never makes a second call is unaffected.
 */
function scriptFor(c: FocusCase): unknown[] {
  return c.taskResponse ? [c.llmResponse, c.taskResponse] : [c.llmResponse];
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

    // B4.7 — "the Garcia job" with ONE upcoming appointment. Reused for the
    // reschedule, cancel AND create cases: none of the drafts-only tests
    // executes (approve/execute is out of scope here — that's the sibling
    // integration tests' job), so nothing mutates the appointment row.
    // `seedJob` also creates a customer whose display_name is exactly the
    // name spoken in the create case ("Garcia"), which is what the CREATE
    // leg resolves — the other two legs resolve the appointment instead.
    const { customerId: garciaCustomerId, jobId: garciaJobId } = await seedJob(
      'Garcia',
      'the Garcia job',
    );
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
      garciaCustomerId,
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
      const gateway = scriptedGateway(scriptFor(c));
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
    const gateway = scriptedGateway(scriptFor(negativeCase!));
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

  // ── B4.7 CREATE leg, the extra proof beyond the generic loop above ──
  //
  // B4.7 is conjunctive: book AND move AND cancel by speaking. The generic
  // loop above already asserts the drafted payload carries the resolver's
  // customerId for the spoken name. This block proves the two properties a
  // `payloadContainsSeedRefs` equality can't express on its own:
  //
  //   1. RESOLUTION BEATS THE MODEL. The drafting reply for this case carries
  //      a hallucinated customerId. The payload must carry the PgEntityResolver
  //      id instead — i.e. the id came from resolving the spoken words, not
  //      from anything the script handed the handler. (Found by the
  //      rivet-voice-19 re-measurement: the create leg's real-Postgres proof
  //      hand-built its payload as a literal, so it could only ever show that
  //      the handler works GIVEN resolved ids.)
  //   2. STORED UTC, RENDERED IN TENANT TZ. `resolveDateTime` — not the model,
  //      and not any local-time arithmetic in this file — turned the verbatim
  //      spoken phrase into a UTC instant against the TENANT's zone.
  it('B4.7 create leg — "Book Garcia … Thursday at 10 AM" resolves the spoken name through PgEntityResolver and books a UTC instant in the tenant timezone', async () => {
    const createCase = corpus.cases.find((c) => c.id === 'b4-7-create-appointment');
    expect(createCase, 'fixture must carry the create case').toBeDefined();
    const hallucinatedCustomerId = createCase!.taskResponse?.customerId as string;
    expect(hallucinatedCustomerId, 'the drafting script must hallucinate an id to beat').toBeTruthy();

    // Direct resolver-level proof: the spoken name alone resolves to the
    // seeded customer, with no id anywhere in the input.
    const direct = await entityResolver.resolve({
      tenantId: tenant.tenantId,
      reference: 'Garcia',
      kind: 'customer',
    });
    expect(direct.kind).toBe('resolved');
    if (direct.kind === 'resolved') {
      expect(direct.candidate.id).toBe(seedIds.garciaCustomerId);
    }

    // Full-stack proof via the router + the REAL CreateAppointmentAITaskHandler.
    const gateway = scriptedGateway(scriptFor(createCase!));
    const proposalRepo = new InMemoryProposalRepository();
    const worker = buildWorker(gateway, proposalRepo);
    await worker.handle(
      msg({ tenantId: tenant.tenantId, userId: tenant.userId, transcript: createCase!.utterance }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(tenant.tenantId);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.proposalType).toBe('create_appointment');
    const payload = proposal.payload as Record<string, unknown>;

    // (1) The model's id lost; the resolver's won.
    expect(payload.customerId).toBe(seedIds.garciaCustomerId);
    expect(payload.customerId).not.toBe(hallucinatedCustomerId);

    // (2) Stored UTC. Asserted on the raw string so a value that merely
    // *renders* correctly in the runner's local zone can't pass.
    expect(payload.scheduledStart).toBe('2026-08-06T15:00:00.000Z');
    expect(payload.scheduledEnd).toBe('2026-08-06T16:00:00.000Z');
    expect(payload.timezone).toBe(TENANT_TIMEZONE);

    // …and rendered in the TENANT's zone it is the Thursday 10 AM that was
    // spoken. Intl with an explicit timeZone — never the host's local time.
    const rendered = new Intl.DateTimeFormat('en-US', {
      timeZone: TENANT_TIMEZONE,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(payload.scheduledStart as string));
    expect(rendered).toBe('Thursday 10:00 AM');

    // Cross-tenant negative, matching the sibling voice proofs
    // (cancel-appointment-voice.test.ts): the same spoken name resolves to
    // NOTHING for a tenant that has no Garcia — resolution is tenant-scoped,
    // so a drafted booking can never borrow another tenant's customer.
    const other = await createTestTenant(pool);
    const crossTenant = await entityResolver.resolve({
      tenantId: other.tenantId,
      reference: 'Garcia',
      kind: 'customer',
    });
    expect(crossTenant.kind).toBe('not_found');
  });

  it('sanity: the corpus covers exactly the six operator-reachable focus cases plus the one negative case', () => {
    expect(corpus.cases).toHaveLength(7);
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const focusItems = new Set(corpus.cases.map((c) => c.op));
    expect(focusItems).toEqual(
      new Set([
        'add_note',
        'reassign_appointment',
        'log_time_entry',
        // B4.7 is conjunctive — all three legs (book / move / cancel) must be
        // in the corpus, each driven by FREE TEXT through PgEntityResolver.
        'create_appointment',
        'reschedule_appointment',
        'cancel_appointment',
      ]),
    );
  });
});
