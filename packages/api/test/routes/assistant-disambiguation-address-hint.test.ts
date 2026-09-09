/**
 * U1–U2 — the chat surface's ambiguous-customer loop, with the ADDRESS on it.
 *
 * The defect these pin is not "the question is ugly". Two customers named
 * Smith are told apart by where they live; the chat question listed a phone
 * number and nothing else, and the answer an operator actually types ("104
 * Cedar") had no address to match against, so the request was lost. Meanwhile
 * the live-voice panel — the same operator, the same tenant, the same
 * resolver — read the address out loud, because the in-app adapter carried its
 * own private `service_locations` query the chat route could not reach.
 *
 * THE RESOLVER STUB HERE RETURNS PHONE-ONLY HINTS, exactly like
 * `PgEntityResolver.resolveCustomer` (pg-entity-resolver.ts: `hint:
 * row.primary_phone ?? undefined`), and deliberately NOT the pre-enriched
 * shape. If the address in these assertions were fixture-supplied the tests
 * would prove nothing about what an operator sees — every address below is
 * produced by the shipped `withCustomerAddressHints` decorator reading the
 * seeded `locationRepo`, wired the way `createAssistantRouter` wires it.
 *
 * Both halves of the loop are asserted on the PERSISTED ROW, because the row
 * is the card the operator taps: turn 1 leaves ONE gated draft of the REAL
 * proposal type (never a `voice_clarification`) carrying the pending question,
 * and turn 2 fills the id, clears the gate, stamps `verifiedIds`, and leaves
 * the card approvable through the real `approveProposal` guard.
 */
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createAssistantRouter } from '../../src/routes/assistant';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import {
  InMemoryLocationRepository,
  type ServiceLocation,
} from '../../src/locations/location';
import { PENDING_AMBIGUITY_KEY } from '../../src/ai/resolution/gated-reference-resolution';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-hint';
const USER = 'user-hint';
const TIMEZONE = 'America/Phoenix';
const SMITH_A = '11111111-1111-4111-8111-111111111104';
const SMITH_B = '22222222-2222-4222-8222-222222222105';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

/** Phone-only, exactly as `PgEntityResolver.resolveCustomer` returns it. */
const TWO_SMITHS: EntityResolverResult = {
  kind: 'ambiguous',
  candidates: [
    { id: SMITH_A, kind: 'customer', label: 'Smith', hint: '+14805550104', score: 0.95 },
    { id: SMITH_B, kind: 'customer', label: 'Smith', hint: '+14805550105', score: 0.94 },
  ],
};

function phoneOnlyResolver(over: Partial<Record<string, EntityResolverResult>> = {}): EntityResolver {
  return {
    resolve: vi.fn(async ({ reference, kind }) => {
      const override = over[kind];
      if (override) return override;
      if (kind === 'customer' && /smith/i.test(reference)) return TWO_SMITHS;
      return { kind: 'not_found', reference };
    }),
  };
}

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
    // The drafting stand-in: echoes the classifier's entities, invents
    // nothing, and repeats no uuid.
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

function location(customerId: string, street1: string): ServiceLocation {
  return {
    id: `loc-${customerId}`,
    tenantId: TENANT,
    customerId,
    street1,
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85004',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

let proposalRepo: InMemoryProposalRepository;
let auditRepo: InMemoryAuditRepository;
let locationRepo: InMemoryLocationRepository;

beforeEach(async () => {
  proposalRepo = new InMemoryProposalRepository();
  auditRepo = new InMemoryAuditRepository();
  locationRepo = new InMemoryLocationRepository();
  await locationRepo.create(location(SMITH_A, '104 QA Cedar Avenue'));
  await locationRepo.create(location(SMITH_B, '105 QA Cedar Avenue'));
});

function buildApp(opts: {
  gateway: LLMGateway;
  entityResolver: EntityResolver;
  /** Omit to prove the no-repo degradation (the phone-only question). */
  withLocations?: boolean;
  invoiceRepo?: InMemoryInvoiceRepository;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'sess-hint',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: opts.gateway,
      proposalRepo,
      appointmentRepo: new InMemoryAppointmentRepository(),
      jobRepo: new InMemoryJobRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      ...(opts.invoiceRepo ? { invoiceRepo: opts.invoiceRepo } : {}),
      conversationRepo: new InMemoryConversationRepository(),
      auditRepo,
      tenantTimezoneResolver: async () => TIMEZONE,
      entityResolver: opts.entityResolver,
      ...(opts.withLocations === false ? {} : { locationRepo }),
    }),
  );
  return app;
}

