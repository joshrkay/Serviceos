/**
 * #1499 (LLM QA 2026-09-29) — multi-step chat requests, clarifications and
 * card copy, pinned at the chat SURFACE: POST /api/assistant/chat with a
 * scripted gateway replaying the classifier JSON the live turn produced
 * (evidence: ~/Serviceos-qa-evidence/2026-09-29-llm/chat/, matrix AST-04/07).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter, type AssistantRouterDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildJob } from '../factories/job.factory';
import type { CatalogItem, CatalogItemRepository } from '../../src/catalog/catalog-item';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityKind, EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type Classified = { intentType: string; entities?: Record<string, unknown> };

/**
 * One gateway for the whole turn. The classifier call is answered from
 * `byText` keyed on the exact text classified (the whole turn, or one chain
 * segment); drafting calls get `drafts[<system prompt prefix>]`.
 */
function scriptedGateway(
  byText: Record<string, Classified>,
  drafts: Record<string, string> = {},
): LLMGateway {
  return {
    complete: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      let content = JSON.stringify({ intentType: 'unknown', confidence: 0.2, reasoning: 'unscripted' });
      const draftKey = Object.keys(drafts).find((prefix) => system.startsWith(prefix));
      if (draftKey) {
        content = drafts[draftKey];
      } else {
        // Longest scripted text the classifier input contains wins, so a
        // segment never matches the whole-turn entry that contains it.
        const key = Object.keys(byText)
          .filter((text) => user.includes(text))
          .sort((a, b) => b.length - a.length)[0];
        if (key) {
          const c = byText[key];
          content = JSON.stringify({
            intentType: c.intentType,
            confidence: 0.92,
            reasoning: 'scripted',
            extractedEntities: c.entities ?? {},
          });
        }
      }
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

function buildApp(deps: Partial<AssistantRouterDeps> & { gateway: LLMGateway; proposalRepo: InMemoryProposalRepository }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1499',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({ tenantTimezoneResolver: async () => 'America/Phoenix', ...deps } as AssistantRouterDeps),
  );
  return app;
}

const chat = (app: ReturnType<typeof buildApp>, content: string) =>
  request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], conversationId: CONVERSATION_ID });

const ESTIMATE_DRAFT = JSON.stringify({
  lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 120000 }],
  confidence_score: 0.9,
});

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1499 slice 1 — a multi-step reply names every step it did not draft', () => {
  // AST-07: three "then" steps, two cards, and the reply said "Created 2
  // linked steps" as if that were the whole ask. The invoice step vanished.
  // #1513 — a bare "create (and send) the invoice" leg is now drafted even
  // when it classifies as nothing, so the dropped step here is one the chain
  // genuinely has no handler for.
  it('chain: the dropped third step is named in the reply, with an offer to do it', async () => {
    const turn =
      'New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, then order the parts from the supplier.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'create_customer', entities: { displayName: 'Jane Smith', phone: '555-0101' } },
          'New customer Jane Smith, phone 555-0101': {
            intentType: 'create_customer',
            entities: { displayName: 'Jane Smith', phone: '555-0101' },
          },
          'draft an estimate for her for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { lineItemDescriptions: ['water heater install'] },
          },
          'order the parts from the supplier.': { intentType: 'unknown' },
        },
        { 'You are an estimate generation assistant': ESTIMATE_DRAFT },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType).sort()).toEqual([
      'create_customer',
      'draft_estimate',
    ]);
    const content: string = res.body.message.content;
    expect(content).toContain('order the parts from the supplier');
    expect(content).toMatch(/didn't draft|haven't drafted/i);
    expect(content).toMatch(/want me to/i);
  });

  // C23: no "then", so the chain path never ran; the classifier picked the
  // customer and the booking was never mentioned again.
  it('compound "X, and book her …": the booking the single card did not cover is named in the reply', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411, and book her for an AC check Thursday at 9am.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType)).toEqual(['create_customer']);
    const content: string = res.body.message.content;
    expect(content).toContain('book her for an AC check Thursday at 9am');
    expect(content).toMatch(/didn't draft/i);
    expect(content).toMatch(/want me to/i);
  });

  it('a single-step request carries no undrafted-step note', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });
});

