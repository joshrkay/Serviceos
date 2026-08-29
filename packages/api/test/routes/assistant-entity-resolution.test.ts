/**
 * #909 — the chat surface's entity-resolution loop, handler level.
 *
 * The failure this closes, verified live by the 2026-08-29 capability sweep:
 * chat drafted a proposal carrying only a free-text reference, and
 * `POST /api/proposals/:id/approve` answered 400 {missingFields:[...]}
 * forever. Sixteen capabilities, one architectural gap.
 *
 * So these tests assert the EXECUTED EFFECT, not card shape: after the chat
 * turn, `approveProposal` SUCCEEDS. That is the repo's P-44 convention and
 * it is the only assertion that would actually have caught the bug.
 *
 * The resolver is stubbed here (this is the loop's wiring); the SQL behind it
 * is pinned against real Postgres in
 * test/integration/chat-entity-resolution.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

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

function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intentType,
    confidence: 0.95,
    reasoning: 'test',
    extractedEntities: entities,
  });
}

type ResolveInput = { tenantId: string; reference: string; kind: string; jobId?: string };

function resolverFor(
  impl: (input: ResolveInput) => EntityResolverResult,
): EntityResolver {
  return { resolve: vi.fn(async (input: ResolveInput) => impl(input)) } as unknown as EntityResolver;
}

const resolvesTo = (id: string, kind: string, label = 'Match'): EntityResolverResult =>
  ({ kind: 'resolved', candidate: { id, kind, label, score: 0.95 } }) as EntityResolverResult;

function buildApp(opts: {
  gateway: LLMGateway;
  proposalRepo: InMemoryProposalRepository;
  entityResolver?: EntityResolver;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-909',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: opts.gateway,
      proposalRepo: opts.proposalRepo,
      // A real tenant has a zone. reschedule_appointment gates on
      // newScheduledStart/End as well as appointmentId, and those are parsed
      // from the spoken phrase IN THE TENANT'S ZONE (never a silent UTC
      // parse) — so without this the row would stall on the TIME gate and
      // this suite would be proving the wrong thing about the ID gate.
      tenantTimezoneResolver: async () => 'America/Phoenix',
      ...(opts.entityResolver ? { entityResolver: opts.entityResolver } : {}),
    }),
  );
  return app;
}

async function chat(
  app: ReturnType<typeof buildApp>,
  content: string,
  conversationId = CONVERSATION,
) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], conversationId });
}

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// The acceptance criterion: the sweep's 16 rows all shared ONE failure mode
// (approve → 400 missingFields). One table, one assertion: after the chat
// turn the gate is gone and approve SUCCEEDS.
// ─────────────────────────────────────────────────────────────────────────
describe('#909 — an unambiguous reference lifts the gate that blocked approval', () => {
  const RESOLVED = {
    appointment: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    technician: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    invoice: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    customer: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    lead: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    job: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  } as const;

  const everythingResolves = () =>
    resolverFor(({ kind }) => {
      const id = RESOLVED[kind as keyof typeof RESOLVED];
      return id ? resolvesTo(id, kind) : ({ kind: 'skipped' } as EntityResolverResult);
    });

  // Each row is one of the sweep's PARTIAL capabilities, with the utterance
  // and the classifier extraction the live run produced.
  const ROWS: Array<{
    row: string;
    intent: string;
    phrase: string;
    entities: Record<string, unknown>;
    gate: string;
    filledWith: string;
  }> = [
    {
      row: 'A11',
      intent: 'reschedule_appointment',
      phrase: "Move qa-matrix-A-customer's tune-up appointment to Friday at 10am",
      entities: {
        customerName: 'qa-matrix-A-customer',
        appointmentReference: "qa-matrix-A-customer's tune-up appointment",
        newDateTimeDescription: 'Friday at 10am',
      },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
    },
    {
      row: 'A12',
      intent: 'cancel_appointment',
      phrase: "Cancel qa-matrix-A-customer's appointment, customer request",
      entities: {
        customerName: 'qa-matrix-A-customer',
        appointmentReference: "qa-matrix-A-customer's appointment",
        cancellationType: 'customer_request',
      },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
    },
    {
      row: 'A27',
      intent: 'confirm_appointment',
      phrase: "Confirm qa-matrix-A-customer's appointment",
      entities: {
        customerName: 'qa-matrix-A-customer',
        appointmentReference: "qa-matrix-A-customer's appointment",
      },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
    },
    {
      row: 'A14',
      // The crew intents are the case where the classifier emitted NO
      // appointmentReference at all — the customer name is the only signal,
      // and the loop's entity fallback is what makes it resolvable.
      intent: 'add_crew_member',
      phrase: "Add Alex Rivera to qa-matrix-A-customer's appointment as a second technician",
      entities: { customerName: 'qa-matrix-A-customer', targetTechnicianName: 'Alex Rivera' },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
    },
    {
      row: 'A26',
      intent: 'convert_lead',
      phrase: 'Convert the Johnson lead to a customer',
      entities: { leadReference: 'the Johnson lead' },
      gate: 'leadId',
      filledWith: RESOLVED.lead,
    },
    {
      row: 'A28',
      intent: 'mark_lead_lost',
      phrase: 'Mark the Nguyen lead lost, went with a competitor',
      entities: { leadReference: 'the Nguyen lead', lostReason: 'went with a competitor' },
      gate: 'leadId',
      filledWith: RESOLVED.lead,
    },
    {
      row: 'A24',
      intent: 'update_customer',
      phrase: "Update Priya Shah's phone to 480-555-0188",
      entities: { customerName: 'Priya Shah', updatedPhone: '480-555-0188' },
      gate: 'customerId',
      filledWith: RESOLVED.customer,
    },
    {
      row: 'A20',
      intent: 'send_payment_reminder',
      phrase: 'Send qa-matrix-A-customer a payment reminder on invoice INV-0001',
      entities: { customerName: 'qa-matrix-A-customer', jobReference: 'INV-0001' },
      gate: 'invoiceId',
      filledWith: RESOLVED.invoice,
    },
    {
      row: 'A21',
      intent: 'apply_late_fee',
      phrase: 'Apply a 25 dollar late fee to invoice INV-0001',
      entities: { jobReference: 'INV-0001', amount: 2500 },
      gate: 'invoiceId',
      filledWith: RESOLVED.invoice,
    },
  ];

  for (const row of ROWS) {
    it(`${row.row} ${row.intent}: gate '${row.gate}' lifts and approve succeeds`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([classifierReply(row.intent, row.entities)]),
        proposalRepo,
        entityResolver: everythingResolves(),
      });

      const res = await chat(app, row.phrase);
      expect(res.status).toBe(200);

      const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
      expect(persisted, 'a proposal should have been drafted').toBeTruthy();

      // The gate that blocked the live sweep is gone…
      expect(missingFieldsFor(persisted)).not.toContain(row.gate);
      // …because a real id took its place.
      expect((persisted.payload as Record<string, unknown>)[row.gate]).toBe(row.filledWith);
      // …and it is marked as coming from a DB lookup, so the scrub keeps it.
      expect(
        (persisted.sourceContext as Record<string, unknown>).verifiedIds,
      ).toMatchObject({ [row.gate]: row.filledWith });

      // THE assertion: the exact call that returned 400 in the sweep.
      await expect(
        approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
      ).resolves.toBeTruthy();
    });
  }

  it('leaves a gate the loop cannot resolve blocking approval, exactly as before', async () => {
    // reschedule also gates on newScheduledStart/newScheduledEnd, which are a
    // parsed time and not an entity reference at all. Resolution must not
    // touch them — lifting a gate nothing resolved is how a doomed approval
    // gets through.
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('reschedule_appointment', {
          appointmentReference: "tomorrow's 3pm",
          // no newDateTimeDescription — the time gate stays
        }),
      ]),
      proposalRepo,
      entityResolver: resolverFor(() => resolvesTo(RESOLVED.appointment, 'appointment')),
    });

    await chat(app, 'Move the 3pm');
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);

    expect((persisted.payload as Record<string, unknown>).appointmentId).toBe(
      RESOLVED.appointment,
    );
    expect(missingFieldsFor(persisted)).not.toContain('appointmentId');
    expect(missingFieldsFor(persisted)).toContain('newScheduledStart');
    await expect(
      approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
    ).rejects.toThrow(/newScheduledStart/);
  });

  it('D-004: resolving a reference never approves or executes the proposal', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
      ]),
      proposalRepo,
      entityResolver: resolverFor(() => resolvesTo(RESOLVED.lead, 'lead')),
    });

    await chat(app, 'Convert the Johnson lead to a customer');
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);

    expect(persisted.status).toBe('ready_for_review');
    expect(persisted.approvedAt).toBeUndefined();
  });

  it('is inert when no resolver is wired — today\'s gated behavior', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
      ]),
      proposalRepo,
    });

    await chat(app, 'Convert the Johnson lead to a customer');
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(missingFieldsFor(persisted)).toContain('leadId');
    expect((persisted.payload as Record<string, unknown>).leadReference).toBe(
      'the Johnson lead',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Ambiguity: ONE question, no guess, and the answer completes the loop.
// ─────────────────────────────────────────────────────────────────────────
describe('#909 — an ambiguous reference asks one question and the next turn answers it', () => {
  const LEAD_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const LEAD_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const ambiguousLeadResolver = () =>
    resolverFor(({ kind }) =>
      kind === 'lead'
        ? ({
            kind: 'ambiguous',
            candidates: [
              { id: LEAD_A, kind: 'lead', label: 'Dana Johnson', hint: 'qualified', score: 0.9 },
              { id: LEAD_B, kind: 'lead', label: 'Marcus Johnson', hint: 'new', score: 0.9 },
            ],
          } as EntityResolverResult)
        : ({ kind: 'skipped' } as EntityResolverResult),
    );

  it('asks ONE question, fills nothing, and keeps the gate up', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    const res = await chat(app, 'Convert the Johnson lead to a customer');

    expect(res.body.message.content).toContain('Which lead did you mean');
    expect(res.body.message.content).toContain('1. Dana Johnson');
    expect(res.body.message.content).toContain('2. Marcus Johnson');

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect((persisted.payload as Record<string, unknown>).leadId).toBeUndefined();
    expect(missingFieldsFor(persisted)).toContain('leadId');
    // The question is remembered on the proposal it blocks.
    expect(
      (persisted.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
    ).toMatchObject({ refKey: 'leadId', entityKind: 'lead' });
    // And approval is still correctly refused.
    await expect(
      approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
    ).rejects.toThrow(/leadId/);
  });

  it('an ordinal answer on the next turn resolves it and unblocks approval', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      // Only ONE classifier script entry: the follow-up turn must not reach
      // the classifier at all (the voice surface's no-reclassify rule).
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    await chat(app, 'Convert the Johnson lead to a customer');
    const res = await chat(app, 'the second one');

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.entity_resolution');
    expect(res.body.message.content).toContain('Marcus Johnson');

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect((persisted.payload as Record<string, unknown>).leadId).toBe(LEAD_B);
    expect(missingFieldsFor(persisted)).not.toContain('leadId');
    expect(
      (persisted.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
    ).toBeUndefined();

    await expect(
      approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
    ).resolves.toBeTruthy();
  });

  it('answering by name works too, and never picks outside the offered candidates', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    await chat(app, 'Convert the Johnson lead to a customer');
    await chat(app, 'Dana');

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect((persisted.payload as Record<string, unknown>).leadId).toBe(LEAD_A);
  });

  it('re-asks an unmatched answer, then stops waiting so the operator is never trapped', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
        // Reached only once the pending question has been abandoned.
        classifierReply('unknown', {}),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    await chat(app, 'Convert the Johnson lead to a customer');

    const first = await chat(app, 'what is the weather');
    expect(first.body.taskType).toBe('assistant.entity_resolution');
    expect(first.body.message.content).toContain('Which lead did you mean');

    const second = await chat(app, 'still not an answer');
    expect(second.body.taskType).toBe('assistant.entity_resolution');

    // Bound reached: the pending question is dropped and this turn is
    // classified as an ordinary request instead.
    const third = await chat(app, 'never mind, what is the weather');
    expect(third.body.taskType).not.toBe('assistant.entity_resolution');

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(
      (persisted.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
    ).toBeUndefined();
    // The gate — and its candidate picker on the card — survive.
    expect(missingFieldsFor(persisted)).toContain('leadId');
  });

  it('ignores a pending question on a proposal that has since been decided', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
        classifierReply('unknown', {}),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    await chat(app, 'Convert the Johnson lead to a customer');
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    await proposalRepo.updateStatus(TEST_TENANT, persisted.id, 'rejected');

    const res = await chat(app, 'the second one');
    expect(res.body.taskType).not.toBe('assistant.entity_resolution');

    const [after] = await proposalRepo.findByTenant(TEST_TENANT);
    expect((after.payload as Record<string, unknown>).leadId).toBeUndefined();
    expect(after.status).toBe('rejected');
  });

  it('does not consult a pending question from a different conversation', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
        classifierReply('unknown', {}),
      ]),
      proposalRepo,
      entityResolver: ambiguousLeadResolver(),
    });

    await chat(app, 'Convert the Johnson lead to a customer', CONVERSATION);
    const res = await chat(app, 'the second one', '44444444-4444-4444-8444-444444444444');

    expect(res.body.taskType).not.toBe('assistant.entity_resolution');
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect((persisted.payload as Record<string, unknown>).leadId).toBeUndefined();
  });
});