async function chat(
  app: express.Express,
  history: string[],
  inputMode: 'text' | 'voice' = 'text',
  conversationId = 'conv-hint',
) {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const [index, text] of history.entries()) {
    messages.push({ role: 'user', content: text });
    if (index < history.length - 1) messages.push({ role: 'assistant', content: 'ok' });
  }
  return request(app).post('/api/assistant/chat').send({ messages, conversationId, inputMode });
}

const BOOK = 'Book Smith furnace maintenance Tuesday at 2 pm';
const bookScript = [
  {
    intentType: 'create_appointment',
    entities: {
      customerName: 'Smith',
      dateTimeDescription: 'Tuesday at 2 pm',
      jobTitle: 'Furnace maintenance',
    },
  },
];

const SEND = 'Send Smith the invoice link';
const sendScript = [
  { intentType: 'send_invoice', entities: { customerName: 'Smith', sendChannel: 'sms' } },
];

function pendingOn(proposal: Proposal): Record<string, unknown> | undefined {
  return (proposal.sourceContext ?? {})[PENDING_AMBIGUITY_KEY] as
    | Record<string, unknown>
    | undefined;
}

describe('chat ambiguous customer — the question carries the address (book-03 shape)', () => {
  for (const inputMode of ['text', 'voice'] as const) {
    it(`asks ONE numbered question listing both addresses and gates the REAL type (inputMode: ${inputMode})`, async () => {
      const app = buildApp({
        gateway: scriptedGateway(bookScript),
        entityResolver: phoneOnlyResolver(),
      });

      const res = await chat(app, [BOOK], inputMode, `conv-book-${inputMode}`);
      expect(res.status).toBe(200);

      const content: string = res.body.message.content;
      expect(content).toContain('I found 2 customers matching "Smith"');
      // The addresses came from the decorator over `locationRepo`; the
      // resolver only ever said "+1480555010x".
      expect(content).toContain('104 QA Cedar Avenue, Phoenix');
      expect(content).toContain('105 QA Cedar Avenue, Phoenix');
      expect(content).toContain('1. Smith');
      expect(content).toContain('2. Smith');

      const rows = await proposalRepo.findByTenant(TENANT);
      expect(rows).toHaveLength(1);
      // NEVER a clarification card: the day, the job and the customer name a
      // clarification would have thrown away are all still on the row.
      expect(rows[0].proposalType).toBe('create_appointment');
      expect(missingFieldsFor(rows[0])).toEqual(['customerId']);
      expect(rows[0].payload.customerId).toBeUndefined();
      const pending = pendingOn(rows[0]);
      expect(pending?.refKey).toBe('customerId');
      expect(pending?.attemptCount).toBe(0);
      expect((pending?.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
        SMITH_A,
        SMITH_B,
      ]);
    });

    it(`completes the ORIGINAL draft from the next turn's "104 Cedar" (inputMode: ${inputMode})`, async () => {
      const app = buildApp({
        gateway: scriptedGateway(bookScript),
        entityResolver: phoneOnlyResolver(),
      });
      const conversationId = `conv-answer-${inputMode}`;

      const first = await chat(app, [BOOK], inputMode, conversationId);
      const draftId = (await proposalRepo.findByTenant(TENANT))[0].id;

      const second = await chat(app, [BOOK, '104 Cedar'], inputMode, conversationId);
      expect(second.status).toBe(200);

      // ONE card for one request — the answer completed the draft in place.
      const rows = await proposalRepo.findByTenant(TENANT);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(draftId);
      expect(rows[0].proposalType).toBe('create_appointment');
      expect(rows[0].payload.customerId).toBe(SMITH_A);
      expect(missingFieldsFor(rows[0])).toEqual([]);
      expect(
        (rows[0].sourceContext?.verifiedIds as Record<string, unknown>).customerId,
      ).toBe(SMITH_A);
      // The question is spent, not left to swallow a later message.
      expect(pendingOn(rows[0])).toBeUndefined();
      expect(second.body.message.content).toContain('Smith');
      expect(second.body.message.content).toContain('got it');
      expect(first.body.message.proposal.id).toBe(draftId);

      // The card is now genuinely approvable — the gate the answer lifted was
      // the only thing `approveProposal` was refusing on.
      await expect(
        approveProposal(proposalRepo, TENANT, draftId, USER, 'owner', auditRepo),
      ).resolves.toBeDefined();
    });
  }

  it('an ordinal answer resolves the same draft', async () => {
    const app = buildApp({
      gateway: scriptedGateway(bookScript),
      entityResolver: phoneOnlyResolver(),
    });
    await chat(app, [BOOK], 'text', 'conv-ordinal');
    await chat(app, [BOOK, 'the second one'], 'text', 'conv-ordinal');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.customerId).toBe(SMITH_B);
  });

  it('a phone fragment resolves too', async () => {
    const app = buildApp({
      gateway: scriptedGateway(bookScript),
      entityResolver: phoneOnlyResolver(),
    });
    await chat(app, [BOOK], 'text', 'conv-phone');
    await chat(app, [BOOK, '+14805550105'], 'text', 'conv-phone');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows[0].payload.customerId).toBe(SMITH_B);
  });

  it('an answer that matches neither re-asks and counts the attempt — never guesses', async () => {
    const app = buildApp({
      gateway: scriptedGateway(bookScript),
      entityResolver: phoneOnlyResolver(),
    });
    await chat(app, [BOOK], 'text', 'conv-miss');
    const retry = await chat(app, [BOOK, '999 Nowhere Street'], 'text', 'conv-miss');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.customerId).toBeUndefined();
    expect(missingFieldsFor(rows[0])).toEqual(['customerId']);
    expect(pendingOn(rows[0])?.attemptCount).toBe(1);
    expect(retry.body.message.content).toContain('Which one');
  });

  it('degrades to the phone-only question when no locationRepo is wired — no throw', async () => {
    const app = buildApp({
      gateway: scriptedGateway(bookScript),
      entityResolver: phoneOnlyResolver(),
      withLocations: false,
    });

    const res = await chat(app, [BOOK], 'text', 'conv-nolocs');
    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('+14805550104');
    expect(res.body.message.content).not.toContain('QA Cedar Avenue');
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows[0].proposalType).toBe('create_appointment');
    expect(pendingOn(rows[0])?.refKey).toBe('customerId');
  });
});

