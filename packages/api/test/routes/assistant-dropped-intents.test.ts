/**
 * Task 15 (2026-08-07 tradesperson plan) — the wider B5 completion.
 *
 * `routes/assistant.ts`'s chat dispatch (`CHAT_INTENT_TO_REGISTRY_KEY`,
 * shared by the chain map and the single-intent map) was missing 18 intents
 * that already had a full, working drafting handler in the shared registry
 * (`ai/orchestration/handler-registry.ts buildTaskHandlers`) and already
 * drafted correctly on the recorded-memo surface
 * (`workers/voice-action-router.ts`). Each one silently refused (or, before
 * the honesty guard existed, fell through to a bare conversational LLM
 * reply) on chat instead of drafting.
 *
 * The plan named six (`add_crew_member`, `remove_crew_member`,
 * `mark_lead_lost`, `add_service_location`, `convert_lead`,
 * `request_feedback`). A derivation against `INTENT_TO_PROPOSAL_TYPE` (every
 * key checked against both chat dispatch maps) found twelve more:
 * `record_refund`, `apply_credit`, `send_customer_message`,
 * `create_change_order`, `create_service_agreement`, `add_material`,
 * `log_mileage`, `update_catalog_item`, `add_catalog_item`,
 * `schedule_inspection`, `log_permit`, `log_warranty_claim` — 18 total.
 * `CHAT_DISPATCH_EXCLUDED_INTENTS` names the four that stay unwired —
 * `respond_to_review` / `create_standing_instruction` / `update_brand_voice`
 * have no handler in the shared registry at all (structurally unwireable);
 * `emergency_dispatch` DOES have one but is excluded on this wave's plan's
 * own explicit instruction (line 1221) — a real, documented memo/chat
 * divergence, not a false one. See that constant's doc comment in
 * `routes/assistant.ts`.
 *
 * These tests pin three things:
 *   1. DISPATCH — a chat turn classified as one of the 18 produces a
 *      proposal card, not a conversational fallback / refusal.
 *   2. CORRECTNESS — the draft's payload is actually right, not just
 *      present. Several of these intents depend on context the memo router
 *      injects that chat did not previously supply:
 *        - `context.intent` (Task 11): `log_mileage` shares `LogExpense-
 *          TaskHandler` with plain `log_expense` and tells them apart ONLY
 *          via `context.intent` — dispatching it without threading that
 *          field would silently draft a plain, wrong-category expense.
 *          Threaded UNCONDITIONALLY (harmless for every intent that doesn't
 *          read it).
 *        - `context.customerId` (top-level, NOT `existingEntities.
 *          customerId`): quality review found this canNOT be threaded
 *          unconditionally the way `intent` is — see
 *          `CHAT_CONTEXT_CUSTOMER_ID_INTENTS`'s doc comment in
 *          `routes/assistant.ts` (C1/C2) for the full story. In short: three
 *          of the 18 (`send_customer_message`, `create_service_agreement`,
 *          `add_service_location`) read it EXCLUSIVELY and need it; a FOURTH,
 *          `schedule_inspection`, is admitted too as a deliberate, tested
 *          exception (new intent, no shipped behavior to regress); but at
 *          least ten ALREADY-SHIPPED chat intents (`create_appointment`,
 *          `confirm_appointment`, `notify_delay`, `send_payment_reminder`,
 *          …) read the SAME field as an unrelated, exclusive side channel —
 *          a real calendar-hold DB write, an unsupervised appointment
 *          auto-pick — that this task must not silently activate. The fix is
 *          an explicit allowlist, not a blanket thread.
 *        - `existingEntities.{jobId,invoiceId,technicianId,appointmentId}`
 *          — already shared via `resolveVoiceEntityReferences` (the SAME
 *          function + membership sets the memo worker uses), confirmed
 *          working here rather than assumed.
 *   3. THE CHAIN PATH — a "…, then …" turn is a SEPARATE code path with its
 *      own registry-key lookup and its own `intent:` / `customerId:`
 *      threading; it is exercised here too, not just the single-intent path.
 *
 * NO LIVE LLM CALLS — every gateway is a scripted fake.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAssistantRouter,
  CHAT_INTENT_TO_REGISTRY_KEY,
  CHAT_CONTEXT_CUSTOMER_ID_INTENTS,
  CHAT_DISPATCH_EXCLUDED_INTENTS,
} from '../../src/routes/assistant';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { buildTaskHandlers } from '../../src/ai/orchestration/handler-registry';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';

const TEST_TENANT = 'tenant-dropped-intents';
const TEST_USER = 'user-dropped-intents';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/** Classifier responses are read as JSON by classifyIntent. */
function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

/**
 * Quality-review fix — a repeating `scriptedGateway` (last response reused
 * for every call past the scripted list) silently masks a handler making
 * MORE gateway calls than the test author expected: the send_customer_message
 * test below originally asserted only `customerId`, so it never noticed its
 * ONE scripted response (the classifier JSON) was ALSO being fed to
 * `SendCustomerMessageTaskHandler`'s own rewrite call, landing the raw JSON
 * blob on `payload.body`. `strictGateway` throws instead of repeating, so a
 * handler that calls the gateway more times than scripted fails LOUDLY at
 * the call site rather than silently passing on the wrong content.
 */
function strictGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      if (i >= responses.length) {
        throw new Error(
          `strictGateway: gateway.complete() called ${i + 1} times but only ${responses.length} response(s) were scripted`,
        );
      }
      const content = responses[i++];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

type ResolverImpl = (input: { tenantId: string; reference: string; kind: string }) => Promise<EntityResolverResult>;

function resolverFor(impl: ResolverImpl): EntityResolver {
  return { resolve: vi.fn(impl) } as unknown as EntityResolver;
}

interface BuildAppOpts {
  proposalRepo?: InMemoryProposalRepository;
  entityResolver?: EntityResolver;
  catalogRepo?: import('../../src/catalog/catalog-item').CatalogItemRepository;
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
  appointmentRepo?: InMemoryAppointmentRepository;
  jobRepo?: InMemoryJobRepository;
  locationRepo?: InMemoryLocationRepository;
  // I3 (post-C1 review, followup-autoapprove-default) — per-tenant
  // auto-approve threshold override resolver, mirroring
  // workers/voice-action-router.ts's `thresholdResolver` dep exactly.
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined>;
}

