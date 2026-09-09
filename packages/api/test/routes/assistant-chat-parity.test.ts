/**
 * VOICE AND TEXT MUST BOTH WORK.
 *
 * These are the chat-surface defects the in-app 50-case register found when it
 * was extended from the live-voice FSM to `POST /api/assistant/chat` — the
 * route the web assistant page actually posts to, for BOTH typed input and mic
 * transcripts (`inputMode: 'voice'`). Every one of them was invisible to a
 * 50/50 voice run.
 *
 *   1. APPROVE-TO-FAIL CARDS. Voice validates the payload it builds and gates
 *      the draft when it fails (`proposals/voice-payload.ts` §5). Chat had no
 *      equivalent, so it persisted whatever the drafting handler returned:
 *      every chat-drafted `create_appointment` (no customerId — a model cannot
 *      invent a uuid), `update_estimate` / `update_invoice` (empty
 *      `editActions`) and `update_job` ("at least one field to change") went
 *      into the inbox with Approve enabled and an execution that throws.
 *   2. RESOLVED IDS THAT NEVER REACHED THE PAYLOAD. The route resolves the
 *      operator's references before drafting and then relied on the drafting
 *      model to echo the uuid back.
 *   3. TWO CARDS FOR ONE JOB. A double-submit, or a correction ("no, make it
 *      Thursday"), left two approvable cards for the same visit.
 *   4. A BARE "YES" ANSWERED BY A MODEL. `confirm` is a non-action intent, so
 *      it fell through to the generic LLM — the fabrication path the honesty
 *      guard exists to close, one keystroke away.
 *   5. AN UNAPPROVABLE CARD FOR A RECORD THAT DOES NOT EXIST. "Cancel the Patel
 *      appointment", with no Patel, drafted a card gated on an appointmentId
 *      the resolver had just confirmed absent.
 *
 * NO LIVE LLM CALLS — the gateway is scripted. Each test asserts the PERSISTED
 * row, not just the reply envelope: the card an operator taps is the row.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { DateTime } from 'luxon';

import {
  applyContractGate,
  applyVerifiedIdsToPayload,
  contractGateMissingFields,
  createAssistantRouter,
  isDraftCorrection,
  isImmediateRepeat,
  CONFIRM_NOTHING_PENDING_LINE,
} from '../../src/routes/assistant';
import {
  InMemoryProposalRepository,
  createProposal,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type {
  EntityCandidate,
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-chat-parity';
const USER = 'user-chat-parity';
const CONVERSATION = 'conv-chat-parity';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT_ID = '22222222-2222-4222-8222-222222222222';
const TIMEZONE = 'America/Phoenix';

/**
 * The scripted model: classifier calls read the script, every OTHER gateway
 * call (the drafting handlers' own) echoes the classifier's entities back
 * without inventing anything — the faithful, non-inventing stand-in the
 * harness uses, so a test can never pass because a fake model volunteered a
 * uuid the real pipeline would have had to resolve.
 */
function scriptedGateway(script: Array<{ intentType: string; entities?: Record<string, unknown> }>) {
  let i = 0;
  let lastEntities: Record<string, unknown> = {};
  const complete = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    if (req.taskType === 'classify_intent') {
      const entry = script[Math.min(i, script.length - 1)];
      i += 1;
      lastEntities = entry.entities ?? {};
      return {
        content: JSON.stringify({
          intentType: entry.intentType,
          confidence: 0.94,
          reasoning: 'scripted',
          extractedEntities: lastEntities,
        }),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }
    return {
      content: JSON.stringify({
        ...lastEntities,
        content: 'Tell me a bit more about what you need.',
        reasoning: 'scripted drafting echo',
      }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    };
  });
  return { complete } as unknown as LLMGateway;
}

function candidate(id: string, kind: EntityCandidate['kind'], label: string): EntityCandidate {
  return { id, kind, label, score: 0.95 };
}

