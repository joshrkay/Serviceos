/**
 * #1528 — "nudge the estimate" goes out on a channel the customer actually
 * has, by the same rule as send_invoice / send_estimate (#1524): email when
 * one is on file, else a text to the phone (subject to SMS consent / DNC /
 * the per-recipient cap), refused for a recipient when neither is on file.
 * Before this the nudge executor always passed channel 'sms', so an
 * email-only customer's nudge was approvable and then failed after the tap.
 *
 * Seams: POST /api/assistant/chat (scripted gateway, in-memory repos) →
 * approveProposal with the recipient reference check app.ts wires → the
 * send_estimate_nudge executor delivering through SendService + in-memory
 * delivery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import {
  sendRecipientReferenceCheck,
  type ApprovalReferenceCheck,
} from '../../src/proposals/approval-reference-checks';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildCustomer } from '../factories/customer.factory';
import { buildJob } from '../factories/job.factory';
import { buildEstimate } from '../factories/estimate.factory';
import { SendEstimateNudgeExecutionHandler } from '../../src/proposals/execution/handlers';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111115281';
const USER = '22222222-2222-4222-8222-222222225281';
const CUSTOMER = '33333333-3333-4333-8333-333333335281';
const JOB = '44444444-4444-4444-8444-444444445281';
const ESTIMATE = '55555555-5555-4555-8555-555555555281';
const PHONE = '+16025550188';
const EMAIL = 'robin@example.com';

function gateway(entities: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(
      async (req: { taskType?: string }) =>
        ({
          content:
            req.taskType === 'classify_intent'
              ? JSON.stringify({
                  intentType: 'send_estimate_nudge',
                  confidence: 0.95,
                  reasoning: 't',
                  extractedEntities: entities,
                })
              : '{}',
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

const resolver = {
  resolve: vi.fn(async (input: { kind: string }) =>
    input.kind === 'estimate'
      ? { kind: 'resolved', candidate: { id: ESTIMATE, kind: 'estimate', label: 'EST-5281', score: 1 } }
      : input.kind === 'customer'
        ? { kind: 'resolved', candidate: { id: CUSTOMER, kind: 'customer', label: 'Robin Nudge', score: 0.99 } }
        : { kind: 'not_found' },
  ),
} as unknown as EntityResolver;

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
});

async function world(customer: { email?: string; primaryPhone?: string; smsConsent?: boolean }) {
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  await customerRepo.create(
    buildCustomer({ id: CUSTOMER, tenantId: TENANT, displayName: 'Robin Nudge', ...customer }),
  );
  await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
  await estimateRepo.create(
    buildEstimate({
      id: ESTIMATE,
      tenantId: TENANT,
      jobId: JOB,
      estimateNumber: 'EST-5281',
      status: 'sent',
      sentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    }),
  );
  return { proposalRepo, customerRepo, jobRepo, invoiceRepo, estimateRepo };
}

async function draftFromChat(
  w: Awaited<ReturnType<typeof world>>,
  checks: ApprovalReferenceCheck[],
  content = 'Nudge Robin Nudge about the estimate.',
  entities: Record<string, unknown> = { customerName: 'Robin Nudge' },
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
      gateway: gateway(entities),
      proposalRepo: w.proposalRepo,
      customerRepo: w.customerRepo,
      jobRepo: w.jobRepo,
      invoiceRepo: w.invoiceRepo,
      estimateRepo: w.estimateRepo,
      entityResolver: resolver,
      tenantTimezoneResolver: async () => 'America/Phoenix',
      approvalReferenceChecks: checks,
    }),
  );
  const res = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content }] });
  expect(res.status).toBe(200);
  const [persisted] = await w.proposalRepo.findByTenant(TENANT);
  expect(persisted.proposalType).toBe('send_estimate_nudge');
  expect(persisted.payload.estimateId).toBe(ESTIMATE);
  return { res, proposal: persisted };
}

/** The send_estimate_nudge executor wired the way app.ts wires it, over in-memory delivery. */
async function execute(w: Awaited<ReturnType<typeof world>>, proposal: Proposal) {
  const delivery = new InMemoryDeliveryProvider();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '66666666-6666-4666-8666-666666665281',
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Phoenix',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const dispatchRepo = new InMemoryDispatchRepository();
  const sendService = new SendService({
    delivery: new GatedMessageDelivery({
      base: delivery,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
    }),
    estimateRepo: w.estimateRepo,
    invoiceRepo: w.invoiceRepo,
    jobRepo: w.jobRepo,
    customerRepo: w.customerRepo,
    settingsRepo,
    dispatchRepo,
    publicBaseUrl: 'https://app.example.com',
  });
  const handler = new SendEstimateNudgeExecutionHandler(w.estimateRepo, sendService, dispatchRepo);
  const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });
  return { result, delivery };
}

describe('#1528 — nudge with no channel named, email-only customer', () => {
  it('approves and the executor emails the estimate link', async () => {
    const w = await world({ email: EMAIL, primaryPhone: undefined });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks);
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result, delivery } = await execute(w, approved);

    expect(result).toEqual({ success: true, resultEntityId: ESTIMATE });
    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails.map((m) => m.to)).toEqual([EMAIL]);
  });
});

describe('#1528 — nudge with a channel named', () => {
  it('"text them" goes out as a text even though an email is on file', async () => {
    const w = await world({ email: EMAIL, primaryPhone: PHONE, smsConsent: true });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks, 'Text Robin Nudge a reminder about the estimate.', {
      customerName: 'Robin Nudge',
      sendChannel: 'sms',
    });
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result, delivery } = await execute(w, approved);

    expect(result).toEqual({ success: true, resultEntityId: ESTIMATE });
    expect(delivery.sentEmails).toHaveLength(0);
    expect(delivery.sentSms.map((m) => m.to)).toEqual([PHONE]);
  });
});

describe('#1528 — nudge, phone-only, but the text would be blocked', () => {
  it('no SMS consent on file → refused at approval because they have not agreed to texts', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: false });
    const smsPreflight = new GatedMessageDelivery({
      base: new InMemoryDeliveryProvider(),
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
    });
    const checks = [sendRecipientReferenceCheck({ ...w, smsPreflight })];
    const { proposal } = await draftFromChat(w, checks);

    const refusal = approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });
    await expect(refusal).rejects.toMatchObject({ details: { missingFields: ['smsNoConsent'] } });
    await expect(refusal).rejects.toThrow(/hasn't agreed to receive texts/);
  });
});

describe('#1528 — nudge with no channel named, nothing on file', () => {
  it('asks for an email or a number, and approval is refused for a recipient', async () => {
    const w = await world({ email: undefined, primaryPhone: undefined });
    const checks = [sendRecipientReferenceCheck(w)];
    const { res, proposal } = await draftFromChat(w, checks);

    expect(res.body.message.content).toMatch(/no email or phone number on file/i);
    await expect(
      approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', { referenceChecks: checks }),
    ).rejects.toMatchObject({ details: { missingFields: ['recipient'] } });
  });
});