function buildApp(gateway: LLMGateway, opts: BuildAppOpts = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-dropped',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: opts.proposalRepo ?? new InMemoryProposalRepository(),
      ...(opts.entityResolver ? { entityResolver: opts.entityResolver } : {}),
      ...(opts.catalogRepo ? { catalogRepo: opts.catalogRepo } : {}),
      ...(opts.tenantTimezoneResolver ? { tenantTimezoneResolver: opts.tenantTimezoneResolver } : {}),
      ...(opts.appointmentRepo ? { appointmentRepo: opts.appointmentRepo } : {}),
      ...(opts.jobRepo ? { jobRepo: opts.jobRepo } : {}),
      ...(opts.locationRepo ? { locationRepo: opts.locationRepo } : {}),
      ...(opts.thresholdResolver ? { thresholdResolver: opts.thresholdResolver } : {}),
    }),
  );
  return app;
}

async function chat(app: ReturnType<typeof buildApp>, content: string) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }] });
}

// ─────────────────────────── dispatch-only intents ──────────────────────────
// No router-injected id, no context.intent/customerId dependency — a plain
// dispatch + payload-shape check is the whole correctness story.

describe('Task 15 — dropped intents now dispatch (no special context needed)', () => {
  it('convert_lead: drafts a convert_lead proposal carrying the spoken lead reference', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([classifierReply('convert_lead', { leadReference: 'the Johnson lead' })]),
      { proposalRepo },
    );

    const res = await chat(app, 'Convert the Johnson lead to a customer');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('convert_lead');
    expect((persisted[0].payload as Record<string, unknown>).leadReference).toBe('the Johnson lead');
    expect(res.body.message.proposal).toBeTruthy();
    expect(res.body.taskType).not.toMatch(/unhandled|not_understood/);
  });

  it('mark_lead_lost: drafts with the spoken reference and reason', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('mark_lead_lost', {
          leadReference: 'the Davis lead',
          lostReason: 'went with a competitor',
        }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'We lost the Davis lead, went with a competitor');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('mark_lead_lost');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.leadReference).toBe('the Davis lead');
    expect(payload.reason).toBe('went with a competitor');
    expect(res.body.message.proposal).toBeTruthy();
  });

  it('request_feedback: drafts carrying the spoken job reference', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([classifierReply('request_feedback', { jobReference: 'the Johnson job' })]),
      { proposalRepo },
    );

    const res = await chat(app, 'Send a feedback request for the Johnson job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('request_feedback');
    expect((persisted[0].payload as Record<string, unknown>).jobReference).toBe('the Johnson job');
    expect(res.body.message.proposal).toBeTruthy();
  });

  it('add_catalog_item: drafts a new price-book entry with the spoken name and price', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('add_catalog_item', {
          catalogItemNewName: 'Smart thermostat install',
          unitPriceCents: 38500,
        }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'Add a catalog item: smart thermostat install, 385');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('add_catalog_item');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.name).toBe('Smart thermostat install');
    expect(payload.unitPriceCents).toBe(38500);
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('log_permit: drafts an add_note proposal whose body is the PERMIT-prefixed text', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('log_permit', {
          jobReference: 'the Patel job',
          noteBody: 'PERMIT: 2024-1187 approved',
        }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'Log permit 2024-1187 on the Patel job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // log_permit is an ALIAS onto add_note's proposal type (voice-intent-map.ts)
    expect(persisted[0].proposalType).toBe('add_note');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.body).toBe('PERMIT: 2024-1187 approved');
    expect(res.body.message.proposal).toBeTruthy();
  });

  it('log_warranty_claim: drafts a create_job proposal titled with the warranty description', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('log_warranty_claim', {
          customerName: 'Henderson',
          jobTitle: "Warranty — water heater pilot won't stay lit",
        }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, "Log a warranty callback for the Hendersons' water heater");

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // log_warranty_claim is an ALIAS onto create_job's proposal type.
    expect(persisted[0].proposalType).toBe('create_job');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.title).toBe("Warranty — water heater pilot won't stay lit");
    expect(payload.customerReference).toBe('Henderson');
    expect(res.body.message.proposal).toBeTruthy();
  });

  it('schedule_inspection: drafts a REAL create_appointment proposal (full pipeline, not a stub)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('schedule_inspection', {
          customerName: 'Patel',
          jobReference: 'the Patel job',
          jobTitle: 'Inspection — rough-in',
          dateTimeDescription: 'Thursday at 2pm',
        }),
        // CreateAppointmentAITaskHandler's OWN second (drafting) LLM call —
        // an empty object is fine: extractDateTimePhrase falls back to the
        // classifier's dateTimeDescription regardless of what this returns.
        '{}',
      ]),
      { proposalRepo, tenantTimezoneResolver: async () => 'America/New_York' },
    );

    const res = await chat(app, 'Book the rough-in inspection on the Patel job Thursday at 2pm');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // schedule_inspection is an ALIAS onto create_appointment's proposal type
    // — dispatched to the exact same handler create_appointment already uses.
    expect(persisted[0].proposalType).toBe('create_appointment');
    // Not a voice_clarification: the date phrase resolved, proving the alias
    // reached the FULL real handler (timezone + resolveDateTime), not a stub.
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(typeof payload.scheduledStart).toBe('string');
    expect(typeof payload.scheduledEnd).toBe('string');
  });
});

// ────────────────────── context.intent threading (Task 11) ──────────────────