/** Resolves the fixtures below, `not_found` for everything else. */
function fixtureResolver(over: Partial<Record<string, EntityResolverResult>> = {}): EntityResolver {
  return {
    resolve: async ({ reference, kind }) => {
      const override = over[kind];
      if (override) return override;
      if (kind === 'customer' && /garcia/i.test(reference)) {
        return { kind: 'resolved', candidate: candidate(CUSTOMER_ID, 'customer', 'Garcia') };
      }
      if (kind === 'appointment' && /garcia/i.test(reference)) {
        return {
          kind: 'resolved',
          candidate: candidate(APPOINTMENT_ID, 'appointment', 'Garcia Tuesday'),
        };
      }
      return { kind: 'not_found', reference };
    },
  };
}

function buildApp(opts: {
  gateway: LLMGateway;
  proposalRepo: InMemoryProposalRepository;
  entityResolver?: EntityResolver;
  auditRepo?: InMemoryAuditRepository;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'sess-parity',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: opts.gateway,
      proposalRepo: opts.proposalRepo,
      appointmentRepo: new InMemoryAppointmentRepository(),
      jobRepo: new InMemoryJobRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      conversationRepo: new InMemoryConversationRepository(),
      auditRepo: opts.auditRepo ?? new InMemoryAuditRepository(),
      tenantTimezoneResolver: async () => TIMEZONE,
      ...(opts.entityResolver ? { entityResolver: opts.entityResolver } : {}),
    }),
  );
  return app;
}

/** Post one turn, carrying the running thread the way the assistant page does. */
async function chat(
  app: express.Express,
  history: string[],
  inputMode: 'text' | 'voice' = 'text',
) {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const [index, text] of history.entries()) {
    messages.push({ role: 'user', content: text });
    if (index < history.length - 1) messages.push({ role: 'assistant', content: 'ok' });
  }
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages, conversationId: CONVERSATION, inputMode });
}

const BOOK = 'Book Garcia for Tuesday at 2 pm for the HVAC install';
const bookScript = () => [
  {
    intentType: 'create_appointment',
    entities: {
      customerName: 'Garcia',
      dateTimeDescription: 'Tuesday at 2 pm',
      jobTitle: 'HVAC install',
    },
  },
];

// ── 1. The contract gate (pure) ─────────────────────────────────────────────

