/**
 * Screen context on the chat route: "this job" / "her" spoken on a detail
 * page resolve to that page's record (ai/resolution/page-context.ts), and a
 * named record that is not on screen still wins.
 *
 * Handler level with a scripted gateway and stub resolver/repos. The repos'
 * findById queries are existing, integration-covered reads; nothing new hits
 * SQL here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';
import type { CustomerRepository } from '../../src/customers/customer';
import type { JobRepository } from '../../src/jobs/job';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_CUSTOMER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const JOB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const APPOINTMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function scriptedGateway(intentType: string, extractedEntities: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function resolver(impl: (input: { reference: string; kind: string }) => EntityResolverResult): EntityResolver {
  return { resolve: vi.fn(async (input: { reference: string; kind: string }) => impl(input)) } as unknown as EntityResolver;
}
const notFound = (): EntityResolverResult => ({ kind: 'not_found' }) as EntityResolverResult;

const customerRepo = {
  findById: async (tenantId: string, id: string) =>
    tenantId === TENANT && id === CUSTOMER ? { id, displayName: 'Ana Garcia' } : null,
} as unknown as CustomerRepository;
const jobRepo = {
  findById: async (tenantId: string, id: string) =>
    tenantId === TENANT && id === JOB
      ? { id, customerId: CUSTOMER, summary: 'AC not cooling', jobNumber: 'JOB-0081' }
      : null,
} as unknown as JobRepository;
const appointmentRepo = {
  findById: async (tenantId: string, id: string) =>
    tenantId === TENANT && id === APPOINTMENT ? { id, jobId: JOB } : null,
  findByDateRange: async () => [],
  findByJob: async () => [],
} as unknown as AppointmentRepository;

function buildApp(gateway: LLMGateway, entityResolver: EntityResolver, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      tenantTimezoneResolver: async () => 'America/Phoenix',
      entityResolver,
      customerRepo,
      jobRepo,
      appointmentRepo,
    }),
  );
  return app;
}

function chat(app: express.Express, content: string, pageContext?: unknown) {
  return request(app)
    .post('/api/assistant/chat')
    .send({
      messages: [{ role: 'user', content }],
      conversationId: CONVERSATION,
      inputMode: 'voice',
      ...(pageContext ? { pageContext } : {}),
    });
}

beforeEach(() => setSupervisorPresenceLoader(async () => true));
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('chat: the open page answers "this one"', () => {
  it('fills the customer on a customer page, says so, and the card approves', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway('update_customer', { customerName: 'her', updatedPhone: '480-555-0188' }),
      resolver(notFound),
      proposalRepo,
    );
    const res = await chat(app, 'change her phone to 480-555-0188', { entityType: 'customer', entityId: CUSTOMER });
    expect(res.status).toBe(200);
    expect(res.body.message.content).toContain('I used the customer you had open: Ana Garcia.');

    const [draft] = await proposalRepo.findByTenant(TENANT);
    expect(draft.payload.customerId).toBe(CUSTOMER);
    expect(missingFieldsFor(draft)).not.toContain('customerId');
    expect(draft.sourceContext?.pageContext).toMatchObject({ entityType: 'customer', entityId: CUSTOMER });
    await expect(approveProposal(proposalRepo, TENANT, draft.id, USER, 'owner')).resolves.toBeTruthy();
  });

  it('fills the appointment on an appointment page', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway('confirm_appointment', { appointmentReference: 'this appointment' }),
      resolver(notFound),
      proposalRepo,
    );
    const res = await chat(app, 'confirm this appointment', { entityType: 'appointment', entityId: APPOINTMENT });
    expect(res.status).toBe(200);
    const [draft] = await proposalRepo.findByTenant(TENANT);
    expect(draft.payload.appointmentId).toBe(APPOINTMENT);
    expect(missingFieldsFor(draft)).not.toContain('appointmentId');
    expect(res.body.message.content).toContain('I used the appointment you had open: Ana Garcia – AC not cooling.');
  });

  it('lets a named customer who is not on screen win', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway('update_customer', { customerName: 'Priya Shah', updatedPhone: '480-555-0188' }),
      resolver(({ kind }) =>
        kind === 'customer'
          ? ({ kind: 'resolved', candidate: { id: OTHER_CUSTOMER, kind, label: 'Priya Shah', score: 0.95 } } as EntityResolverResult)
          : notFound(),
      ),
      proposalRepo,
    );
    const res = await chat(app, "update Priya Shah's phone to 480-555-0188", { entityType: 'customer', entityId: CUSTOMER });
    const [draft] = await proposalRepo.findByTenant(TENANT);
    expect(draft.payload.customerId).toBe(OTHER_CUSTOMER);
    expect(draft.sourceContext?.pageContext).toBeUndefined();
    expect(res.body.message.content).not.toContain('you had open');
  });

  it("ignores another tenant's id", async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway('update_customer', { customerName: 'her', updatedPhone: '480-555-0188' }),
      resolver(notFound),
      proposalRepo,
    );
    const res = await chat(app, 'change her phone to 480-555-0188', { entityType: 'customer', entityId: OTHER_CUSTOMER });
    expect(res.status).toBe(200);
    const [draft] = await proposalRepo.findByTenant(TENANT);
    expect(draft.payload.customerId).toBeUndefined();
    expect(res.body.message.content).not.toContain('you had open');
  });

  it('drops a malformed page context instead of refusing the turn', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      scriptedGateway('update_customer', { customerName: 'her', updatedPhone: '480-555-0188' }),
      resolver(notFound),
      proposalRepo,
    );
    const res = await chat(app, 'change her phone to 480-555-0188', { entityType: 'job', entityId: 'not-a-uuid' });
    expect(res.status).toBe(200);
    const [draft] = await proposalRepo.findByTenant(TENANT);
    expect(draft.payload.customerId).toBeUndefined();
  });
});