describe('Task 15 — log_mileage requires context.intent threading (Task 11 parity)', () => {
  it('drafts category "vehicle" with amountCents = miles × 70¢, NOT a plain log_expense', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([classifierReply('log_mileage', { mileageMiles: 32, jobReference: 'the Patel job' })]),
      { proposalRepo },
    );

    const res = await chat(app, 'Log 32 miles to the Patel job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // log_mileage is an ALIAS onto log_expense's proposal type.
    expect(persisted[0].proposalType).toBe('log_expense');
    const payload = persisted[0].payload as Record<string, unknown>;
    // THE regression this pins: without context.intent === 'log_mileage'
    // threaded through, LogExpenseTaskHandler cannot tell this apart from a
    // plain log_expense turn — category stays 'other' and amountCents comes
    // from the (absent) ee.amount, gating the proposal on a wrong shape.
    expect(payload.category).toBe('vehicle');
    expect(payload.amountCents).toBe(Math.round(32 * 70));
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('a plain log_expense turn is unaffected by the new context.intent field (no regression)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('log_expense', {
          amount: 24000,
          expenseCategory: 'materials',
          jobReference: 'the Johnson job',
        }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'Log 240 dollars at the supply house for the Johnson job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('log_expense');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.category).toBe('materials');
    expect(payload.amountCents).toBe(24000);
  });
});

// ───────────────────── context.customerId threading (top-level) ─────────────
// send_customer_message / create_service_agreement / add_service_location all
// read `context.customerId` DIRECTLY (not `existingEntities.customerId`),
// mirroring the memo worker's precedence. Chat only ever threaded a resolved
// id into `existingEntities`, so without also setting `context.customerId`
// these three would draft permanently gated even with a resolver wired.

describe('Task 15 — context.customerId (top-level) threading parity', () => {
  const RESOLVED_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

  function customerResolver(): EntityResolver {
    return resolverFor(async ({ kind }) =>
      kind === 'customer'
        ? {
            kind: 'resolved',
            candidate: { id: RESOLVED_CUSTOMER_ID, kind: 'customer', label: 'Henderson', score: 0.95 },
          }
        : { kind: 'skipped' },
    );
  }

  it('send_customer_message: the resolved customerId reaches context.customerId, AND the draft body/channel are actually correct', async () => {
    // Quality-review fix — a repeating scriptedGateway would feed
    // SendCustomerMessageTaskHandler's OWN rewrite call the SAME classifier
    // JSON string as "content", silently landing that raw JSON blob on
    // payload.body — invisible unless something asserts on body/channel.
    // strictGateway (two DISTINCT scripted responses) plus real assertions
    // on both fields close that hole.
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      strictGateway([
        classifierReply('send_customer_message', {
          customerName: 'Henderson',
          customerMessageBody: 'The part arrived, we can come Thursday',
        }),
        // SendCustomerMessageTaskHandler's own rewrite pass (responseFormat: 'text').
        'The part arrived — we can come by Thursday.',
      ]),
      { proposalRepo, entityResolver: customerResolver() },
    );

    const res = await chat(app, 'Text the Hendersons the part arrived, we can come Thursday');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('send_customer_message');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(payload.body).toBe('The part arrived — we can come by Thursday.');
    expect(payload.channel).toBe('sms');
    expect(res.body.message.proposal.missingFields ?? []).not.toContain('customerId');
  });

  it('create_service_agreement: the resolved customerId reaches context.customerId; cadence maps to the correct RRULE', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_service_agreement', {
          customerName: 'Garcia',
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 29000,
        }),
      ]),
      { proposalRepo, entityResolver: customerResolver() },
    );

    const res = await chat(app, 'Sign the Garcias up for the annual maintenance plan, 290 a year');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('create_service_agreement');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(payload.recurrenceRule).toBe('FREQ=YEARLY');
    expect(payload.priceCents).toBe(29000);
    expect(res.body.message.proposal.missingFields ?? []).not.toContain('customerId');
  });

  it('add_service_location: the resolved customerId reaches context.customerId', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('add_service_location', {
          customerName: 'Sarah',
          serviceAddress: '412 Oak Street',
        }),
      ]),
      { proposalRepo, entityResolver: customerResolver() },
    );

    const res = await chat(app, 'Add a service location for Sarah at 412 Oak Street');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('add_service_location');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(payload.addressText).toBe('412 Oak Street');
    expect(res.body.message.proposal.missingFields ?? []).not.toContain('customerId');
  });

  it('without an entity resolver wired, these three still draft — gated on customerId, not doomed or refused', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([classifierReply('add_service_location', { customerName: 'Sarah', serviceAddress: '412 Oak Street' })]),
      { proposalRepo },
    );

    const res = await chat(app, 'Add a service location for Sarah at 412 Oak Street');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('add_service_location');
    expect(res.body.message.proposal.missingFields).toContain('customerId');
  });
});