describe('#1499 slice 2 — "create an invoice for job X and send it" drafts the invoice from the job', () => {
  const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
  const CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const INVOICE_DRAFT = JSON.stringify({
    lineItems: [{ description: 'Blower motor replacement', quantity: 1, unitPrice: 42500 }],
    confidence_score: 0.9,
  });

  // C22: the classifier read the turn as issue_invoice, and the JOB number
  // rode through to invoiceId. The card was "Issue invoice JOB-0081" and no
  // invoice existed.
  it('issue_invoice with a job number as invoiceId becomes a draft_invoice on that job, and the reply says the send comes next', async () => {
    const turn = 'Create an invoice for job JOB-0081 and send it.';
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TEST_TENANT, customerId: CUSTOMER_ID, jobNumber: 'JOB-0081' }));
    const app = buildApp({
      proposalRepo,
      jobRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      gateway: scriptedGateway(
        { [turn]: { intentType: 'issue_invoice', entities: { jobReference: 'JOB-0081' } } },
        { 'You are an invoice generation assistant': INVOICE_DRAFT },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    // #1480 item 4 / #1513 — the send half is a linked send_invoice step for
    // the invoice being drafted (the bare leg is an invoice leg even when it
    // classifies as nothing on its own).
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.map((p) => p.proposalType).sort()).toEqual(['draft_invoice', 'send_invoice']);
    const payload = persisted.find((p) => p.proposalType === 'draft_invoice')!.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(JOB_ID);
    expect(payload.customerId).toBe(CUSTOMER_ID);
    expect(payload.invoiceId).toBeUndefined();
    expect(res.body.message.proposal.proposalType).toBe('draft_invoice');
    expect(res.body.message.content).toMatch(/send/i);
  });

  // Without create wording it really is "send the existing one" — but a job
  // number is provably not an invoice id, one tap from being submitted as one.
  it('a plain issue never carries the job number as its invoiceId, and cannot be approved as-is', async () => {
    const turn = 'Issue the invoice for job JOB-0081.';
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TEST_TENANT, customerId: CUSTOMER_ID, jobNumber: 'JOB-0081' }));
    const app = buildApp({
      proposalRepo,
      jobRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      // The taxonomy tells the classifier to put an issue_invoice reference in
      // jobReference — the live C22 card carried it through as invoiceId.
      gateway: scriptedGateway({ [turn]: { intentType: 'issue_invoice', entities: { jobReference: 'JOB-0081' } } }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.proposalType).toBe('issue_invoice');
    expect((persisted.payload as Record<string, unknown>).invoiceId).not.toBe('JOB-0081');
    await expect(approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner')).rejects.toThrow();
  });
});

/** A resolver scripted per (kind, reference); anything unscripted is not_found. */
function scriptedResolver(
  script: (kind: EntityKind, reference: string) => EntityResolverResult | undefined,
): EntityResolver {
  return {
    resolve: vi.fn(async ({ kind, reference }: { kind: EntityKind; reference: string }) =>
      script(kind, reference) ?? { kind: 'not_found' as const, reference },
    ),
  } as unknown as EntityResolver;
}

