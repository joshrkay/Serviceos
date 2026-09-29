/**
 * #1480 — a chat-drafted proposal that cannot execute is never approvable,
 * whether it would have been approved automatically or by a tap, and the
 * assistant asks for the missing piece instead of announcing it.
 *
 * QA re-sweep 2026-09-28 (§17): "Draft an estimate for <customer with no
 * service location>: 1 Diagnostic Visit" was "Approved automatically", then
 * failed execution ("Customer has no service location — add one before
 * approving this estimate") — the approval-time reference checks ran only on
 * a human tap.
 *
 * Seam: POST /api/assistant/chat with a scripted gateway, in-memory repos,
 * and the same `approvalReferenceChecks` app.ts wires for manual approval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import {
  serviceLocationReferenceCheck,
  sendRecipientReferenceCheck,
} from '../../src/proposals/approval-reference-checks';
import { approveProposal as approve, editProposal } from '../../src/proposals/actions';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildCustomer } from '../factories/customer.factory';
import { buildInvoice } from '../factories/invoice.factory';
import { buildJob } from '../factories/job.factory';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../src/catalog/catalog-item';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111480';
const USER = '22222222-2222-4222-8222-222222221480';
const NOLO = '33333333-3333-4333-8333-333333331480';

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

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

const resolvesNolo = {
  resolve: vi.fn(async (input: { kind: string }) =>
    input.kind === 'customer'
      ? { kind: 'resolved', candidate: { id: NOLO, kind: 'customer', label: 'Nolo Cation', score: 0.99 } }
      : { kind: 'not_found' },
  ),
} as unknown as EntityResolver;

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1480 — chat drafts that cannot execute are held and the assistant asks', () => {
  let proposalRepo: InMemoryProposalRepository;
  let locationRepo: InMemoryLocationRepository;
  let catalogRepo: InMemoryCatalogItemRepository;

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    locationRepo = new InMemoryLocationRepository();
    catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: 'Diagnostic Visit',
        category: 'labor',
        unit: 'each',
        unitPriceCents: 8900,
      }),
    );
  });

  function buildApp(gateway: LLMGateway) {
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
        catalogRepo,
        locationRepo,
        entityResolver: resolvesNolo,
        tenantTimezoneResolver: async () => 'America/Phoenix',
        approvalReferenceChecks: [serviceLocationReferenceCheck(locationRepo)],
      }),
    );
    return app;
  }

  it('an estimate for a customer with no service location is not auto-approved — the reply asks for the location', async () => {
    const app = buildApp(
      gatewayByTask({
        classify_intent: classifierReply('draft_estimate', {
          customerName: 'Nolo Cation',
          lineItemDescriptions: ['Diagnostic Visit'],
        }),
        // A confident, fully-populated draft — what the live row returned
        // ("confidence": "High") — so the status decision reaches auto-approve.
        draft_estimate: JSON.stringify({
          lineItems: [{ description: 'Diagnostic Visit', quantity: 1, unitPrice: 8900 }],
          notes: 'Diagnostic visit',
          validUntil: '2026-10-28',
          explanation: 'One catalog diagnostic visit.',
          confidence_score: 0.95,
        }),
      }),
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Draft an estimate for Nolo Cation: 1 Diagnostic Visit' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.proposal.status).toBe('Pending');
    expect(res.body.message.content).not.toMatch(/approved automatically/i);
    expect(res.body.message.content).toMatch(/service location/i);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.status).not.toBe('approved');
    await expect(
      approveProposal(proposalRepo, TENANT, persisted.id, USER, 'owner', undefined, 'ui', {
        referenceChecks: [serviceLocationReferenceCheck(locationRepo)],
      }),
    ).rejects.toMatchObject({ details: { missingFields: ['locationId'] } });
  });
});

describe('#1480 item 2 — send_invoice by email to a customer with no email on file', () => {
  const LENA = '44444444-4444-4444-8444-444444441480';
  const JOB = '55555555-5555-4555-8555-555555551480';
  const INVOICE = '66666666-6666-4666-8666-666666661480';

  it('the reply asks for the email, approval refuses, and supplying a recipient lifts it', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await customerRepo.create(
      buildCustomer({ id: LENA, tenantId: TENANT, displayName: 'Lena Ortiz', email: undefined }),
    );
    await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: LENA }));
    await invoiceRepo.create(buildInvoice({ id: INVOICE, tenantId: TENANT, jobId: JOB, invoiceNumber: 'INV-1001' }));
    const checks = [sendRecipientReferenceCheck({ invoiceRepo, jobRepo, customerRepo })];

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway: gatewayByTask({
          classify_intent: classifierReply('send_invoice', { customerName: 'Lena Ortiz', sendChannel: 'email' }),
        }),
        proposalRepo,
        customerRepo,
        jobRepo,
        invoiceRepo,
        entityResolver: {
          resolve: vi.fn(async (input: { kind: string }) =>
            input.kind === 'invoice'
              ? { kind: 'resolved', candidate: { id: INVOICE, kind: 'invoice', label: 'INV-1001', score: 1 } }
              : input.kind === 'customer'
                ? { kind: 'resolved', candidate: { id: LENA, kind: 'customer', label: 'Lena Ortiz', score: 0.99 } }
                : { kind: 'not_found' },
          ),
        } as unknown as EntityResolver,
        tenantTimezoneResolver: async () => 'America/Phoenix',
        approvalReferenceChecks: checks,
      }),
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Send the invoice to Lena Ortiz by email.' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toMatch(/no email on file/i);
    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('send_invoice');
    expect(persisted.payload.invoiceId).toBe(INVOICE);
    await expect(
      approve(proposalRepo, TENANT, persisted.id, USER, 'owner', undefined, 'ui', { referenceChecks: checks }),
    ).rejects.toMatchObject({ details: { missingFields: ['recipient'] } });

    await editProposal(proposalRepo, TENANT, persisted.id, USER, 'owner', { recipient: 'lena@example.com' });
    await expect(
      approve(proposalRepo, TENANT, persisted.id, USER, 'owner', undefined, 'ui', { referenceChecks: checks }),
    ).resolves.toMatchObject({ status: 'approved' });
  });
});

