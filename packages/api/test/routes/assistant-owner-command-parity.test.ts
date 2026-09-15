/**
 * U5 — owner-command parity between the chat route and the voice session.
 *
 * `matchOwnerOperatorCommand` (ai/orchestration/intent-classifier.ts) is the
 * deterministic short-circuit for the stereotyped owner commands. It is gated
 * on `ClassifyContext.ownerSession === true`, the in-app voice adapter sets
 * that from the session role (`ownerSession = role === 'owner'`), and the chat
 * route never set it at all. So the SAME sentence, from the SAME owner, took a
 * model round trip when typed on the dashboard and a deterministic one when
 * spoken into the mic panel — two classifiers for one operator, and the typed
 * half fails closed whenever the provider is degraded, which is the entire
 * reason those patterns exist.
 *
 * The security half is asserted too, and it is the reason this is keyed on the
 * DB-authoritative `callerRole` rather than on the route's `extendedIntents`
 * flag: that flag is unconditionally true for every caller here, so keying on
 * it would have handed owner commands to technicians.
 */
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const TENANT = 'tenant-owner-parity';
const USER = 'user-owner-parity';
const TIMEZONE = 'America/Phoenix';

let proposalRepo: InMemoryProposalRepository;

beforeEach(() => {
  proposalRepo = new InMemoryProposalRepository();
});

/**
 * A gateway that answers every classify call with `unknown`, so ANY reply that
 * carries a real intent proves the deterministic matcher produced it. The
 * drafting stand-in echoes nothing — the deterministic path's own
 * `extractedEntities` are the only raw material under test.
 */
function unknownGateway() {
  const complete = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    const content =
      req.taskType === 'classify_intent'
        ? JSON.stringify({
            intentType: 'unknown',
            confidence: 0.2,
            reasoning: 'model did not recognize this',
            extractedEntities: {},
          })
        : JSON.stringify({ content: 'Tell me more.', reasoning: 'generic' });
    return {
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    };
  });
  return { gateway: { complete } as unknown as LLMGateway, complete };
}

function buildApp(role: 'owner' | 'technician', gateway: LLMGateway) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'sess-owner-parity',
      tenantId: TENANT,
      role,
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      appointmentRepo: new InMemoryAppointmentRepository(),
      jobRepo: new InMemoryJobRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      conversationRepo: new InMemoryConversationRepository(),
      auditRepo: new InMemoryAuditRepository(),
      tenantTimezoneResolver: async () => TIMEZONE,
    }),
  );
  return app;
}

function chat(app: express.Express, text: string, conversationId: string) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content: text }], conversationId, inputMode: 'text' });
}

describe('owner-command parity on POST /api/assistant/chat', () => {
  it('an owner typing a canonical create_customer command drafts the card without a model classification', async () => {
    const { gateway, complete } = unknownGateway();
    const app = buildApp('owner', gateway);

    const res = await chat(app, 'New customer Elena Ruiz, phone 480-555-7711', 'conv-owner-1');

    expect(res.status).toBe(200);
    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].proposalType).toBe('create_customer');
    expect(rows[0].payload.name).toBe('Elena Ruiz');
    expect(rows[0].payload.phone).toBe('480-555-7711');
    // The classifier never ran — that is the whole point of the short-circuit.
    expect(
      complete.mock.calls.filter((c) => c[0].taskType === 'classify_intent'),
    ).toHaveLength(0);
  });

  it('the SAME sentence from a technician still goes to the model — the short-circuit is owner-only', async () => {
    const { gateway, complete } = unknownGateway();
    const app = buildApp('technician', gateway);

    await chat(app, 'New customer Elena Ruiz, phone 480-555-7711', 'conv-tech-1');

    expect(
      complete.mock.calls.filter((c) => c[0].taskType === 'classify_intent'),
    ).toHaveLength(1);
    // The stubbed model said `unknown`, so no card — proving the technician's
    // turn genuinely took the model path rather than the deterministic one.
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('an owner turn that matches no pattern is classified exactly once', async () => {
    const { gateway, complete } = unknownGateway();
    const app = buildApp('owner', gateway);

    await chat(app, 'can you tell me something about the weather', 'conv-owner-2');

    expect(
      complete.mock.calls.filter((c) => c[0].taskType === 'classify_intent'),
    ).toHaveLength(1);
  });

  it('"Text <customer> the invoice link" keeps the SMS channel the operator named', async () => {
    const { gateway } = unknownGateway();
    const app = buildApp('owner', gateway);

    await chat(app, 'Text Smith the invoice link', 'conv-owner-3');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].proposalType).toBe('send_invoice');
    // `SendInvoiceTaskHandler` reads `ee.sendChannel ?? 'email'`, so a pattern
    // that dropped the channel would silently EMAIL an invoice the operator
    // asked to text. The gate on the unresolved document is untouched.
    expect(rows[0].payload.channel).toBe('sms');
    expect(missingFieldsFor(rows[0])).toContain('invoiceId');
  });

  it('"Convert the <lead> lead into a customer" and "Open a job for X, Y" route deterministically too', async () => {
    const { gateway } = unknownGateway();
    const app = buildApp('owner', gateway);

    await chat(app, 'Convert the Greenfield lead into a customer', 'conv-owner-4');
    await chat(app, 'Open a job for Khan, kitchen drain clog', 'conv-owner-5');

    const rows = await proposalRepo.findByTenant(TENANT);
    expect(rows.map((r) => r.proposalType).sort()).toEqual(['convert_lead', 'create_job']);
    const job = rows.find((r) => r.proposalType === 'create_job')!;
    expect(job.payload.title).toBe('kitchen drain clog');
  });
});
