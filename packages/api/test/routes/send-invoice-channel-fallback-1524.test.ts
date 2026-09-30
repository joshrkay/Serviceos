/**
 * #1524 — "send the invoice" with no channel named picks a channel the
 * customer actually has: email when one is on file, else a text to the phone
 * (subject to SMS consent / DNC / the per-recipient cap). Before this, the
 * drafter silently wrote `channel: 'email'`, so a phone-only customer's send
 * was refused "the customer has nothing on file to send it to" although a
 * phone was on file.
 *
 * Seams: POST /api/assistant/chat (scripted gateway, in-memory repos) →
 * approveProposal with the recipient reference check app.ts wires → the
 * send_invoice executor delivering through SendService + in-memory delivery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import {
  sendRecipientReferenceCheck,
  type ApprovalReferenceCheck,
} from '../../src/proposals/approval-reference-checks';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildCustomer } from '../factories/customer.factory';
import { buildInvoice } from '../factories/invoice.factory';
import { buildJob } from '../factories/job.factory';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import { SendInvoiceExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import { SendServiceInvoiceDeliveryProvider } from '../../src/notifications/invoice-delivery-adapter';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemoryRecipientSmsVolumeLedger } from '../../src/notifications/recipient-sms-volume';
import type { Proposal } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111524';
const USER = '22222222-2222-4222-8222-222222221524';
const CUSTOMER = '33333333-3333-4333-8333-333333331524';
const JOB = '44444444-4444-4444-8444-444444441524';
const INVOICE = '55555555-5555-4555-8555-555555551524';
const PHONE = '+16025550142';

function gateway(entities: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(
      async (req: { taskType?: string }) =>
        ({
          content:
            req.taskType === 'classify_intent'
              ? JSON.stringify({ intentType: 'send_invoice', confidence: 0.95, reasoning: 't', extractedEntities: entities })
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
    input.kind === 'invoice'
      ? { kind: 'resolved', candidate: { id: INVOICE, kind: 'invoice', label: 'INV-1524', score: 1 } }
      : input.kind === 'customer'
        ? { kind: 'resolved', candidate: { id: CUSTOMER, kind: 'customer', label: 'Riley Phoneonly', score: 0.99 } }
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
  await customerRepo.create(
    buildCustomer({ id: CUSTOMER, tenantId: TENANT, displayName: 'Riley Phoneonly', ...customer }),
  );
  await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
  await invoiceRepo.create(
    buildInvoice({ id: INVOICE, tenantId: TENANT, jobId: JOB, invoiceNumber: 'INV-1524', status: 'open' }),
  );
  return { proposalRepo, customerRepo, jobRepo, invoiceRepo };
}

async function draftFromChat(
  w: Awaited<ReturnType<typeof world>>,
  checks: ApprovalReferenceCheck[],
  utterance = 'Send the invoice to Riley Phoneonly.',
  entities: Record<string, unknown> = { customerName: 'Riley Phoneonly' },
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
      entityResolver: resolver,
      tenantTimezoneResolver: async () => 'America/Phoenix',
      approvalReferenceChecks: checks,
    }),
  );
  const res = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: utterance }] });
  expect(res.status).toBe(200);
  const [persisted] = await w.proposalRepo.findByTenant(TENANT);
  expect(persisted.proposalType).toBe('send_invoice');
  expect(persisted.payload.invoiceId).toBe(INVOICE);
  return { res, proposal: persisted };
}

/** The send_invoice executor wired the way app.ts wires it, over in-memory delivery. */
async function execute(
  w: Awaited<ReturnType<typeof world>>,
  proposal: Proposal,
  wired?: { delivery: InMemoryDeliveryProvider; gate: GatedMessageDelivery },
) {
  const delivery = wired?.delivery ?? new InMemoryDeliveryProvider();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '66666666-6666-4666-8666-666666661524',
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
    delivery:
      wired?.gate ??
      new GatedMessageDelivery({
        base: delivery,
        dnc: new InMemoryDncRepository(),
        auditRepo: new InMemoryAuditRepository(),
        enforcement: 'block',
      }),
    estimateRepo: undefined as never,
    invoiceRepo: w.invoiceRepo,
    jobRepo: w.jobRepo,
    customerRepo: w.customerRepo,
    settingsRepo,
    dispatchRepo: new InMemoryDispatchRepository(),
    publicBaseUrl: 'https://app.example.com',
  });
  const handler = new SendInvoiceExecutionHandler(new SendServiceInvoiceDeliveryProvider(sendService));
  const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });
  return { result, delivery };
}

describe('#1524 — send_invoice with no channel named, phone-only customer', () => {
  it('approval goes ahead (a phone is on file)', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: true });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks);

    await expect(
      approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', { referenceChecks: checks }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('the executor texts the invoice to the phone on file', async () => {
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
    expect(delivery.sentSms[0].body).toContain('INV-1524');
  });
});

