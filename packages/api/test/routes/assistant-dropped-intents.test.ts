/**
 * Task 15 (2026-08-07 tradesperson plan) — the wider B5 completion.
 *
 * `routes/assistant.ts`'s chat dispatch (`chainHandlers` / `proposalHandlers`,
 * both keyed on the classified intent) was missing 18 intents that already
 * had a full, working drafting handler in the shared registry
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
 * `emergency_dispatch`, `update_brand_voice`, `respond_to_review`, and
 * `create_standing_instruction` stay surface-specific BY DESIGN
 * (handler-registry.ts's module doc) and are deliberately NOT wired.
 *
 * These tests pin two things per intent:
 *   1. DISPATCH — a chat turn classified as the intent produces a proposal
 *      card, not a conversational fallback / refusal.
 *   2. CORRECTNESS — the draft's payload is actually right, not just
 *      present. Several of these intents depend on context the memo router
 *      injects that chat did not previously supply:
 *        - `context.intent` (Task 11): `log_mileage` shares `LogExpense-
 *          TaskHandler` with plain `log_expense` and tells them apart ONLY
 *          via `context.intent` — dispatching it without threading that
 *          field would silently draft a plain, wrong-category expense.
 *        - `context.customerId` (top-level, NOT `existingEntities.
 *          customerId`): `send_customer_message`, `create_service_
 *          agreement`, and `add_service_location` read this field
 *          directly, mirroring the memo worker's "verified caller identity
 *          wins, a resolver hit fills it otherwise" precedence. Chat only
 *          ever threaded a resolved customerId into `existingEntities`, so
 *          these three would have drafted permanently gated even with a
 *          working entity resolver wired.
 *        - `existingEntities.{jobId,invoiceId,technicianId,appointmentId}`
 *          — already shared via `resolveVoiceEntityReferences` (the SAME
 *          function + membership sets the memo worker uses), confirmed
 *          working here rather than assumed.
 *
 * NO LIVE LLM CALLS — every gateway is a scripted fake.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
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

type ResolverImpl = (input: { tenantId: string; reference: string; kind: string }) => Promise<EntityResolverResult>;

function resolverFor(impl: ResolverImpl): EntityResolver {
  return { resolve: vi.fn(impl) } as unknown as EntityResolver;
}

interface BuildAppOpts {
  proposalRepo?: InMemoryProposalRepository;
  entityResolver?: EntityResolver;
  catalogRepo?: import('../../src/catalog/catalog-item').CatalogItemRepository;
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
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

  it('send_customer_message: the resolved customerId reaches context.customerId, not just existingEntities', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('send_customer_message', {
          customerName: 'Henderson',
          customerMessageBody: 'The part arrived, we can come Thursday',
        }),
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