// ────────── C1/C2 quality-review fix — customerId thread is an allowlist ────
//
// Quality review found that threading `context.customerId` for EVERY intent
// (mirroring the memo worker blindly) activates unrelated, exclusive-reader
// side effects on intents this task never touched:
//
//   C1 — CreateAppointmentAITaskHandler's held-slot branch (create-appointment-
//   task.ts) treats a truthy customerId as enough to pass place-hold.ts's
//   ownership guard when an appointmentRepo is wired and the drafting LLM
//   echoes a jobId — writing a REAL `appointments` row at DRAFT time, before
//   any human review, as a `create_booking` proposal with
//   `sourceTrustTier: 'autonomous'`.
//   C2 — ConfirmAppointmentTaskHandler / NotifyDelayTaskHandler's
//   resolveActiveAppointmentId only scopes to the named customer when
//   customerId is truthy; unscoped it can only auto-pick when the ENTIRE
//   TENANT has exactly one active appointment (never, in practice) — scoped,
//   it auto-picks whenever that ONE customer has exactly one qualifying
//   appointment (common). notify_delay's own class doc calls this out:
//   "resolving to a different customer's appointment would message the wrong
//   person."
//
// The fix: CHAT_CONTEXT_CUSTOMER_ID_INTENTS is an explicit allowlist (only
// send_customer_message / create_service_agreement / add_service_location /
// schedule_inspection). These tests pin that the fix actually holds —
// create_appointment and confirm_appointment, both ALREADY wired before
// Task 15, keep their pre-Task-15 behavior byte-for-byte even with a full
// production-shaped dependency set (entityResolver + appointmentRepo +
// jobRepo) wired.
describe('C1/C2 — context.customerId is NOT threaded for already-shipped intents', () => {
  const RESOLVED_CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OTHER_CUSTOMER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function customerAndJobResolver(jobId: string): EntityResolver {
    return resolverFor(async ({ kind }) => {
      if (kind === 'customer') {
        return {
          kind: 'resolved',
          candidate: { id: RESOLVED_CUSTOMER_ID, kind: 'customer', label: 'Henderson', score: 0.95 },
        };
      }
      if (kind === 'job') {
        return { kind: 'resolved', candidate: { id: jobId, kind: 'job', label: 'Henderson job', score: 0.95 } };
      }
      return { kind: 'skipped' };
    });
  }

  it('C1: create_appointment does NOT enter the held-slot path — no appointment row is written, even with appointmentRepo + jobRepo + entityResolver all wired', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: '55555555-5555-4555-8555-555555555555',
      tenantId: TEST_TENANT,
      customerId: RESOLVED_CUSTOMER_ID,
      locationId: 'loc-1',
      jobNumber: 'JOB-0001',
      summary: 'Furnace tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);

    const app = buildApp(
      strictGateway([
        classifierReply('create_appointment', {
          customerName: 'Henderson',
          jobReference: 'the Henderson job',
          dateTimeDescription: 'Thursday at 2pm',
        }),
        // The drafting LLM's own second call — echoes the job id the way
        // buildUserMessage's "Known entities:" hint invites it to. If
        // context.customerId leaked through here, this is exactly the shape
        // that satisfies place-hold.ts's ownership guard.
        JSON.stringify({ jobId: job.id }),
      ]),
      {
        proposalRepo,
        entityResolver: customerAndJobResolver(job.id),
        appointmentRepo,
        jobRepo,
        tenantTimezoneResolver: async () => 'America/New_York',
      },
    );

    const res = await chat(app, 'Book Henderson for Thursday at 2pm, furnace tune-up');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // NOT create_booking — the held-slot WRITE never succeeded.
    expect(persisted[0].proposalType).toBe('create_appointment');
    // The defining assertion: no real calendar-hold row was written.
    const appointments = await appointmentRepo.findByJob(TEST_TENANT, job.id);
    expect(appointments).toHaveLength(0);
    // The held-slot branch DOES attempt (appointmentRepo is wired and the
    // drafting LLM echoed a well-formed jobId) — but place-hold.ts's
    // ownership guard fails closed on the missing customerId
    // (`!args.customerId` → 'job_not_owned') and falls back to
    // `reviewGatedFallback()`, which explicitly overrides `sourceTrustTier`
    // to `undefined` before calling `createProposal` — `decideInitialStatus`
    // returns 'draft' unconditionally whenever `sourceTrustTier` is falsy
    // (this route then promotes every fresh 'draft' straight to
    // 'ready_for_review' so it appears in the inbox — never 'approved'), so
    // this proposal can never auto-approve, unlike a plain create_appointment
    // (which normally carries `sourceTrustTier: 'autonomous'` and CAN
    // auto-approve on confidence). This is the pre-Task-15 behavior exactly
    // (customerId was always undefined on chat before this task existed).
    expect(persisted[0].status).toBe('ready_for_review');
  });

  it('C2: confirm_appointment does NOT auto-resolve via customer-scoped appointment lookup, even with a resolver + appointmentRepo + jobRepo wired', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();

    const jobForResolvedCustomer: Job = {
      id: 'job-for-resolved-customer',
      tenantId: TEST_TENANT,
      customerId: RESOLVED_CUSTOMER_ID,
      locationId: 'loc-1',
      jobNumber: 'JOB-0002',
      summary: 'AC repair',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const jobForOtherCustomer: Job = {
      ...jobForResolvedCustomer,
      id: 'job-for-other-customer',
      customerId: OTHER_CUSTOMER_ID,
      jobNumber: 'JOB-0003',
    };
    await jobRepo.create(jobForResolvedCustomer);
    await jobRepo.create(jobForOtherCustomer);

    // Two active appointments tenant-wide: one for the resolved customer,
    // one for someone else. If customerId leaked through, scoping to the
    // resolved customer would leave exactly ONE candidate and auto-pick it
    // — the exact bug. Unscoped (correct, pre-Task-15 behavior), the tenant
    // has TWO active appointments, so resolution stays gated.
    await appointmentRepo.create({
      id: 'appt-for-resolved-customer',
      tenantId: TEST_TENANT,
      jobId: jobForResolvedCustomer.id,
      scheduledStart: new Date(Date.now() + 86_400_000),
      scheduledEnd: new Date(Date.now() + 90_000_000),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: false,
    });
    await appointmentRepo.create({
      id: 'appt-for-other-customer',
      tenantId: TEST_TENANT,
      jobId: jobForOtherCustomer.id,
      scheduledStart: new Date(Date.now() + 86_400_000),
      scheduledEnd: new Date(Date.now() + 90_000_000),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: false,
    });

    const app = buildApp(
      strictGateway([
        classifierReply('confirm_appointment', {
          customerName: 'Henderson',
          appointmentReference: 'the appointment',
        }),
      ]),
      {
        proposalRepo,
        entityResolver: customerAndJobResolver(jobForResolvedCustomer.id),
        appointmentRepo,
        jobRepo,
      },
    );

    const res = await chat(app, 'Confirm the Henderson appointment');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('confirm_appointment');
    const payload = persisted[0].payload as Record<string, unknown>;
    // Pre-Task-15 (correct) behavior preserved: unscoped resolution sees TWO
    // active appointments tenant-wide, so it stays gated rather than
    // auto-picking the resolved customer's one appointment.
    expect(payload.appointmentId).toBeUndefined();
    expect(res.body.message.proposal.missingFields).toContain('appointmentId');
  });
});

