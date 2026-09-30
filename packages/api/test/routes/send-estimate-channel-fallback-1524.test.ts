/**
 * #1524 (extended to send_estimate) — "send the estimate" with no channel
 * named goes out on a channel the customer actually has: email when one is
 * on file, else a text to the phone (subject to SMS consent / DNC / the
 * per-recipient cap). Before this the drafter wrote `channel: 'email'`, so a
 * phone-only customer's estimate was approvable and then failed after the
 * tap ("no email on file").
 *
 * Seams: POST /api/assistant/chat (scripted gateway, in-memory repos) →
 * approveProposal with the recipient reference check app.ts wires → the
 * send_estimate executor delivering through SendService + in-memory delivery.
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
import { SendEstimateExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import { SendServiceEstimateDeliveryProvider } from '../../src/notifications/estimate-delivery-adapter';
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

const TENANT = '11111111-1111-4111-8111-111111115241';
const USER = '22222222-2222-4222-8222-222222225241';
const CUSTOMER = '33333333-3333-4333-8333-333333335241';
const JOB = '44444444-4444-4444-8444-444444445241';
const ESTIMATE = '55555555-5555-4555-8555-555555555241';
const PHONE = '+16025550187';

function gateway(entities: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(
      async (req: { taskType?: string }) =>
        ({
          content:
            req.taskType === 'classify_intent'
              ? JSON.stringify({ intentType: 'send_estimate', confidence: 0.95, reasoning: 't', extractedEntities: entities })
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
      ? { kind: 'resolved', candidate: { id: ESTIMATE, kind: 'estimate', label: 'EST-5241', score: 1 } }
      : input.kind === 'customer'
        ? { kind: 'resolved', candidate: { id: CUSTOMER, kind: 'customer', label: 'Casey Phoneonly', score: 0.99 } }
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
    buildCustomer({ id: CUSTOMER, tenantId: TENANT, displayName: 'Casey Phoneonly', ...customer }),
  );
  await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
  await estimateRepo.create(buildEstimate({ id: ESTIMATE, tenantId: TENANT, jobId: JOB, estimateNumber: 'EST-5241' }));
  return { proposalRepo, customerRepo, jobRepo, invoiceRepo, estimateRepo };
}

async function draftFromChat(w: Awaited<ReturnType<typeof world>>, checks: ApprovalReferenceCheck[]) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: gateway({ customerName: 'Casey Phoneonly' }),
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
  const res = await request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content: 'Send the estimate to Casey Phoneonly.' }] });
  expect(res.status).toBe(200);
  const [persisted] = await w.proposalRepo.findByTenant(TENANT);
  expect(persisted.proposalType).toBe('send_estimate');
  expect(persisted.payload.estimateId).toBe(ESTIMATE);
  return { res, proposal: persisted };
}

/** The send_estimate executor wired the way app.ts wires it, over in-memory delivery. */
async function execute(w: Awaited<ReturnType<typeof world>>, proposal: Proposal) {
  const delivery = new InMemoryDeliveryProvider();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '66666666-6666-4666-8666-666666665241',
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
    dispatchRepo: new InMemoryDispatchRepository(),
    publicBaseUrl: 'https://app.example.com',
  });
  const handler = new SendEstimateExecutionHandler(new SendServiceEstimateDeliveryProvider(sendService));
  const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });
  return { result, delivery };
}

describe('#1524 — send_estimate with no channel named, phone-only customer', () => {
  it('approves and the executor texts the estimate to the phone on file', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: true });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks);
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result, delivery } = await execute(w, approved);

    expect(result).toMatchObject({ success: true });
    expect(delivery.sentEmails).toHaveLength(0);
    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe(PHONE);
    expect(delivery.sentSms[0].body).toContain('EST-5241');
  });
});

describe('#1524 — send_estimate with no channel named, email on file', () => {
  it('approves and the executor emails it (email wins over the phone)', async () => {
    const w = await world({ email: 'casey@example.com', primaryPhone: PHONE, smsConsent: true });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks);
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result, delivery } = await execute(w, approved);

    expect(result).toMatchObject({ success: true });
    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails.map((m) => m.to)).toEqual(['casey@example.com']);
  });
});

describe('#1524 — send_estimate, phone-only, but the text would be blocked', () => {
  it('no SMS consent on file → refused because they have not agreed to texts', async () => {
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

describe('#1524 — send_estimate with no channel named, nothing on file', () => {
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
