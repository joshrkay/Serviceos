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
const CUSTOMER = 'qa-matrix-A-customer';
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
    /** Further entity gates the same turn must also lift (crew/reassign). */
    alsoFilled?: Record<string, string>;
    /**
     * NON-entity gates this row still carries after resolution — a field no
     * resolver can answer, so approval correctly keeps refusing. Recorded
     * per row rather than glossed: #909 is scoped to the entity gate, and a
     * row that needs something else too should say so out loud instead of
     * looking healed.
     */
    residualGates?: string[];
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
    {
      row: 'A04',
      intent: 'update_invoice',
      phrase: 'Add a 75 dollar filter line to invoice INV-0001',
      entities: {
        jobReference: 'INV-0001',
        lineItemDescriptions: ['filter'],
        amount: 7500,
      },
      gate: 'invoiceId',
      filledWith: RESOLVED.invoice,
    },
    {
      row: 'A13',
      intent: 'reassign_appointment',
      phrase: "Reassign qa-matrix-A-customer's appointment to Tom Baker",
      entities: {
        customerName: CUSTOMER,
        appointmentReference: `${CUSTOMER}'s appointment`,
        targetTechnicianName: 'Tom Baker',
      },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
      alsoFilled: { toTechnicianId: RESOLVED.technician },
    },
    {
      row: 'A15',
      intent: 'remove_crew_member',
      phrase: "Take Alex Rivera off qa-matrix-A-customer's appointment",
      entities: { customerName: CUSTOMER, targetTechnicianName: 'Alex Rivera' },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
      alsoFilled: { technicianId: RESOLVED.technician },
    },
    {
      row: 'A29',
      intent: 'add_service_location',
      phrase: 'Add a service location for Priya Shah: 9 Elm Court, Mesa, AZ 85201',
      entities: {
        customerName: 'Priya Shah',
        serviceAddress: '9 Elm Court, Mesa, AZ 85201',
      },
      gate: 'customerId',
      filledWith: RESOLVED.customer,
      // AddServiceLocationTaskHandler pushes these four UNCONDITIONALLY
      // ("the executor needs structured fields — always require
      // resolution"). Parsing a spoken address into street/city/state/zip is
      // not entity resolution and no resolver kind answers it, so A29's
      // ENTITY gate is what this issue lifts; the row needs an address
      // parser as well before it can approve unattended. Flagged, not hidden.
      residualGates: ['street1', 'city', 'state', 'postalCode'],
    },
    {
      row: 'A31',
      intent: 'notify_delay',
      phrase: "Tell qa-matrix-A-customer we're running 30 minutes late",
      entities: {
        customerName: CUSTOMER,
        appointmentReference: `${CUSTOMER}'s appointment`,
        delayMinutes: 30,
      },
      gate: 'appointmentId',
      filledWith: RESOLVED.appointment,
    },
    {
      row: 'A41',
      intent: 'create_service_agreement',
      phrase: 'Sign Priya Shah up for the annual maintenance plan, 290 dollars a year',
      entities: {
        customerName: 'Priya Shah',
        serviceAgreementName: 'Annual Maintenance Plan',
        serviceAgreementCadence: 'annual',
        amount: 29000,
      },
      gate: 'customerId',
      filledWith: RESOLVED.customer,
    },
    {
      row: 'A45',
      intent: 'create_invoice_schedule',
      phrase:
        'Set up milestone billing on the QA Sweep Furnace Inspection job: 50 percent deposit, rest on completion',
      entities: {
        jobReference: 'QA Sweep Furnace Inspection',
        scheduleDescription: '50 percent deposit, rest on completion',
      },
      gate: 'jobId',
      filledWith: RESOLVED.job,
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

      for (const [key, value] of Object.entries(row.alsoFilled ?? {})) {
        expect((persisted.payload as Record<string, unknown>)[key], key).toBe(value);
        expect(missingFieldsFor(persisted)).not.toContain(key);
      }

      // THE assertion: the exact call that returned 400 in the sweep.
      if (row.residualGates) {
        // Still refused — but for a reason that has nothing to do with
        // entity resolution, and never for the entity gate.
        await expect(
          approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
        ).rejects.toThrow(new RegExp(row.residualGates.join('|')));
        expect(missingFieldsFor(persisted).sort()).toEqual([...row.residualGates].sort());
      } else {
        await expect(
          approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
        ).resolves.toBeTruthy();
      }
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

  it('re-asks an ANSWER-SHAPED but unmatched reply, then stops so the operator is never trapped', async () => {
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

    // "the third one" when only two were offered: unmistakably an attempt to
    // answer, and unmistakably not a match.
    const first = await chat(app, 'the third one');
    expect(first.body.taskType).toBe('assistant.entity_resolution');
    expect(first.body.message.content).toContain('Which lead did you mean');

    const second = await chat(app, 'the third one');
    expect(second.body.taskType).toBe('assistant.entity_resolution');

    // Bound reached: the pending question is dropped and this turn is
    // classified as an ordinary request instead.
    const third = await chat(app, 'the third one');
    expect(third.body.taskType).not.toBe('assistant.entity_resolution');

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(
      (persisted.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
    ).toBeUndefined();
    // The gate — and its candidate picker on the card — survive.
    expect(missingFieldsFor(persisted)).toContain('leadId');
  });

  // ───────────────────────────────────────────────────────────────────────
  // RECALL HIJACK regressions. A pending question used to hand EVERY later
  // turn to the follow-up matcher, whose seams are deliberately generous for
  // a spoken turn. On chat that let an ordinary request be consumed as an
  // answer: the question resolved and the request was silently discarded —
  // never drafted, never refused, never logged as anything but a resolution.
  // ───────────────────────────────────────────────────────────────────────
  describe('a pending question never consumes an unrelated request', () => {
    const PLUMBING = '11111111-cccc-4ccc-8ccc-cccccccccccc';
    const RESIDENCE = '22222222-dddd-4ddd-8ddd-dddddddddddd';

    /** Two candidates whose NAMES appear verbatim inside ordinary requests. */
    const namedLeadResolver = () =>
      resolverFor(({ kind }) =>
        kind === 'lead'
          ? ({
              kind: 'ambiguous',
              candidates: [
                {
                  id: PLUMBING,
                  kind: 'lead',
                  label: 'Johnson Plumbing',
                  hint: 'new · 50 Beech Street',
                  score: 0.9,
                },
                {
                  id: RESIDENCE,
                  kind: 'lead',
                  label: 'Johnson Residence',
                  hint: 'qualified · 12 Oak Lane',
                  score: 0.9,
                },
              ],
            } as EntityResolverResult)
          : ({ kind: 'skipped' } as EntityResolverResult),
      );

    async function withPendingQuestion(followUpClassification: string) {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          followUpClassification,
        ]),
        proposalRepo,
        entityResolver: namedLeadResolver(),
      });
      const res = await chat(app, 'Convert the Johnson lead to a customer');
      expect(res.body.message.content).toContain('Which lead did you mean');
      return { app, proposalRepo };
    }

    it('a request CONTAINING a candidate name is classified, not swallowed', async () => {
      // The proven path: `normalized.includes(label)` matched "Johnson
      // Plumbing" inside the sentence, resolved the lead, and threw the
      // invoice request away.
      const { app, proposalRepo } = await withPendingQuestion(
        classifierReply('create_invoice', {
          customerName: 'Johnson Plumbing',
          amount: 40000,
          lineItemDescriptions: ['service call'],
        }),
      );

      const res = await chat(app, 'Send an invoice to Johnson Plumbing for $400');

      expect(res.body.taskType).not.toBe('assistant.entity_resolution');
      // The lead question was NOT answered…
      const convertLead = (await proposalRepo.findByTenant(TEST_TENANT)).find(
        (p) => p.proposalType === 'convert_lead',
      )!;
      expect((convertLead.payload as Record<string, unknown>).leadId).toBeUndefined();
      // …and it is still standing, un-consumed and un-penalised.
      const stillPending = (convertLead.sourceContext as Record<string, unknown>)
        .pendingEntityAmbiguity as { attemptCount: number } | undefined;
      expect(stillPending).toBeTruthy();
      expect(stillPending?.attemptCount).toBe(0);
      // And the turn genuinely went through the classifier rather than
      // being answered by the resolution leg. (Whether the invoice itself
      // drafts depends on repo wiring this suite does not provide; what
      // this test pins is that the request was not swallowed.)
      expect(res.body.model).not.toBe('entity-resolver');
    });

    it('a request carrying a stray number does not match an address hint', async () => {
      // The proven path: extractStreetNumber's \b(\d{1,5})\b offered "50",
      // which matched the candidate hinted "50 Beech Street".
      const { app, proposalRepo } = await withPendingQuestion(
        classifierReply('apply_late_fee', { jobReference: 'invoice 1042', amount: 5000 }),
      );

      const res = await chat(app, 'apply a $50 late fee on invoice 1042');

      expect(res.body.taskType).not.toBe('assistant.entity_resolution');
      const convertLead = (await proposalRepo.findByTenant(TEST_TENANT)).find(
        (p) => p.proposalType === 'convert_lead',
      )!;
      expect((convertLead.payload as Record<string, unknown>).leadId).toBeUndefined();
    });

    it('a bare "ok" is not read as a substring of a candidate name', async () => {
      // The reverse direction: `label.includes(normalized)` made "ok" a
      // match for "Brooks".
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([
          classifierReply('convert_lead', { leadReference: 'the Brooks lead' }),
          classifierReply('unknown', {}),
        ]),
        proposalRepo,
        entityResolver: resolverFor(({ kind }) =>
          kind === 'lead'
            ? ({
                kind: 'ambiguous',
                candidates: [
                  { id: 'brooks-1', kind: 'lead', label: 'Brooks', score: 0.9 },
                  { id: 'brooks-2', kind: 'lead', label: 'Brooksfield', score: 0.9 },
                ],
              } as EntityResolverResult)
            : ({ kind: 'skipped' } as EntityResolverResult),
        ),
      });

      await chat(app, 'Convert the Brooks lead');
      const res = await chat(app, 'ok');

      expect(res.body.taskType).not.toBe('assistant.entity_resolution');
      const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
      expect((persisted.payload as Record<string, unknown>).leadId).toBeUndefined();
    });

    it('an excluded-intent utterance still gets its deterministic refusal', async () => {
      // A standing question must not shadow the route's own refusals: the
      // four CHAT_DISPATCH_EXCLUDED_INTENTS answer deterministically, and
      // that has to keep working mid-clarification.
      const { app, proposalRepo } = await withPendingQuestion(
        classifierReply('respond_to_review', { reviewReference: 'the 1-star from yesterday' }),
      );

      const res = await chat(app, 'Reply to the 1-star review from yesterday');

      expect(res.status).toBe(200);
      expect(res.body.taskType).not.toBe('assistant.entity_resolution');
      // No respond_to_review proposal is minted — it has no handler at all.
      expect(
        (await proposalRepo.findByTenant(TEST_TENANT)).some(
          (p) => p.proposalType === 'respond_to_review',
        ),
      ).toBe(false);
      // And the question survives for a real answer.
      const convertLead = (await proposalRepo.findByTenant(TEST_TENANT)).find(
        (p) => p.proposalType === 'convert_lead',
      )!;
      expect(
        (convertLead.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
      ).toBeTruthy();
    });

    it('a genuine short answer still resolves after all that tightening', async () => {
      const { app, proposalRepo } = await withPendingQuestion(classifierReply('unknown', {}));

      const res = await chat(app, 'Residence');
      expect(res.body.taskType).toBe('assistant.entity_resolution');

      const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
      expect((persisted.payload as Record<string, unknown>).leadId).toBe(RESIDENCE);
    });

    it('an answer-shaped turn the matcher cannot place is re-asked, never guessed', async () => {
      // The gate is deliberately allowed to be a little broader than the
      // matcher. "the residence one" reads as an answer, but the shared
      // matcher (which voice depends on, so it is not loosened here) cannot
      // place it. Gate-accept + matcher-reject costs one re-ask; the reverse
      // asymmetry would be the hijack, so this is the safe direction to err.
      const { app, proposalRepo } = await withPendingQuestion(classifierReply('unknown', {}));

      const res = await chat(app, 'the residence one');
      expect(res.body.message.content).toContain('Which lead did you mean');

      const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
      expect((persisted.payload as Record<string, unknown>).leadId).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // CHAIN path ("…, then …"). Resolution runs, but the chain deliberately
  // does NOT ask — see the call site's comment: in a reply made of N cards,
  // "the second one" most naturally means the second CARD, which is exactly
  // the phrasing the answer matcher reads as an ordinal about candidates.
  // ───────────────────────────────────────────────────────────────────────
  describe('chain path — resolves, but never arms a question the reply did not ask', () => {
    const JOHNSON = '33333333-eeee-4eee-8eee-eeeeeeeeeeee';
    const NGUYEN = '44444444-ffff-4fff-8fff-ffffffffffff';

    it('fills unambiguous references in every segment of a chain', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([
          // top-level classification, then one per segment
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('mark_lead_lost', {
            leadReference: 'the Nguyen lead',
            lostReason: 'went quiet',
          }),
        ]),
        proposalRepo,
        entityResolver: resolverFor(({ reference }) =>
          reference.toLowerCase().includes('nguyen')
            ? resolvesTo(NGUYEN, 'lead')
            : resolvesTo(JOHNSON, 'lead'),
        ),
      });

      const res = await chat(
        app,
        'Convert the Johnson lead to a customer, then mark the Nguyen lead lost',
      );
      expect(res.status).toBe(200);

      const persisted = await proposalRepo.findByTenant(TEST_TENANT);
      expect(persisted).toHaveLength(2);
      // Both segments share a chain and both got their id resolved.
      for (const proposal of persisted) {
        expect((proposal.sourceContext as Record<string, unknown>).chainId).toBeTruthy();
        expect(missingFieldsFor(proposal)).not.toContain('leadId');
        await expect(
          approveProposal(proposalRepo, TEST_TENANT, proposal.id, TEST_USER, 'owner'),
        ).resolves.toBeTruthy();
      }
      expect(
        persisted.map((p) => (p.payload as Record<string, unknown>).leadId).sort(),
      ).toEqual([JOHNSON, NGUYEN].sort());
    });

    it('an ambiguous reference in a chain arms NO pending question', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('mark_lead_lost', { leadReference: 'the Nguyen lead' }),
        ]),
        proposalRepo,
        entityResolver: resolverFor(({ reference }) =>
          reference.toLowerCase().includes('johnson')
            ? ({
                kind: 'ambiguous',
                candidates: [
                  { id: 'j1', kind: 'lead', label: 'Dana Johnson', score: 0.9 },
                  { id: 'j2', kind: 'lead', label: 'Marcus Johnson', score: 0.9 },
                ],
              } as EntityResolverResult)
            : resolvesTo(NGUYEN, 'lead'),
        ),
      });

      const res = await chat(
        app,
        'Convert the Johnson lead to a customer, then mark the Nguyen lead lost',
      );

      // The reply does not ask a question…
      expect(res.body.message.content).not.toContain('Which lead did you mean');
      // …so no proposal is left waiting for an answer nobody was invited to
      // give. The ambiguous one keeps its gate and its candidate picker.
      const persisted = await proposalRepo.findByTenant(TEST_TENANT);
      for (const proposal of persisted) {
        expect(
          (proposal.sourceContext as Record<string, unknown>).pendingEntityAmbiguity,
          proposal.proposalType,
        ).toBeUndefined();
      }
      const ambiguous = persisted.find((p) => p.proposalType === 'convert_lead')!;
      expect(missingFieldsFor(ambiguous)).toContain('leadId');
      // The unambiguous sibling still resolved.
      const resolved = persisted.find((p) => p.proposalType === 'mark_lead_lost')!;
      expect((resolved.payload as Record<string, unknown>).leadId).toBe(NGUYEN);
    });

    it('a later ordinal is not consumed by a chain segment, because nothing is pending', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const app = buildApp({
        gateway: scriptedGateway([
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
          classifierReply('mark_lead_lost', { leadReference: 'the Nguyen lead' }),
          classifierReply('unknown', {}),
        ]),
        proposalRepo,
        entityResolver: resolverFor(
          () =>
            ({
              kind: 'ambiguous',
              candidates: [
                { id: 'j1', kind: 'lead', label: 'Dana Johnson', score: 0.9 },
                { id: 'j2', kind: 'lead', label: 'Marcus Johnson', score: 0.9 },
              ],
            }) as EntityResolverResult,
        ),
      });

      await chat(app, 'Convert the Johnson lead to a customer, then mark the Nguyen lead lost');
      // In a two-card reply this means "the second card", and it must not be
      // read as picking a candidate for either of them.
      const res = await chat(app, 'the second one');

      expect(res.body.taskType).not.toBe('assistant.entity_resolution');
      for (const proposal of await proposalRepo.findByTenant(TEST_TENANT)) {
        expect((proposal.payload as Record<string, unknown>).leadId).toBeUndefined();
      }
    });
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