// ───── schedule_inspection — the one intent CHAT_CONTEXT_CUSTOMER_ID_INTENTS
// deliberately admits despite triggering the SAME C1 mechanism ────────────
//
// Unlike create_appointment/confirm_appointment above, schedule_inspection is
// a BRAND-NEW chat intent (Task 15) with no shipped behavior to regress, and
// it is genuinely both a CUSTOMER_REF_INTENTS and JOB_REF_INTENTS member — so
// admitting it to the customerId allowlist is a deliberate, tested choice,
// not an oversight. This test drives it with the SAME full production-shaped
// dependency set (entityResolver + appointmentRepo + jobRepo + locationRepo)
// app.ts wires, and asserts what it ACTUALLY produces rather than assuming.
describe('schedule_inspection — full dependency set (the allowlist\'s one deliberate admission)', () => {
  const RESOLVED_CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(() => {
    _resetSupervisorPresenceCache();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  /**
   * Shared fixture builder — a resolved, customer-owned job plus a drafting
   * LLM that echoes the known jobId with a high confidence_score. Both tests
   * below drive the IDENTICAL request; only tenant supervision differs, so
   * whatever status difference shows up is attributable to that ALONE.
   */
  function buildScheduleInspectionApp() {
    const proposalRepo = new InMemoryProposalRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    const job: Job = {
      id: '66666666-6666-4666-8666-666666666666',
      tenantId: TEST_TENANT,
      customerId: RESOLVED_CUSTOMER_ID,
      locationId: 'loc-patel',
      jobNumber: 'JOB-0010',
      summary: 'Rough-in electrical',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { proposalRepo, appointmentRepo, jobRepo, locationRepo, job };
  }

  function scheduleInspectionEntityResolver(job: Job) {
    return resolverFor(async ({ kind }) => {
      if (kind === 'customer') {
        return {
          kind: 'resolved',
          candidate: { id: RESOLVED_CUSTOMER_ID, kind: 'customer', label: 'Patel', score: 0.95 },
        };
      }
      if (kind === 'job') {
        return { kind: 'resolved', candidate: { id: job.id, kind: 'job', label: 'Patel job', score: 0.95 } };
      }
      return { kind: 'skipped' };
    });
  }

  it('supervisor genuinely on duty + confidence over the mode-aware threshold: places a real held slot AND auto-approves it', async () => {
    // Fixed behavior (commit 1): assistant-chat now resolves real tenant
    // supervision the same way workers/voice-action-router.ts does. With a
    // supervisor on duty, `create_booking`'s 0.95 confidence clears the
    // 'supervisor'-mode threshold (0.90 — req.auth.mode defaults to
    // 'supervisor' with no userModeLoader wired in this test), so this is a
    // PRINCIPLED auto-approval, not an accident of a threading gap.
    setSupervisorPresenceLoader(async () => true);

    const { proposalRepo, appointmentRepo, jobRepo, locationRepo, job } =
      buildScheduleInspectionApp();
    await jobRepo.create(job);
    const entityResolver = scheduleInspectionEntityResolver(job);

    const app = buildApp(
      strictGateway([
        classifierReply('schedule_inspection', {
          customerName: 'Patel',
          jobReference: 'the Patel job',
          jobTitle: 'Inspection — rough-in',
          dateTimeDescription: 'Thursday at 2pm',
        }),
        // The drafting LLM's own second call echoes the known jobId — a
        // realistic completion given buildUserMessage's "Known entities:"
        // hint names it explicitly — with a high confidence_score, exactly
        // the shape a real confident model completion takes.
        JSON.stringify({ jobId: job.id, confidence_score: 0.95 }),
      ]),
      {
        proposalRepo,
        entityResolver,
        appointmentRepo,
        jobRepo,
        locationRepo,
        tenantTimezoneResolver: async () => 'America/New_York',
      },
    );

    const res = await chat(app, 'Book the rough-in inspection on the Patel job Thursday at 2pm');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // This IS the documented, accepted consequence of admitting
    // schedule_inspection to the allowlist: a real tentative hold is placed
    // and the proposal comes back as create_booking — same mechanism C1
    // flagged, deliberately accepted here because there is no pre-Task-15
    // chat behavior for schedule_inspection to regress.
    expect(persisted[0].proposalType).toBe('create_booking');
    const appointments = await appointmentRepo.findByJob(TEST_TENANT, job.id);
    expect(appointments).toHaveLength(1);
    expect(appointments[0].holdPendingApproval).toBe(true);
    expect(persisted[0].status).toBe('approved');
    // Commit 2 — the chat reply must not contradict what actually happened.
    // Before this fix, `proposalToUI` hardcoded `status: 'Pending'` and the
    // reply text unconditionally said "Review and approve to proceed" even
    // though the DB row above is already 'approved' and headed for
    // execution — the UI actively lying about a proposal that no longer
    // needs (or permits) a review tap.
    expect(res.body.message.proposal.status).toBe('Approved');
    expect(res.body.message.content).not.toMatch(/review and approve/i);
  });

  it('no supervisor on duty: places the same held slot but does NOT auto-approve it', async () => {
    // The other half of the same pin: an IDENTICAL request, with the tenant
    // genuinely unsupervised. Before commit 1, assistant-chat never threaded
    // supervisorPresent at all, so this case was indistinguishable from the
    // supervised one above — both auto-approved via the legacy 0.9 fallback.
    // Chat never sets context.autonomousBooking (the D-015 lane's own
    // inputs — that lane is threaded only by the inbound-receptionist call
    // sites), so there is no scoped exception here: unsupervised must mean
    // 'ready_for_review', full stop.
    setSupervisorPresenceLoader(async () => false);

    const { proposalRepo, appointmentRepo, jobRepo, locationRepo, job } =
      buildScheduleInspectionApp();
    await jobRepo.create(job);
    const entityResolver = scheduleInspectionEntityResolver(job);

    const app = buildApp(
      strictGateway([
        classifierReply('schedule_inspection', {
          customerName: 'Patel',
          jobReference: 'the Patel job',
          jobTitle: 'Inspection — rough-in',
          dateTimeDescription: 'Thursday at 2pm',
        }),
        JSON.stringify({ jobId: job.id, confidence_score: 0.95 }),
      ]),
      {
        proposalRepo,
        entityResolver,
        appointmentRepo,
        jobRepo,
        locationRepo,
        tenantTimezoneResolver: async () => 'America/New_York',
      },
    );

    const res = await chat(app, 'Book the rough-in inspection on the Patel job Thursday at 2pm');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // The held slot is still placed — the write itself is unaffected by
    // supervision, only the STATUS decision is.
    expect(persisted[0].proposalType).toBe('create_booking');
    const appointments = await appointmentRepo.findByJob(TEST_TENANT, job.id);
    expect(appointments).toHaveLength(1);
    expect(appointments[0].holdPendingApproval).toBe(true);
    // No human ever reviewed this booking before commit 1. Now it lands in
    // the review queue like every other unsupervised auto-approve candidate.
    expect(persisted[0].status).toBe('ready_for_review');
    // Commit 2 — the flip side of the same pin: a genuinely-pending card
    // must still say "review and approve" (this direction already worked
    // pre-fix, since `status: 'Pending'` was always the hardcoded default —
    // asserted here so the two tests together pin BOTH branches of the new
    // conditional, not just the one that changed).
    expect(res.body.message.proposal.status).toBe('Pending');
    expect(res.body.message.content).toMatch(/review and approve/i);
  });
});

// ───── I3 (post-C1 review) — the tenant auto-approve threshold override ─────
//
// `tenant_settings.auto_approve_threshold` (the Settings UI value) is keyed
// BY MODE, so `resolveAutoApproveThreshold` can only consult it once
// `supervisorMode` is known — and commit 1 made chat the first (and,
// as of this fix, only) caller anywhere in the codebase that threads a real
// `supervisorMode`. These tests prove the override actually takes effect on
// chat now that it's threaded, using the IDENTICAL update_job scenario with
// and without a stricter override.

describe('I3 — tenant threshold override actually affects chat auto-approval', () => {
  const RESOLVED_JOB_ID = '99999999-9999-4999-8999-999999999999';

  async function buildUpdateJobApp(opts: { thresholdResolver?: BuildAppOpts['thresholdResolver'] }) {
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    const job: Job = {
      id: RESOLVED_JOB_ID,
      tenantId: TEST_TENANT,
      customerId: 'cust-threshold',
      locationId: 'loc-threshold',
      jobNumber: 'JOB-THRESHOLD',
      summary: 'Threshold override job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: TEST_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
    const entityResolver = resolverFor(async ({ kind }) =>
      kind === 'job'
        ? { kind: 'resolved', candidate: { id: job.id, kind: 'job', label: 'Threshold job', score: 0.95 } }
        : { kind: 'skipped' },
    );
    const app = buildApp(
      strictGateway([
        classifierReply('update_job', { jobReference: 'the threshold job', status: 'completed' }),
        // UpdateJobTaskHandler makes its OWN drafting call (job-edit-task.ts)
        // after the classifier — it does not reuse the classifier's
        // confidence, so this second completion carries the real
        // confidence_score the auto-approve decision is based on.
        JSON.stringify({
          jobReference: 'the threshold job',
          status: 'completed',
          confidence_score: 0.95,
        }),
      ]),
      {
        proposalRepo,
        entityResolver,
        jobRepo,
        ...(opts.thresholdResolver ? { thresholdResolver: opts.thresholdResolver } : {}),
      },
    );
    return { app, proposalRepo, jobRepo, job };
  }

  it('with NO override: 0.95 confidence clears the default supervisor threshold (0.90) and auto-approves', async () => {
    const { app, proposalRepo } = await buildUpdateJobApp({});
    const res = await chat(app, 'Mark the threshold job as completed');
    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe('approved');
  });

  it('with a stricter override (supervisor: 0.99): the SAME 0.95-confidence request no longer auto-approves', async () => {
    const thresholdResolver = async () => ({ supervisor: 0.99 });
    const { app, proposalRepo } = await buildUpdateJobApp({ thresholdResolver });
    const res = await chat(app, 'Mark the threshold job as completed');
    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    // The Settings UI value now genuinely blocks what the default would
    // have approved — proof the override is threaded and consulted, not
    // silently discarded by the mode-undefined early return.
    expect(persisted[0].status).not.toBe('approved');
  });
});

// ───────────────── I1 — CHAT_DISPATCH_EXCLUDED_INTENTS contract ─────────────

describe('I1 — intents deliberately excluded from chat dispatch never appear in the registry map', () => {
  it('none of respond_to_review / create_standing_instruction / update_brand_voice / emergency_dispatch is a CHAT_INTENT_TO_REGISTRY_KEY member', () => {
    for (const intent of CHAT_DISPATCH_EXCLUDED_INTENTS) {
      expect(Object.prototype.hasOwnProperty.call(CHAT_INTENT_TO_REGISTRY_KEY, intent)).toBe(false);
    }
  });

  it('respond_to_review / create_standing_instruction / update_brand_voice have no handler in the shared registry at all (structurally unwireable)', () => {
    const registry = buildTaskHandlers({ gateway: strictGateway([]) });
    expect(registry.has('review_response_proposal' as never)).toBe(false);
    expect(registry.has('create_standing_instruction' as never)).toBe(false);
    expect(registry.has('update_brand_voice' as never)).toBe(false);
  });

  it('emergency_dispatch DOES have a handler (the exclusion is a plan decision, not a structural limit)', () => {
    const registry = buildTaskHandlers({ gateway: strictGateway([]) });
    expect(registry.has('emergency_dispatch')).toBe(true);
  });
});

// ───────────── I3 — CHAT_INTENT_TO_REGISTRY_KEY is the single source ────────
//
// Quality review: `chainHandlers` and `proposalHandlers` used to be two
// hand-maintained object-literal copies of the same key list — construction
// never drifted, but the key list did, repeatedly. Both dispatch sites now
// derive from ONE module-scope constant (`CHAT_INTENT_TO_REGISTRY_KEY`), so
// there is no second key list left to drift FROM. These tests pin the
// constant's own shape instead: every value resolves to a real registry key
// (no `sharedHandlers.get(...)!` landmine), and `create_customer` — the one
// documented exception — is deliberately absent.
describe('I3 — CHAT_INTENT_TO_REGISTRY_KEY is the single source for both dispatch maps', () => {
  it('create_customer is NOT a member — it is dispatched from its own dedicated branch on both paths', () => {
    expect(Object.prototype.hasOwnProperty.call(CHAT_INTENT_TO_REGISTRY_KEY, 'create_customer')).toBe(false);
  });

  it('every value resolves to a real key in a fully-built shared registry (no undefined! landmine)', () => {
    const registry = buildTaskHandlers({ gateway: strictGateway([]) });
    for (const [intent, proposalType] of Object.entries(CHAT_INTENT_TO_REGISTRY_KEY)) {
      expect(registry.has(proposalType), `${intent} -> ${proposalType}`).toBe(true);
    }
  });

  it('none of CHAT_DISPATCH_EXCLUDED_INTENTS is reachable via CHAT_CONTEXT_CUSTOMER_ID_INTENTS either (the two lists are disjoint)', () => {
    for (const intent of CHAT_DISPATCH_EXCLUDED_INTENTS) {
      expect(CHAT_CONTEXT_CUSTOMER_ID_INTENTS.has(intent)).toBe(false);
    }
  });

  it('create_customer dispatches on the CHAIN path too (the special-case mirrors the single-intent branch)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      strictGateway([
        classifierReply('unknown', {}),
        classifierReply('create_customer', { displayName: 'Maria Alvarez', phone: '480-555-0102' }),
        classifierReply('log_time_entry', { jobReference: 'the Miller job', timeEntryType: 'job', durationMinutes: 60 }),
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'New customer Maria Alvarez, 480-555-0102 then log an hour on the Miller job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(2);
    expect(persisted.some((p) => p.proposalType === 'create_customer')).toBe(true);
    expect(persisted.some((p) => p.proposalType === 'log_time_entry')).toBe(true);
  });
});

// ─────────────── existingEntities id threading (jobId/invoiceId/etc.) ───────
// These ids were already shared via resolveVoiceEntityReferences + the SAME
// membership sets (entity-resolution.ts) the memo worker uses — confirmed
// here rather than assumed, since a wrong assumption here is exactly the
// class of bug Step 4 warns about.

describe('Task 15 — existingEntities id threading parity (jobId / invoiceId / technicianId / appointmentId)', () => {
  const RESOLVED_JOB_ID = '11111111-1111-4111-8111-111111111111';
  const RESOLVED_INVOICE_ID = '22222222-2222-4222-8222-222222222222';
  const RESOLVED_APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';
  const RESOLVED_TECHNICIAN_ID = '44444444-4444-4444-8444-444444444444';

  function jobResolver(): EntityResolver {
    return resolverFor(async ({ kind }) =>
      kind === 'job'
        ? { kind: 'resolved', candidate: { id: RESOLVED_JOB_ID, kind: 'job', label: 'Patel job', score: 0.95 } }
        : { kind: 'skipped' },
    );
  }

  function invoiceResolver(): EntityResolver {
    return resolverFor(async ({ kind }) =>
      kind === 'invoice'
        ? { kind: 'resolved', candidate: { id: RESOLVED_INVOICE_ID, kind: 'invoice', label: 'INV-0042', score: 0.95 } }
        : { kind: 'skipped' },
    );
  }

  function apptAndTechResolver(): EntityResolver {
    return resolverFor(async ({ kind }) => {
      if (kind === 'appointment') {
        return { kind: 'resolved', candidate: { id: RESOLVED_APPOINTMENT_ID, kind: 'appointment', label: '2pm Garcia', score: 0.95 } };
      }
      if (kind === 'technician') {
        return { kind: 'resolved', candidate: { id: RESOLVED_TECHNICIAN_ID, kind: 'technician', label: 'Carlos', score: 0.95 } };
      }
      return { kind: 'skipped' };
    });
  }

  it('add_crew_member: resolved appointmentId + technicianId both land on the payload, gate lifted', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('add_crew_member', {
          appointmentReference: 'the Garcia appointment',
          targetTechnicianName: 'Carlos',
        }),
      ]),
      { proposalRepo, entityResolver: apptAndTechResolver() },
    );

    const res = await chat(app, 'Add Carlos to the Garcia appointment');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('add_crew_member');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.appointmentId).toBe(RESOLVED_APPOINTMENT_ID);
    expect(payload.technicianId).toBe(RESOLVED_TECHNICIAN_ID);
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('remove_crew_member: resolved appointmentId + technicianId both land on the payload, gate lifted', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('remove_crew_member', {
          appointmentReference: "Tuesday's Davis job",
          targetTechnicianName: 'Mike',
        }),
      ]),
      { proposalRepo, entityResolver: apptAndTechResolver() },
    );

    const res = await chat(app, "Take Mike off Tuesday's Davis job");

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('remove_crew_member');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.appointmentId).toBe(RESOLVED_APPOINTMENT_ID);
    expect(payload.technicianId).toBe(RESOLVED_TECHNICIAN_ID);
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('record_refund: resolved invoiceId lands on the payload, amountCents/method carried correctly', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('record_refund', {
          jobReference: 'the Smiths invoice',
          amount: 10000,
          refundMethod: 'check',
          refundCheckNumber: '2044',
        }),
      ]),
      { proposalRepo, entityResolver: invoiceResolver() },
    );

    const res = await chat(app, 'Record a 100 dollar check refund to the Smiths, check 2044');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('record_refund');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.invoiceId).toBe(RESOLVED_INVOICE_ID);
    expect(payload.amountCents).toBe(10000);
    expect(payload.method).toBe('check');
    expect(payload.checkNumber).toBe('2044');
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('apply_credit: resolved invoiceId lands on the payload, amountCents carried correctly', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('apply_credit', {
          jobReference: 'the Henderson invoice',
          amount: 5000,
          creditReason: 'late arrival',
        }),
      ]),
      { proposalRepo, entityResolver: invoiceResolver() },
    );

    const res = await chat(app, 'Knock 50 dollars off the Henderson invoice — we were late');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('apply_credit');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.invoiceId).toBe(RESOLVED_INVOICE_ID);
    expect(payload.amountCents).toBe(5000);
    expect(payload.reason).toBe('late arrival');
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('create_change_order: resolved jobId (REQUIRED) lands on the payload, line priced from the spoken amount', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_change_order', {
          jobReference: 'the Patel job',
          changeOrderDescription: 'replace the flue liner too',
          amount: 180000,
        }),
      ]),
      { proposalRepo, entityResolver: jobResolver() },
    );

    const res = await chat(app, 'Add a change order on the Patel job: replace the flue liner too, 1800');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('create_change_order');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.jobId).toBe(RESOLVED_JOB_ID);
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPriceCents).toBe(180000);
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });

  it('add_material: resolved jobId (optional link) lands on the payload when present', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('add_material', {
          materialDescription: 'flue liner kit',
          jobReference: 'the Patel job',
        }),
      ]),
      { proposalRepo, entityResolver: jobResolver() },
    );

    const res = await chat(app, 'We need a flue liner kit for the Patel job');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('add_material');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.jobId).toBe(RESOLVED_JOB_ID);
    expect(payload.description).toBe('flue liner kit');
    expect(payload.quantity).toBe(1);
  });
});