describe('chat ambiguous customer on a type whose contract never mentions it (inv-05 shape)', () => {
  for (const inputMode of ['text', 'voice'] as const) {
    it(`gates send_invoice on customerId, asks once, and fills it from "104 Cedar" (inputMode: ${inputMode})`, async () => {
      const app = buildApp({
        gateway: scriptedGateway(sendScript),
        entityResolver: phoneOnlyResolver(),
      });
      const conversationId = `conv-send-${inputMode}`;

      const first = await chat(app, [SEND], inputMode, conversationId);
      expect(first.body.message.content).toContain('104 QA Cedar Avenue, Phoenix');

      const rows1 = await proposalRepo.findByTenant(TENANT);
      expect(rows1).toHaveLength(1);
      expect(rows1[0].proposalType).toBe('send_invoice');
      // `sendInvoicePayloadSchema` has no customerId at all, so nothing in the
      // contract gate could have produced this gate — it is the pre-draft
      // ambiguity, carried onto the draft so the question has somewhere to
      // hang. Both gates are present; only ONE question is asked.
      expect(missingFieldsFor(rows1[0]).sort()).toEqual(['customerId', 'invoiceId']);
      expect(pendingOn(rows1[0])?.refKey).toBe('customerId');

      const second = await chat(app, [SEND, '104 Cedar'], inputMode, conversationId);

      const rows2 = await proposalRepo.findByTenant(TENANT);
      expect(rows2).toHaveLength(1);
      expect(rows2[0].payload.customerId).toBe(SMITH_A);
      // The SECOND gate is now the one asked about — not silently dropped.
      expect(missingFieldsFor(rows2[0])).toEqual(['invoiceId']);
      expect(second.body.message.content).toContain('got it');
      expect(second.body.message.content.toLowerCase()).toContain('invoice number');
    });
  }

  it('does not gate on an ambiguity the resolver no longer reports', async () => {
    // The pre-draft pass sees two Smiths; the post-draft pass resolves the
    // reference outright. The speculative gate must not survive that.
    let call = 0;
    const flapping: EntityResolver = {
      resolve: vi.fn(async ({ reference, kind }) => {
        if (kind !== 'customer') return { kind: 'not_found', reference } as EntityResolverResult;
        call += 1;
        if (call === 1) return TWO_SMITHS;
        return {
          kind: 'resolved',
          candidate: { id: SMITH_A, kind: 'customer', label: 'Smith', score: 0.99 },
        } as EntityResolverResult;
      }),
    };
    const app = buildApp({ gateway: scriptedGateway(sendScript), entityResolver: flapping });

    await chat(app, [SEND], 'text', 'conv-flap');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    // customerId was filled by the post-draft pass, so its gate is gone; the
    // invoiceId gate the handler stamped is untouched.
    expect(missingFieldsFor(rows[0])).toEqual(['invoiceId']);
    expect(rows[0].payload.customerId).toBe(SMITH_A);
  });
});
