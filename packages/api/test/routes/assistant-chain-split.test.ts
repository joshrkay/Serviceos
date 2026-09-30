/**
 * #1480 item 4 — compound / chained operator asks in chat are split into
 * LINKED proposals (one chainId), not one card plus a "didn't draft" note.
 * Pinned at the chat SURFACE: POST /api/assistant/chat with a scripted
 * gateway replaying the classifier shapes the live turns produced (QA matrix
 * AST-04 / AST-07 / C23), and at approveProposal for the linked-step unlock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter, type AssistantRouterDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildJob } from '../factories/job.factory';
import { approveProposal } from '../../src/proposals/actions';
import {
  invoiceReferenceCheck,
  invoiceSendableReferenceCheck,
} from '../../src/proposals/approval-reference-checks';
import { buildInvoice } from '../factories/invoice.factory';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type Classified = { intentType: string; entities?: Record<string, unknown> };

/**
 * Classifier calls are answered from `byText` (longest scripted text the
 * classified input contains); drafting calls from `drafts[<system prefix>]`.
 */
function scriptedGateway(byText: Record<string, Classified>, drafts: Record<string, string> = {}) {
  const complete = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let content = JSON.stringify({ intentType: 'unknown', confidence: 0.2, reasoning: 'unscripted' });
    const draftKey = Object.keys(drafts).find((prefix) => system.startsWith(prefix));
    if (draftKey) {
      content = drafts[draftKey];
    } else {
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
  });
  return { complete } as unknown as LLMGateway;
}

function buildApp(deps: Partial<AssistantRouterDeps> & { gateway: LLMGateway; proposalRepo: InMemoryProposalRepository }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1480',
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

const chainIndexOf = (p: Proposal) => (p.sourceContext as Record<string, number> | undefined)?.chainIndex ?? 0;
const byChainIndex = (proposals: Proposal[]) => [...proposals].sort((a, b) => chainIndexOf(a) - chainIndexOf(b));

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1480 item 4 — "X, and <verb> …" drafts every step as linked proposals', () => {
  // C23: no "then", so only the customer was drafted and the booking was
  // reported as "didn't draft".
  it('C23: add customer … and book her Thursday 9am → create_customer + linked create_appointment for that customer', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411, and book her for an AC check Thursday at 9am.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: { intentType: 'create_customer', entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' } },
        'Add customer Priya Nandakumar, phone 555-201-4411': {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
        'book her for an AC check Thursday at 9am': {
          intentType: 'create_appointment',
          entities: { customerName: 'her', dateTimeDescription: 'Thursday at 9am', jobTitle: 'AC check' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const persisted = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(persisted.map((p) => p.proposalType)).toEqual(['create_customer', 'create_appointment']);
    expect(persisted[0].chainId).toBeTruthy();
    expect(persisted[1].chainId).toBe(persisted[0].chainId);
    // The booking is for the customer step 1 creates — filled when it runs.
    expect(persisted[1].payload.customerId).toBe('$ref:chain[0].customerId');
    const content: string = res.body.message.content;
    expect(content).toMatch(/2 linked steps/i);
    expect(content).not.toMatch(/didn't draft/i);
  });
});

describe('#1480 item 4 — AST-04 "create an invoice for job X and send it"', () => {
  const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
  const CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const INVOICE_DRAFT = JSON.stringify({
    lineItems: [{ description: 'Blower motor replacement', quantity: 1, unitPrice: 42500 }],
    confidence_score: 0.9,
  });
  const turn = 'Create an invoice for job JOB-0081 and send it.';

  async function draftCreateAndSend() {
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TEST_TENANT, customerId: CUSTOMER_ID, jobNumber: 'JOB-0081' }));
    const app = buildApp({
      proposalRepo,
      jobRepo,
      invoiceRepo,
      gateway: scriptedGateway(
        {
          // The live C22/AST-04 turn classified as a send/issue of an invoice.
          [turn]: { intentType: 'issue_invoice', entities: { jobReference: 'JOB-0081' } },
          'Create an invoice for job JOB-0081': {
            intentType: 'create_invoice',
            entities: { jobReference: 'JOB-0081' },
          },
        },
        { 'You are an invoice generation assistant': INVOICE_DRAFT },
      ),
    });
    const res = await chat(app, turn);
    return { res, proposalRepo, invoiceRepo };
  }

  it('drafts the invoice on that job AND a linked send step for it, neither approved', async () => {
    const { res, proposalRepo } = await draftCreateAndSend();
    expect(res.status).toBe(200);
    const [invoice, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect([invoice?.proposalType, send?.proposalType]).toEqual(['draft_invoice', 'send_invoice']);
    expect(invoice.payload.jobId).toBe(JOB_ID);
    expect(send.chainId).toBe(invoice.chainId);
    expect(send.payload.invoiceId).toBe('$ref:chain[0].invoiceId');
    // Money / comms steps are never approved on the operator's behalf.
    expect(send.status).toBe('ready_for_review');
    expect(res.body.message.content).toMatch(/2 linked steps/i);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });

  it('the reply tells the operator what unlocks the send: approve the invoice, then issue it', async () => {
    const { res } = await draftCreateAndSend();
    expect(res.body.message.content).toMatch(/send unlocks once the invoice is approved and issued/i);
  });

  it('the send step cannot be approved while the invoice it sends does not exist yet', async () => {
    const { proposalRepo } = await draftCreateAndSend();
    const [, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    await expect(approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner')).rejects.toThrow(
      /approve step 1/i,
    );
    expect((await proposalRepo.findById(TEST_TENANT, send.id))?.status).toBe('ready_for_review');
  });

  /** Step 1 ran: its invoice exists (in `status`) and the proposal records it. */
  async function runInvoiceStep(
    proposalRepo: InMemoryProposalRepository,
    invoiceRepo: InMemoryInvoiceRepository,
    status: 'draft' | 'open',
  ) {
    const [invoiceStep, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    const invoice = await invoiceRepo.create(
      buildInvoice({ tenantId: TEST_TENANT, jobId: JOB_ID, estimateId: undefined, status }),
    );
    await proposalRepo.updateStatus(TEST_TENANT, invoiceStep.id, 'executed', { resultEntityId: invoice.id });
    return { send, invoice };
  }

  it('the send step unlocks once the invoice step has run and the invoice is issued', async () => {
    const { proposalRepo, invoiceRepo } = await draftCreateAndSend();
    const { send } = await runInvoiceStep(proposalRepo, invoiceRepo, 'open');
    const approved = await approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner', undefined, undefined, {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo), invoiceSendableReferenceCheck(invoiceRepo)],
    });
    expect(approved.status).toBe('approved');
  });

  // Sending a draft invoice fails at execution ("still a draft — issue it"),
  // so the tap is refused with that next step instead (D-023: issuing is its
  // own approval).
  it('an invoice that exists but is still a draft keeps the send locked, and says to issue it', async () => {
    const { proposalRepo, invoiceRepo } = await draftCreateAndSend();
    const { send } = await runInvoiceStep(proposalRepo, invoiceRepo, 'draft');
    await expect(
      approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner', undefined, undefined, {
        referenceChecks: [invoiceReferenceCheck(invoiceRepo), invoiceSendableReferenceCheck(invoiceRepo)],
      }),
    ).rejects.toThrow(/still a draft.*issue it/i);
  });
});