// ───────────────────── update_catalog_item (catalogRepo dep) ────────────────

describe('Task 15 — update_catalog_item resolves against the wired catalogRepo (not the shared entity resolver)', () => {
  it('resolves the spoken item name to a real catalog row and drafts the new price', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const item = createCatalogItem({
      tenantId: TEST_TENANT,
      name: 'Diagnostic fee',
      unitPriceCents: 7500,
    });
    await catalogRepo.create(item);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('update_catalog_item', {
          catalogItemReference: 'the diagnostic fee',
          unitPriceCents: 8900,
        }),
      ]),
      { proposalRepo, catalogRepo },
    );

    const res = await chat(app, 'Raise the diagnostic fee to 89 dollars');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('update_catalog_item');
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.catalogItemId).toBe(item.id);
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(res.body.message.proposal.missingFields).toBeUndefined();
  });
});

// ───────────────────────── I2 — the chain path is untested ──────────────────
//
// Quality review: every test above drives the SINGLE-intent path
// (`generateAssistantReply`'s `proposalHandlers` lookup). The chain path
// (a "…, then …" turn) is a SEPARATE code path with its own `intent:` /
// `customerId:` threading, its own registry-key lookup, AND behavior the
// single path doesn't have: `downgradeIfCallerLacksDirectPermission`, the
// `chainCards.length >= 1 → ready_for_review` demotion for dependent steps,
// and `carried` entity propagation. One turn exercises BOTH new context
// fields (log_mileage needs `intent`; send_customer_message needs
// `customerId`) on the path that had zero coverage.
describe('I2 — the chain path threads intent + customerId exactly like the single-intent path', () => {
  it('"log 32 miles to the Patel job then text the Hendersons the part arrived" drafts BOTH steps correctly', async () => {
    const RESOLVED_CUSTOMER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const proposalRepo = new InMemoryProposalRepository();
    const entityResolver = resolverFor(async ({ kind }) =>
      kind === 'customer'
        ? {
            kind: 'resolved',
            candidate: { id: RESOLVED_CUSTOMER_ID, kind: 'customer', label: 'Henderson', score: 0.95 },
          }
        : { kind: 'skipped' },
    );
    const app = buildApp(
      strictGateway([
        // Top-level classify of the FULL turn (chain detection happens
        // AFTER this call regardless of what it returns, as long as it
        // isn't a lookup or a voice-mode approval intent).
        classifierReply('unknown', {}),
        // Segment 1 classify.
        classifierReply('log_mileage', { mileageMiles: 32, jobReference: 'the Patel job' }),
        // Segment 2 classify.
        classifierReply('send_customer_message', {
          customerName: 'Henderson',
          customerMessageBody: 'The part arrived',
        }),
        // Segment 2's OWN rewrite call (SendCustomerMessageTaskHandler).
        'The part arrived at our shop.',
      ]),
      { proposalRepo, entityResolver },
    );

    const res = await chat(app, 'Log 32 miles to the Patel job then text the Hendersons the part arrived');

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(2);

    const mileage = persisted.find((p) => p.proposalType === 'log_expense');
    const message = persisted.find((p) => p.proposalType === 'send_customer_message');
    expect(mileage).toBeTruthy();
    expect(message).toBeTruthy();

    // Chain-side `intent:` threading (Task 11 parity) — same regression
    // class as the single-intent path: without it, this drafts a plain,
    // wrong-category log_expense instead.
    const mileagePayload = mileage!.payload as Record<string, unknown>;
    expect(mileagePayload.category).toBe('vehicle');
    expect(mileagePayload.amountCents).toBe(Math.round(32 * 70));

    // Chain-side `customerId:` threading (C1/C2 allowlist) — send_customer_
    // message is a CHAT_CONTEXT_CUSTOMER_ID_INTENTS member, so the resolved
    // id must reach context.customerId on THIS path too, not just the
    // single-intent path.
    const messagePayload = message!.payload as Record<string, unknown>;
    expect(messagePayload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(messagePayload.body).toBe('The part arrived at our shop.');
    expect(messagePayload.channel).toBe('sms');

    // chainId/chainStep stamped on both, proving both went through the
    // actual chain machinery rather than two independent single-intent
    // drafts.
    expect((mileage!.sourceContext as Record<string, unknown>)?.chainId).toBeTruthy();
    expect((message!.sourceContext as Record<string, unknown>)?.chainId).toBe(
      (mileage!.sourceContext as Record<string, unknown>)?.chainId,
    );
    expect((mileage!.sourceContext as Record<string, unknown>)?.chainStep).toBe(1);
    expect((message!.sourceContext as Record<string, unknown>)?.chainStep).toBe(2);
  });
});
