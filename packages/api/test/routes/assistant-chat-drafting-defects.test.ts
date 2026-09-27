/**
 * QA 2026-09-16 (issues #1271, #1276) — chat drafting defects, pinned at the
 * public seam: POST /api/assistant/chat with a scripted gateway.
 *
 *   #1271  create_customer dropped the spoken address: the chat route rebuilt
 *          the handler's entities from name/email/phone only, so the address
 *          the classifier extracted never reached the payload, the card, or
 *          execution (every AI-created customer had zero service locations).
 *   #1276A "Add a new customer named Taylor." drafted at High confidence and
 *          executed with an empty last name — ask, don't guess (D-029).
 *   #1276C a numeric reply "1" to a customer disambiguation fell to general
 *          chat when the client did not echo `conversationId` (the web UI
 *          does; an API client that only replays `messages` did not).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../src/proposals/actions';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildEstimate } from '../factories/estimate.factory';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildJob } from '../factories/job.factory';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

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

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(
  gateway: LLMGateway,
  proposalRepo: InMemoryProposalRepository,
  entityResolver?: EntityResolver,
  extraDeps: Partial<Parameters<typeof createAssistantRouter>[0]> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      tenantTimezoneResolver: async () => 'America/Phoenix',
      ...(entityResolver ? { entityResolver } : {}),
      ...extraDeps,
    }),
  );
  return app;
}

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1271 — chat create_customer keeps the spoken address', () => {
  it('carries the classifier-extracted address onto the persisted payload and the card', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_customer', {
          displayName: 'Priya Whitfield',
          phone: '555-0100',
          address: '456 Oak Ave, Phoenix AZ 85002',
        }),
      ]),
      proposalRepo,
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: 'Create a new customer Priya Whitfield, phone 555-0100, address 456 Oak Ave, Phoenix AZ 85002',
          },
        ],
      });

    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('create_customer');
    expect(persisted.payload.address).toBe('456 Oak Ave, Phoenix AZ 85002');
    const card = res.body.message.proposal;
    expect(card.addressCapture?.address).toBe('456 Oak Ave, Phoenix AZ 85002');
  });
});

describe('#1276C — a numeric reply answers the customer question even when the client replays history without conversationId', () => {
  const MORGAN = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RILEY = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ambiguousCustomers = {
    resolve: vi.fn(async ({ kind }: { kind: string }) =>
      kind === 'customer'
        ? {
            kind: 'ambiguous',
            candidates: [
              { id: MORGAN, kind: 'customer', label: 'Morgan Ashworth', score: 0.9 },
              { id: RILEY, kind: 'customer', label: 'Riley Ashworth', score: 0.9 },
            ],
          }
        : { kind: 'skipped' },
    ),
  } as unknown as EntityResolver;

  it('"1" picks the first offered customer and lifts the gate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      // One classifier entry: the answer turn must not be re-classified.
      scriptedGateway([classifierReply('create_invoice', { customerName: 'Ashworth', amount: 40000 })]),
      proposalRepo,
      ambiguousCustomers,
    );
    const ask = 'Invoice Ashworth $400 for the repair';

    const first = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: ask }] });
    expect(first.body.message.content).toContain('1. Morgan Ashworth');

    const second = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: ask },
          { role: 'assistant', content: first.body.message.content },
          { role: 'user', content: '1' },
        ],
      });

    expect(second.body.taskType).toBe('assistant.entity_resolution');
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.payload.customerId).toBe(MORGAN);
    expect(missingFieldsFor(persisted)).not.toContain('customerId');
  });

  // #1276 leftover — a pick on the card (PUT /api/proposals/:id → editProposal)
  // answers the chat question too. The question used to stay stored on the
  // proposal, so a later "1" was still read as an answer to it: the reply
  // claimed "Morgan Ashworth — got it" over a card that says Riley.
  it('after the card pick fills customerId, a later "1" is no longer an answer to the question', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_invoice', { customerName: 'Ashworth', amount: 40000 }),
        JSON.stringify({ lineItems: [{ description: 'Repair', quantity: 1, unitPrice: 40000 }] }),
      ]),
      proposalRepo,
      ambiguousCustomers,
    );
    const ask = 'Invoice Ashworth $400 for the repair';
    const first = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: ask }] });
    const [drafted] = await proposalRepo.findByTenant(TENANT);

    await editProposal(proposalRepo, TENANT, drafted.id, USER, 'owner', { customerId: RILEY });

    const later = await request(app)
      .post('/api/assistant/chat')
      .send({
        conversationId: first.body.conversationId,
        messages: [
          { role: 'user', content: ask },
          { role: 'assistant', content: first.body.message.content },
          { role: 'user', content: '1' },
        ],
      });

    expect(later.body.taskType).not.toBe('assistant.entity_resolution');
    expect(later.body.message.content).not.toContain('Morgan Ashworth — got it');
    const picked = await proposalRepo.findById(TENANT, drafted.id);
    expect(picked!.payload.customerId).toBe(RILEY);
  });
});

describe('#1276A — a bare first name asks for the last name instead of guessing', () => {
  async function draftTaylor() {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([classifierReply('create_customer', { displayName: 'Taylor' })]),
      proposalRepo,
    );
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Add a new customer named Taylor.' }] });
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    return { res, proposalRepo, persisted };
  }

  it('drafts the customer gated on lastName, so approval is refused until it is filled', async () => {
    const { res, proposalRepo, persisted } = await draftTaylor();
    expect(res.status).toBe(200);
    expect(missingFieldsFor(persisted)).toContain('lastName');
    await expect(
      approveProposal(proposalRepo, TENANT, persisted.id, USER, 'owner'),
    ).rejects.toThrow(/lastName/);
  });

  it('asks for the last name in the reply and offers a Last name field on the card', async () => {
    const { res } = await draftTaylor();
    expect(res.body.message.content).toMatch(/Taylor's last name/);
    const card = res.body.message.proposal;
    expect(card.editFields).toEqual(
      expect.arrayContaining([{ label: 'Last name', key: 'lastName', value: '' }]),
    );
    expect(card.confidence).not.toBe('High');
  });

  it('filling the last name on the card lifts the gate and the draft approves', async () => {
    const { proposalRepo, persisted } = await draftTaylor();
    await editProposal(proposalRepo, TENANT, persisted.id, USER, 'owner', { lastName: 'Brooks' });
    await expect(
      approveProposal(proposalRepo, TENANT, persisted.id, USER, 'owner'),
    ).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('#1276F — chat "invoice from the accepted estimate" bills the estimate', () => {
  it('drafts the accepted estimate\'s $1,170 of lines, not the model\'s $10 placeholder', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const lineItems = [
      buildLineItem('li-1', 'Water heater install', 1, 100000, 0, true),
      buildLineItem('li-2', 'Haul-away and permit', 1, 17000, 1, false),
    ];
    await estimateRepo.create(buildEstimate({
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      tenantId: TENANT,
      jobId: '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f',
      estimateNumber: 'EST-0001',
      status: 'accepted',
      lineItems,
      totals: calculateDocumentTotals(lineItems, 0, 0),
      createdBy: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway([
        classifierReply('create_invoice', {}),
        JSON.stringify({
          lineItems: [{ description: 'Service as per accepted estimate', quantity: 1, unitPrice: 1000 }],
          confidence_score: 0.9,
        }),
      ]),
      proposalRepo,
      undefined,
      { estimateRepo },
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Create an invoice from the accepted estimate' }] });

    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    const lines = persisted.payload.lineItems as Array<{ description: string; unitPriceCents: number }>;
    expect(lines.map((l) => [l.description, l.unitPriceCents])).toEqual([
      ['Water heater install', 100000],
      ['Haul-away and permit', 17000],
    ]);
  });
});

describe('#1276B — a literal job UUID in a draft request names that job\'s customer', () => {
  const JOB = '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f';
  const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  /** Classifier and drafting model answered by task, not by call order. */
  function gatewayByTask(replies: Record<string, string>): LLMGateway {
    return {
      complete: vi.fn(
        async (req: { taskType?: string }) =>
          ({
            content: replies[req.taskType ?? ''] ?? '{}',
            model: 'mock',
            provider: 'mock',
            tokenUsage: { input: 1, output: 1, total: 2 },
            latencyMs: 1,
          }) satisfies LLMResponse,
      ),
    } as unknown as LLMGateway;
  }

  /** No customer or job is named "job 9b2c…" — free text finds nothing. */
  const nothingByName = {
    resolve: vi.fn(async () => ({ kind: 'not_found' })),
  } as unknown as EntityResolver;

  async function jobRepoWithTheJob() {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
    return jobRepo;
  }

  it('"Draft an estimate for job <uuid>: …" drafts for the job\'s customer, ungated', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({
        classify_intent: classifierReply('draft_estimate', { customerName: `job ${JOB}` }),
        draft_estimate: JSON.stringify({
          lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 100000 }],
        }),
      }),
      proposalRepo,
      nothingByName,
      { jobRepo: await jobRepoWithTheJob() },
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: `Draft an estimate for job ${JOB}: water heater install $1,000` }] });

    expect(res.status).toBe(200);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('draft_estimate');
    expect(persisted.payload.customerId).toBe(CUSTOMER);
    expect(persisted.payload.jobId).toBe(JOB);
    expect(missingFieldsFor(persisted)).not.toContain('customerId');
  });

  it('"Create an invoice for job <uuid> …" drafts the invoice for the job\'s customer', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({
        classify_intent: classifierReply('create_invoice', { jobReference: JOB, amount: 25000 }),
        draft_invoice: JSON.stringify({
          lineItems: [{ description: 'Service call', quantity: 1, unitPrice: 25000 }],
        }),
      }),
      proposalRepo,
      nothingByName,
      { jobRepo: await jobRepoWithTheJob() },
    );

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: `Create an invoice for job ${JOB} totaling $250` }] });

    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('draft_invoice');
    expect(persisted.payload.customerId).toBe(CUSTOMER);
    expect(persisted.payload.jobId).toBe(JOB);
  });

  it('a UUID that is no job of this tenant names no one', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const OTHER = '3f1e2d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
    const app = buildApp(
      gatewayByTask({
        classify_intent: classifierReply('draft_estimate', { customerName: `job ${OTHER}` }),
        draft_estimate: JSON.stringify({
          lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 100000 }],
        }),
      }),
      proposalRepo,
      nothingByName,
      { jobRepo: await jobRepoWithTheJob() },
    );

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: `Draft an estimate for job ${OTHER}: water heater install $1,000` }] });

    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.payload.customerId).toBeUndefined();
    expect(missingFieldsFor(persisted)).toContain('customerId');
  });
});