describe('#1480 item 4 — AST-07 customer → estimate → create-and-send invoice', () => {
  const LINES = JSON.stringify({
    lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 120000 }],
    confidence_score: 0.9,
  });
  const turn =
    'New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, then create and send the invoice.';

  function ast07App(proposalRepo: InMemoryProposalRepository) {
    const gateway = scriptedGateway(
      {
        [turn]: { intentType: 'create_customer', entities: { displayName: 'Jane Smith', phone: '555-0101' } },
        'New customer Jane Smith, phone 555-0101': {
          intentType: 'create_customer',
          entities: { displayName: 'Jane Smith', phone: '555-0101' },
        },
        'draft an estimate for her for a water heater install at $1200': {
          intentType: 'draft_estimate',
          entities: { customerName: 'her', lineItemDescriptions: ['water heater install'] },
        },
        'create the invoice.': { intentType: 'create_invoice', entities: {} },
      },
      {
        'You are an estimate generation assistant': LINES,
        'You are an invoice generation assistant': LINES,
      },
    );
    return { app: buildApp({ proposalRepo, gateway, invoiceRepo: new InMemoryInvoiceRepository() }), gateway };
  }

  it('drafts the customer, the estimate, the invoice and its send as ONE chain, each wired to the step it needs', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const { app } = ast07App(proposalRepo);

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const steps = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(steps.map((p) => p.proposalType)).toEqual([
      'create_customer',
      'draft_estimate',
      'draft_invoice',
      'send_invoice',
    ]);
    expect(new Set(steps.map((p) => p.chainId)).size).toBe(1);
    // "for her" / "the invoice" are the customer step 1 creates, the
    // estimate step 2 drafts, and the invoice step 3 drafts.
    expect(steps[1].payload.customerId).toBe('$ref:chain[0].customerId');
    expect(steps[2].payload.customerId).toBe('$ref:chain[0].customerId');
    expect(steps[2].payload.estimateId).toBe('$ref:chain[1].estimateId');
    expect(steps[3].payload.invoiceId).toBe('$ref:chain[2].invoiceId');
    expect(res.body.message.content).toMatch(/4 linked steps/i);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });
});