describe('#1524 — send_invoice with no channel named, email on file', () => {
  it('approves and the executor emails it (email wins over the phone)', async () => {
    const w = await world({ email: 'riley@example.com', primaryPhone: PHONE, smsConsent: true });
    const checks = [sendRecipientReferenceCheck(w)];
    const { proposal } = await draftFromChat(w, checks);
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result, delivery } = await execute(w, approved);

    expect(result).toMatchObject({ success: true });
    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].to).toBe('riley@example.com');
  });
});

describe('#1524 — send_invoice with no channel named, nothing on file', () => {
  it('asks for an email or a number, and approval stays refused for a recipient', async () => {
    const w = await world({ email: undefined, primaryPhone: undefined });
    const checks = [sendRecipientReferenceCheck(w)];
    const { res, proposal } = await draftFromChat(w, checks);

    expect(res.body.message.content).toMatch(/no email or phone number on file/i);
    await expect(
      approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', { referenceChecks: checks }),
    ).rejects.toMatchObject({ details: { missingFields: ['recipient'] } });
  });
});

/**
 * The only channel is SMS and the send gate would stop it: approval refuses
 * with WHY, instead of "nothing on file" (a phone IS on file) — and instead of
 * approving a send the gate then suppresses after the tap.
 */
describe('#1524 — phone-only, but the text would be blocked', () => {
  function gate(opts: { dnc?: InMemoryDncRepository } = {}) {
    return new GatedMessageDelivery({
      base: new InMemoryDeliveryProvider(),
      dnc: opts.dnc ?? new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
    });
  }

  it('no SMS consent on file → refused because they have not agreed to texts', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: false });
    const checks = [sendRecipientReferenceCheck({ ...w, smsPreflight: gate() })];
    const { proposal } = await draftFromChat(w, checks);

    const refusal = approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });
    await expect(refusal).rejects.toMatchObject({ details: { missingFields: ['smsNoConsent'] } });
    await expect(refusal).rejects.toThrow(/hasn't agreed to receive texts/);
    await expect(refusal).rejects.not.toThrow(/nothing on file/);
  });

  it('phone on the do-not-contact list → refused because of the DNC list', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: true });
    const dnc = new InMemoryDncRepository();
    await dnc.addToDnc(TENANT, normalizePhone(PHONE), 'test');
    const checks = [sendRecipientReferenceCheck({ ...w, smsPreflight: gate({ dnc }) })];
    const { proposal } = await draftFromChat(w, checks);

    const refusal = approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });
    await expect(refusal).rejects.toMatchObject({ details: { missingFields: ['smsDoNotContact'] } });
    await expect(refusal).rejects.toThrow(/do-not-contact list/);
  });

  it('phone already at the per-recipient text cap → refused because of the cap', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: true });
    const capped = new GatedMessageDelivery({
      base: new InMemoryDeliveryProvider(),
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      recipientVolumeCap: { ledger: new InMemoryRecipientSmsVolumeLedger(), maxPerWindow: 1, windowHours: 24 },
    });
    await capped.sendSms({
      to: PHONE,
      body: 'Your appointment is confirmed',
      tenantId: TENANT,
      recipientClass: 'customer',
      consent: { smsConsent: true },
    });
    const checks = [sendRecipientReferenceCheck({ ...w, smsPreflight: capped })];
    const { proposal } = await draftFromChat(w, checks);

    const refusal = approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });
    await expect(refusal).rejects.toMatchObject({ details: { missingFields: ['smsRecipientCap'] } });
    await expect(refusal).rejects.toThrow(/most texts allowed/);
  });

  it('asking the cap at approval spends no slot — the last allowed text still goes out', async () => {
    const w = await world({ email: undefined, primaryPhone: PHONE, smsConsent: true });
    const delivery = new InMemoryDeliveryProvider();
    const capped = new GatedMessageDelivery({
      base: delivery,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      recipientVolumeCap: { ledger: new InMemoryRecipientSmsVolumeLedger(), maxPerWindow: 1, windowHours: 24 },
    });
    const checks = [sendRecipientReferenceCheck({ ...w, smsPreflight: capped })];
    const { proposal } = await draftFromChat(w, checks);
    const approved = await approveProposal(w.proposalRepo, TENANT, proposal.id, USER, 'owner', undefined, 'ui', {
      referenceChecks: checks,
    });

    const { result } = await execute(w, approved, { delivery, gate: capped });

    expect(result).toMatchObject({ success: true });
    expect(delivery.sentSms.map((m) => m.to)).toEqual([PHONE]);
  });
});