describe('contractGateMissingFields — the chat chokepoint contract gate', () => {
  it('names customerId for a booking that carries neither a job nor a customer', () => {
    expect(
      contractGateMissingFields('create_appointment', {
        scheduledStart: '2026-09-15T21:00:00.000Z',
        scheduledEnd: '2026-09-15T22:00:00.000Z',
      }),
    ).toContain('customerId');
  });

  it('names the zod path for a field-level failure (editActions)', () => {
    expect(
      contractGateMissingFields('update_estimate', {
        estimateId: '33333333-3333-4333-8333-333333333333',
        editActions: [],
      }),
    ).toContain('editActions');
  });

  it('names status for an update_job with nothing to change', () => {
    expect(
      contractGateMissingFields('update_job', {
        jobId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toContain('status');
  });

  it('is empty for a payload that is approvable as drafted', () => {
    expect(
      contractGateMissingFields('create_appointment', {
        customerId: CUSTOMER_ID,
        scheduledStart: '2026-09-15T21:00:00.000Z',
        scheduledEnd: '2026-09-15T22:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('pulls an already-approved proposal back to draft rather than gate-and-execute', () => {
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      summary: 'Appointment',
      payload: { scheduledStart: '2026-09-15T21:00:00.000Z' },
      createdBy: USER,
    });
    proposal.status = 'approved';
    const added = applyContractGate(proposal);
    expect(added).toContain('customerId');
    expect(proposal.status).toBe('draft');
    expect(missingFieldsFor(proposal)).toContain('customerId');
  });
});

// ── 2. Resolver-verified ids reach the payload ──────────────────────────────

describe('applyVerifiedIdsToPayload', () => {
  function draft(payload: Record<string, unknown>, missingFields?: string[]): Proposal {
    return createProposal({
      tenantId: TENANT,
      proposalType: 'confirm_appointment',
      summary: 'Confirm',
      payload,
      createdBy: USER,
      ...(missingFields ? { sourceContext: { missingFields } } : {}),
    });
  }

  it('writes a resolved id the drafting model never echoed, and lifts its gate', () => {
    const proposal = draft({ appointmentReference: 'Garcia Tuesday' }, ['appointmentId']);
    expect(applyVerifiedIdsToPayload(proposal, { appointmentId: APPOINTMENT_ID })).toEqual([
      'appointmentId',
    ]);
    expect(proposal.payload.appointmentId).toBe(APPOINTMENT_ID);
    // Filling without lifting would leave a card that carries the id AND
    // refuses to approve — strictly worse than doing nothing.
    expect(missingFieldsFor(proposal)).not.toContain('appointmentId');
  });

  it('never overwrites an id the handler resolved for itself', () => {
    const mine = '55555555-5555-4555-8555-555555555555';
    const proposal = draft({ appointmentId: mine });
    expect(applyVerifiedIdsToPayload(proposal, { appointmentId: APPOINTMENT_ID })).toEqual([]);
    expect(proposal.payload.appointmentId).toBe(mine);
  });

  it('ignores keys outside the gated-id vocabulary', () => {
    const proposal = draft({ appointmentId: APPOINTMENT_ID });
    expect(applyVerifiedIdsToPayload(proposal, { somethingElse: 'x' })).toEqual([]);
    expect(proposal.payload.somethingElse).toBeUndefined();
  });
});

// ── 3. One request, one card (pure predicates) ──────────────────────────────

describe('one request, one card — predicates', () => {
  it('sees an immediate repeat regardless of casing, spacing and trailing stops', () => {
    expect(
      isImmediateRepeat([
        { role: 'user', content: 'Book Garcia for Tuesday' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '  book garcia for tuesday.  ' },
      ]),
    ).toBe(true);
  });

  it('does not treat a different request as a repeat', () => {
    expect(
      isImmediateRepeat([
        { role: 'user', content: 'Book Garcia for Tuesday' },
        { role: 'user', content: 'Book Khan for Friday' },
      ]),
    ).toBe(false);
  });

  it('treats an explicit negation as a correction and a softener as a new request', () => {
    expect(isDraftCorrection('no, make it Thursday at 10 am')).toBe(true);
    expect(isDraftCorrection('Scratch that — Thursday')).toBe(true);
    expect(isDraftCorrection('actually, also book Khan for Friday')).toBe(false);
  });
});

// ── The route, end to end ───────────────────────────────────────────────────

describe('POST /api/assistant/chat — voice/text parity', () => {
  it('never persists an approve-to-fail booking: the resolved customer lands on the payload', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway(bookScript()),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    const res = await chat(app, [BOOK]);

    expect(res.status).toBe(200);
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].proposalType).toBe('create_appointment');
    expect(rows[0].payload.customerId).toBe(CUSTOMER_ID);
    expect(missingFieldsFor(rows[0])).toEqual([]);
  });

  it('gates the booking instead of minting an ungated invalid card when nothing resolves', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        {
          intentType: 'create_appointment',
          entities: { customerName: 'Nobody', dateTimeDescription: 'Tuesday at 2 pm' },
        },
      ]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    const res = await chat(app, ['Book Nobody for Tuesday at 2 pm']);

    expect(res.status).toBe(200);
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.customerId).toBeUndefined();
    // Gated, so Approve is blocked — not an ungated payload that throws on
    // execution ("create_appointment requires jobId … or a customerId").
    expect(missingFieldsFor(rows[0])).toContain('customerId');
  });

  it('a double-submit returns the SAME card instead of a second one', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway(bookScript());
    const app = buildApp({ gateway, proposalRepo, entityResolver: fixtureResolver() });

    const first = await chat(app, [BOOK]);
    const second = await chat(app, [BOOK, BOOK]);

    expect(second.status).toBe(200);
    expect(second.body.taskType).toBe('assistant.duplicate_turn');
    expect(second.body.message.proposal.id).toBe(first.body.message.proposal.id);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('a correction rewrites the draft in place rather than leaving two bookings', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        bookScript()[0],
        {
          intentType: 'create_appointment',
          entities: {
            customerName: 'Garcia',
            dateTimeDescription: 'Thursday at 10 am',
            jobTitle: 'HVAC install',
          },
        },
      ]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    const first = await chat(app, [BOOK]);
    const second = await chat(app, [BOOK, 'no, make it Thursday at 10 am']);

    expect(second.status).toBe(200);
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.body.message.proposal.id);
    // The corrected slot, not the one the operator just rejected: Thursday
    // (ISO weekday 4) in the tenant's zone.
    expect(
      DateTime.fromISO(String(rows[0].payload.scheduledStart), { zone: TIMEZONE }).weekday,
    ).toBe(4);
    expect(rows[0].payload.customerId).toBe(CUSTOMER_ID);
    expect(second.body.message.content).toContain('Updated');
  });

  it('a second, genuinely different booking still gets its own card', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        bookScript()[0],
        {
          intentType: 'create_appointment',
          entities: { customerName: 'Garcia', dateTimeDescription: 'Friday at 9 am' },
        },
      ]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    await chat(app, [BOOK]);
    await chat(app, [BOOK, 'Book Garcia for Friday at 9 am']);

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(2);
  });

  it('a bare "yes" with nothing pending gets the shared re-prompt, never the generic model', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([{ intentType: 'confirm' }]);
    const app = buildApp({ gateway, proposalRepo, entityResolver: fixtureResolver() });

    const res = await chat(app, ['yes']);

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.confirm_nothing_pending');
    expect(res.body.message.content).toBe(CONFIRM_NOTHING_PENDING_LINE);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    // Exactly one gateway call — the classifier. The narrative model is never
    // consulted, so it cannot improvise a confirmation.
    expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('a "yes" with a card waiting points at the tap and approves nothing', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([bookScript()[0], { intentType: 'confirm' }]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    await chat(app, [BOOK]);
    const res = await chat(app, [BOOK, 'yes']);

    expect(res.body.taskType).toBe('assistant.confirm_nothing_pending');
    expect(res.body.message.content).toContain('tap Approve');
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ready_for_review');
  });

  it('the same guard applies to a mic transcript (inputMode: voice)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([{ intentType: 'confirm' }]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    const res = await chat(app, ['yes'], 'voice');

    expect(res.body.taskType).toBe('assistant.confirm_nothing_pending');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('cancelling an appointment that does not exist answers honestly and drafts nothing', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        {
          intentType: 'cancel_appointment',
          entities: { customerName: 'Patel', appointmentReference: 'the Patel appointment' },
        },
      ]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    const res = await chat(app, ['Cancel the Patel appointment']);

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.cancel_appointment.not_found');
    expect(res.body.message.content).toMatch(/couldn't find/i);
    expect(res.body.message.content).toMatch(/haven't scheduled, changed, or cancelled anything/i);
    // No card at all — a card gated on an id the resolver confirmed absent
    // could never be approved by anyone (#909).
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('an appointment the resolver CAN find still drafts its card', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      gateway: scriptedGateway([
        {
          intentType: 'cancel_appointment',
          entities: {
            customerName: 'Garcia',
            appointmentReference: "Garcia's Tuesday appointment",
          },
        },
      ]),
      proposalRepo,
      entityResolver: fixtureResolver(),
    });

    await chat(app, ["Cancel Garcia's Tuesday appointment"]);

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.appointmentId).toBe(APPOINTMENT_ID);
  });
});