describe('#1499 slice 3 — a clarification asks for the field that is actually missing', () => {
  // C18: the job was named, the technician was not ("the technician"), and
  // the reply asked for "the date and time".
  it('reassign with no technician named asks which team member, not for a date and time', async () => {
    const turn = 'Reassign job JOB-0082 to the technician.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      entityResolver: scriptedResolver((kind) =>
        kind === 'appointment'
          ? {
              kind: 'low_confidence',
              candidate: { id: '44444444-4444-4444-8444-444444444444', kind: 'appointment', label: 'JOB-0082', score: 0.7 },
            }
          : undefined,
      ),
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'reassign_appointment',
          entities: { appointmentReference: 'JOB-0082', targetTechnicianName: 'the technician' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const content: string = res.body.message.content;
    expect(content).not.toMatch(/date and time/i);
    expect(content).toMatch(/which team member|team member's name/i);
  });

  // C25: two customers named Dana. The reply asked for "the date and time";
  // the gap is which Dana.
  it('"Dana\'s appointment" with two Danas on file asks which Dana', async () => {
    const turn = "Reschedule Dana's appointment to next Monday.";
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      entityResolver: scriptedResolver((kind, reference) =>
        kind === 'customer' && /^dana$/i.test(reference.trim())
          ? {
              kind: 'ambiguous',
              candidates: [
                { id: '55555555-5555-4555-8555-555555555555', kind: 'customer', label: 'Dana Reyes', score: 0.9 },
                { id: '66666666-6666-4666-8666-666666666666', kind: 'customer', label: 'Dana Whitfield', score: 0.9 },
              ],
            }
          : undefined,
      ),
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'reschedule_appointment',
          entities: { appointmentReference: "Dana's appointment", newDateTimeDescription: 'next Monday' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const content: string = res.body.message.content;
    expect(content).not.toMatch(/date and time/i);
    expect(content).toContain('Dana Reyes');
    expect(content).toContain('Dana Whitfield');
  });

  // C17: Morgan is a customer with no appointment. The reply asked for "the
  // date and time" (which the operator had given); the truth is there is no
  // appointment of Morgan's to move.
  it('reschedule for a customer who has no appointment says so, instead of asking for a date and time', async () => {
    const turn = "Reschedule Morgan Tatebrook's appointment to Friday at 2pm.";
    const MORGAN = '77777777-7777-4777-8777-777777777777';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      entityResolver: scriptedResolver((kind, reference) =>
        kind === 'customer' && reference === 'Morgan Tatebrook'
          ? { kind: 'resolved', candidate: { id: MORGAN, kind: 'customer', label: 'Morgan Tatebrook', score: 1 } }
          : undefined,
      ),
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'reschedule_appointment',
          entities: { appointmentReference: 'Morgan Tatebrook', newDateTimeDescription: 'Friday at 2pm' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const content: string = res.body.message.content;
    expect(content).not.toMatch(/date and time/i);
    expect(content).toMatch(/couldn't find a matching appointment for Morgan Tatebrook/i);
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toEqual([]);
  });
});

function catalogItem(id: string, name: string, unitPriceCents: number): CatalogItem {
  return {
    id,
    tenantId: TEST_TENANT,
    name,
    description: name,
    category: 'labor',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'service',
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as CatalogItem;
}

describe('#1499 slice 4 — card copy and card fields', () => {
  const CUSTOMER = '88888888-8888-4888-8888-888888888888';
  const LOCATED_ESTIMATE_TURN =
    'Draft an estimate for Intake QA49125: blower motor replacement $425 and a diagnostic visit $89.';

  function estimateApp(proposalRepo: InMemoryProposalRepository) {
    return buildApp({
      proposalRepo,
      catalogRepo: {
        listByTenant: vi.fn(async () => [
          catalogItem('cat-blower', 'Blower Motor Replacement', 42500),
          catalogItem('cat-diag-a', 'Diagnostic Visit', 8900),
          catalogItem('cat-diag-b', 'Diagnostic Visit', 12900),
        ]),
      } as unknown as CatalogItemRepository,
      entityResolver: scriptedResolver((kind) =>
        kind === 'customer'
          ? { kind: 'resolved', candidate: { id: CUSTOMER, kind: 'customer', label: 'Intake QA49125', score: 1 } }
          : undefined,
      ),
      gateway: scriptedGateway(
        {
          [LOCATED_ESTIMATE_TURN]: {
            intentType: 'draft_estimate',
            entities: {
              customerName: 'Intake QA49125',
              lineItemDescriptions: ['blower motor replacement', 'diagnostic visit'],
            },
          },
        },
        {
          'You are an estimate generation assistant': JSON.stringify({
            lineItems: [
              { description: 'Blower motor replacement', quantity: 1, unitPrice: 42500 },
              { description: 'Diagnostic visit', quantity: 1, unitPrice: 8900 },
            ],
            confidence_score: 0.9,
          }),
        },
      ),
    });
  }

  // C35: a line still needed a catalog pick, approve returned 400, and the
  // reply said "Review and approve to proceed".
  it('a card with a line item still to pick does not say "Review and approve"; it says what to pick', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const res = await chat(estimateApp(proposalRepo), LOCATED_ESTIMATE_TURN);
    expect(res.status).toBe(200);
    expect(res.body.message.proposal.missingFields).toContain('lineItems[1].catalogItemId');
    const content: string = res.body.message.content;
    expect(content).not.toMatch(/review and approve/i);
    expect(content).toMatch(/pick/i);
    expect(content).toContain('Diagnostic visit');
  });

  // C35's title: "… $425 and a diagno" — cut mid-word at 80 characters.
  it('a long title is shortened on a word boundary, with an ellipsis', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const res = await chat(estimateApp(proposalRepo), LOCATED_ESTIMATE_TURN);
    expect(res.status).toBe(200);
    expect(res.body.message.proposal.title).toBe(
      'Estimate: Draft an estimate for Intake QA49125: blower motor replacement $425 and a…',
    );
  });

  // Battery 2: every chat proposal carried its conversationId except
  // create_customer's, so the thread could not find its own customer card.
  it('a chat create_customer proposal carries the conversationId', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: { intentType: 'create_customer', entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' } },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.proposalType).toBe('create_customer');
    expect(persisted.sourceContext?.conversationId).toBe(CONVERSATION_ID);
  });
});

