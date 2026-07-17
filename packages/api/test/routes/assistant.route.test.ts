/**
 * AST-01b — /api/assistant/chat must produce a create_customer proposal
 * when the operator types a create-customer phrasing in the chat. The
 * UI relies on the `message.proposal` field on the response; if the
 * route ever stops returning that shape, the chat will silently
 * degrade to a plain LLM reply with no card, which is the bug AST-01b
 * is closing.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAssistantRouter, proposalSignals, VOICE_APPROVAL_REFUSAL } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import type { CatalogItem, CatalogItemRepository } from '../../src/catalog/catalog-item';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = 'tenant-ast-01b';
const TEST_USER = 'user-ast-01b';

function buildApp(
  gateway: LLMGateway,
  proposalRepo: InMemoryProposalRepository,
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      ...(verticalPromptResolver ? { verticalPromptResolver } : {}),
    }),
  );
  return app;
}

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('POST /api/assistant/chat — create_customer path', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  it('returns a Customer proposal when the user asks to create a customer', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.93,
        extractedEntities: {
          displayName: 'Alex',
          email: 'alex@example.com',
          phone: '555-0100',
        },
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: 'Create a new customer named Alex, email alex@example.com, phone 555-0100' }],
      });

    expect(res.status).toBe(200);
    const proposal = res.body?.message?.proposal;
    expect(proposal).toBeTruthy();
    expect(proposal.type).toBe('Customer');
    expect(proposal.status).toBe('Pending');
    expect(proposal.title).toBe('New customer: Alex');
    expect(proposal.editFields).toEqual(
      expect.arrayContaining([
        { label: 'Name', key: 'name', value: 'Alex' },
        { label: 'Email', key: 'email', value: 'alex@example.com' },
        { label: 'Phone', key: 'phone', value: '555-0100' },
      ])
    );

    // Proposal is also persisted server-side for later review/approval.
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('create_customer');
    // QA-2026-06-05: complete assistant proposals are promoted to
    // ready_for_review on persist — drafts are invisible to the inbox and
    // refused by the approval guard (the old 'draft' expectation encoded the
    // dead-end behavior the live matrix caught).
    expect(persisted[0].status).toBe('ready_for_review');
    expect(persisted[0].id).toBe(proposal.id);
  });

  it('still returns a proposal when only the name is given (clarification, not drop)', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.88,
        extractedEntities: { displayName: 'Sarah' },
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Create a new customer named Sarah' }] });

    expect(res.status).toBe(200);
    const proposal = res.body?.message?.proposal;
    expect(proposal?.type).toBe('Customer');
    expect(proposal?.title).toBe('New customer: Sarah');
    // Missing email/phone surface as empty edit fields — the operator
    // fills them in via the inline edit UI before approving.
    const byKey = Object.fromEntries(
      (proposal.editFields ?? []).map((f: { key: string; value: string }) => [f.key, f.value])
    );
    expect(byKey.email).toBe('');
    expect(byKey.phone).toBe('');
  });

  it('asks for the name (no proposal) when create_customer is classified without one', async () => {
    // The "Add a new customer" suggestion chip sends bare text that classifies
    // as create_customer with NO extracted name. Drafting an empty-payload
    // proposal is a dead-end — it either approves into a hard execution failure
    // ("Payload must include a non-empty name"), or a missingFields marker
    // blocks Approve with no way to clear it (editProposal touches payload only,
    // so approveProposal keeps rejecting). So the assistant asks for the name
    // instead of persisting a proposal.
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.9,
        extractedEntities: {},
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Add a new customer' }] });

    expect(res.status).toBe(200);
    // No proposal is drafted or persisted — nothing to approve into a failure.
    expect(res.body?.message?.proposal).toBeUndefined();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // Instead the assistant asks for the customer's name conversationally.
    expect(res.body?.message?.content).toMatch(/name/i);
  });

  // §3B/3D/3E — assistant chat must thread the vertical resolver
  // through to the classifier so the operator's text commands see the
  // same HVAC/plumbing terminology the voice path already gets.
  it('forwards verticalPromptResolver output into the classifier system messages', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.93,
        extractedEntities: { displayName: 'Alex' },
      }),
    ]);
    const verticalPromptResolver = vi.fn(
      async (_tenantId: string) => 'Service vertical: HVAC\nEquipment: furnace, AC',
    );
    const app = buildApp(gateway, proposalRepo, verticalPromptResolver);

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Create a new customer named Alex' }] });

    expect(verticalPromptResolver).toHaveBeenCalledWith(TEST_TENANT);
    const classifierCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemContents = (classifierCall.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    expect(systemContents.some((c) => c.includes('Service vertical: HVAC'))).toBe(true);
  });

  it('falls through to the generic LLM text reply when intent is not create_customer', async () => {
    // Non-create_customer classifier response, followed by a generic
    // text reply when the LLM path runs.
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
      JSON.stringify({
        content: 'Here is a summary of your pending invoices.',
        autoApplied: false,
        proposal: null,
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: "What's on tomorrow's schedule?" }] });

    expect(res.status).toBe(200);
    expect(res.body?.message?.proposal ?? null).toBeNull();
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(0);
  });
});

// ─── P20-005: Accurate AI failure messaging + server logging ──────────────────

describe('P20-005 — degraded path: server logging and accurate user-facing copy', () => {
  let proposalRepo: InMemoryProposalRepository;
  let logErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    // Spy on the createLogger factory so we can capture logger.error calls.
    // The assistant route creates its logger at module scope via createLogger;
    // we spy on process.stderr.write (the output sink) to observe error logs.
    logErrorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failingGateway(): LLMGateway {
    return {
      complete: vi.fn(async () => {
        throw new Error('Provider auth failed: invalid API key');
      }),
    } as unknown as LLMGateway;
  }

  it('P20-005: returns HTTP 200 with degraded:true when the LLM gateway throws', async () => {
    const gateway = failingGateway();
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'What jobs are overdue?' }] });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
  });

  it('P20-005: degraded response preserves the correct JSON shape (fallbackStage, message.role)', async () => {
    const gateway = failingGateway();
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Any overdue invoices?' }] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      degraded: true,
      fallbackStage: 'error-envelope',
      message: {
        role: 'assistant',
      },
    });
  });

  it('P20-005: degraded content does not claim the AI backend is unbuilt or "not connected"', async () => {
    const gateway = failingGateway();
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Schedule a job for tomorrow' }] });

    expect(res.status).toBe(200);
    const content: string = res.body?.message?.content ?? '';
    expect(content).not.toMatch(/not connected/i);
    expect(content).not.toMatch(/AI backend is not connected/i);
    expect(content).not.toMatch(/AI_PROVIDER_API_KEY/i);
    // Should still be a helpful, non-empty string
    expect(content.length).toBeGreaterThan(0);
  });

  it('P20-005: logger.error is called with the real error when LLM gateway fails', async () => {
    const gateway = failingGateway();
    const app = buildApp(gateway, proposalRepo);

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Create an invoice' }] });

    // The shared logger writes JSON to process.stderr on error level.
    // Verify that stderr received at least one write containing the
    // assistant route's error message and error level.
    const stderrCalls = logErrorSpy.mock.calls.map((call) => String(call[0]));
    const hasErrorLog = stderrCalls.some(
      (line) =>
        line.includes('assistant/chat') &&
        line.includes('"level":"error"')
    );
    expect(hasErrorLog).toBe(true);
  });
});

describe('Story 3.11/3.12 — assistant chat persistence + correlation id', () => {
  function buildAppWithConvo(
    gateway: LLMGateway,
    proposalRepo: InMemoryProposalRepository,
    conversationRepo: InMemoryConversationRepository,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo, conversationRepo }));
    return app;
  }

  // classify → 'unknown' (fall through), then a generic LLM reply.
  function replyGateway() {
    return scriptedGateway([
      JSON.stringify({ intentType: 'unknown', confidence: 0.9 }),
      JSON.stringify({ content: 'Summary: 3 jobs today.' }),
    ]);
  }

  it('persists the operator + agent turn and returns conversationId + correlationId', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const app = buildAppWithConvo(replyGateway(), new InMemoryProposalRepository(), conversationRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'summarize my day' }] });

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBeTruthy();
    expect(res.body.correlationId).toBeTruthy();

    const messages = await conversationRepo.getMessages(TEST_TENANT, res.body.conversationId);
    expect(messages.map((m) => m.senderRole)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('summarize my day');
    expect(messages[1].content).toBe('Summary: 3 jobs today.');
  });

  it('appends to the same conversation when conversationId is supplied', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const app = buildAppWithConvo(replyGateway(), new InMemoryProposalRepository(), conversationRepo);

    const first = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    const conversationId = first.body.conversationId;

    const second = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'and again' }], conversationId });

    expect(second.body.conversationId).toBe(conversationId);
    expect(await conversationRepo.getMessages(TEST_TENANT, conversationId)).toHaveLength(4);
  });

  it('honors an inbound x-correlation-id', async () => {
    const app = buildAppWithConvo(replyGateway(), new InMemoryProposalRepository(), new InMemoryConversationRepository());
    const res = await request(app)
      .post('/api/assistant/chat')
      .set('x-correlation-id', 'corr-test-123')
      .send({ messages: [{ role: 'user', content: 'summarize my day' }] });
    expect(res.body.correlationId).toBe('corr-test-123');
  });

  it('still returns a reply (degraded) with a correlationId when persistence has no repo', async () => {
    const app = buildApp(replyGateway(), new InMemoryProposalRepository());
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'summarize my day' }] });
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBeTruthy();
  });
});

// ─── E10 (U7): assistant chat card surfaces pricing/confidence/missing-field
// signals so the operator approves an informed proposal (and Approve is blocked
// on an unresolved line). The signals already ride to the persisted proposal;
// the bug was the route's schema + mappers dropping them. ─────────────────────

describe('U7 — proposalSignals helper (pure mapper passthrough)', () => {
  it('surfaces an uncatalogued line + meta from the payload', () => {
    const out = proposalSignals(
      {
        lineItems: [
          { id: 'l1', description: 'Custom fabrication', unitPriceCents: 25000, pricingSource: 'uncatalogued' },
        ],
        _meta: {
          overallConfidence: 'low',
          markers: [{ path: 'lineItems[0].unitPriceCents', reason: 'AI-estimated price — not in catalog' }],
        },
      },
      undefined,
    );
    expect(out.lineItems).toEqual([
      { description: 'Custom fabrication', pricingSource: 'uncatalogued' },
    ]);
    expect(out.meta?.overallConfidence).toBe('low');
    expect(out.meta?.markers).toEqual([
      { path: 'lineItems[0].unitPriceCents', reason: 'AI-estimated price — not in catalog' },
    ]);
  });

  it('reads estimate lines (unitPrice) the same as invoice lines (unitPriceCents) — price-field-agnostic', () => {
    const out = proposalSignals(
      { lineItems: [{ description: 'Flush valve', unitPrice: 8200, pricingSource: 'ambiguous' }] },
      undefined,
    );
    expect(out.lineItems).toEqual([{ description: 'Flush valve', pricingSource: 'ambiguous' }]);
  });

  it('surfaces missingFields from sourceContext (blocks Approve on the card)', () => {
    const out = proposalSignals(
      { lineItems: [{ description: 'valve', pricingSource: 'ambiguous' }] },
      { missingFields: ['lineItems[0].catalogItemId'] },
    );
    expect(out.missingFields).toEqual(['lineItems[0].catalogItemId']);
  });

  it('returns an empty object for a fully-grounded complete proposal (no regression)', () => {
    const out = proposalSignals(
      {
        lineItems: [{ description: 'Service call', unitPriceCents: 9900, pricingSource: 'catalog' }],
        _meta: { overallConfidence: 'high' },
        totalCents: 9900,
      },
      { conversationId: 'c1' },
    );
    // catalog lines still surface their source (the card badges them "From
    // catalog"); but there's no missingFields and no warning marker.
    expect(out.missingFields).toBeUndefined();
    expect(out.meta?.markers).toBeUndefined();
    expect(out.meta?.overallConfidence).toBe('high');
  });
});

describe('U7 — POST /api/assistant/chat surfaces pricing signals on the card', () => {
  function catalogRepo(items: CatalogItem[]): CatalogItemRepository {
    return {
      listByTenant: vi.fn(async () => items),
    } as unknown as CatalogItemRepository;
  }

  function catalogItem(name: string): CatalogItem {
    return {
      id: `cat-${name}`,
      tenantId: TEST_TENANT,
      name,
      description: name,
      category: 'labor',
      unit: 'each',
      unitPriceCents: 5000,
      productServiceType: 'service',
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as CatalogItem;
  }

  function buildAppWithCatalog(gateway: LLMGateway, repo: InMemoryProposalRepository, catalog: CatalogItemRepository) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo: repo, catalogRepo: catalog }));
    return app;
  }

  it("maps an uncatalogued line's pricingSource + confidence meta onto the card", async () => {
    // classifier → create_invoice; then the invoice task LLM emits a line whose
    // description matches nothing in the tenant catalog → 'uncatalogued'.
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9, extractedEntities: {} }),
      JSON.stringify({
        lineItems: [{ description: 'Bespoke widget install', quantity: 1, unitPrice: 25000 }],
        confidence_score: 0.9,
      }),
    ]);
    const repo = new InMemoryProposalRepository();
    const app = buildAppWithCatalog(gateway, repo, catalogRepo([catalogItem('Drain cleaning')]));

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'invoice them for a bespoke widget install' }] });

    expect(res.status).toBe(200);
    const proposal = res.body?.message?.proposal;
    expect(proposal).toBeTruthy();
    expect(proposal.type).toBe('Invoice');
    // The "AI-estimated" badge on the card keys off lineItems[].pricingSource.
    expect(proposal.lineItems?.[0]?.pricingSource).toBe('uncatalogued');
    // The 4-tier confidence bar keys off meta.overallConfidence.
    expect(proposal.meta?.overallConfidence).toBeTruthy();
  });

  it('a normal complete proposal still maps with legacy fields and no spurious envelope', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.93,
        extractedEntities: { displayName: 'Alex', email: 'alex@example.com', phone: '555-0100' },
      }),
    ]);
    const repo = new InMemoryProposalRepository();
    const app = buildApp(gateway, repo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'add customer Alex 555-0100 alex@example.com' }] });

    expect(res.status).toBe(200);
    const proposal = res.body?.message?.proposal;
    expect(proposal.type).toBe('Customer');
    expect(proposal.status).toBe('Pending');
    expect(proposal.title).toBe('New customer: Alex');
    // No fabricated warning signals on a complete proposal.
    expect(proposal.missingFields ?? null).toBeNull();
    expect(proposal.meta ?? null).toBeNull();
  });
});

// ─── UB-B3: voice-mode approval guard ─────────────────────────────────────────
// approve/reject/edit_proposal are not routed by the chat handler; before the
// guard they fell to the generic LLM path. A voice-mode turn (inputMode:
// 'voice') that classifies as an approval intent must get a deterministic
// refusal — never an approval action, never an LLM improvisation — while
// text-mode behavior stays byte-identical (LLM fallback).

describe('UB-B3 — voice-mode approval intents are refused deterministically', () => {
  function buildAppWithAudit(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository, auditRepo: InMemoryAuditRepository) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo, auditRepo }));
    return app;
  }

  it.each(['approve_proposal', 'reject_proposal', 'edit_proposal'])(
    'voice-mode %s → refusal copy + audit event + no proposal mutation + no LLM fallback',
    async (intentType) => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType, confidence: 0.95, extractedEntities: {} }),
        // If the guard ever leaks to the LLM fallback, this reply would surface.
        JSON.stringify({ content: 'LLM improvised an approval reply.' }),
      ]);
      const proposalRepo = new InMemoryProposalRepository();
      const auditRepo = new InMemoryAuditRepository();
      const app = buildAppWithAudit(gateway, proposalRepo, auditRepo);

      const res = await request(app)
        .post('/api/assistant/chat')
        .send({
          messages: [{ role: 'user', content: 'approve the pending estimate' }],
          inputMode: 'voice',
        });

      expect(res.status).toBe(200);
      expect(res.body.message.content).toBe(VOICE_APPROVAL_REFUSAL);
      expect(res.body.message.proposal ?? null).toBeNull();
      expect(res.body.taskType).toBe('assistant.voice_approval_refused');

      // Audited, attributed, and carrying the refused intent.
      const refusals = auditRepo
        .getAll()
        .filter((e) => e.eventType === 'assistant.voice_approval_refused');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].tenantId).toBe(TEST_TENANT);
      expect(refusals[0].metadata).toMatchObject({ intentType });

      // No proposal was created or mutated, and the LLM fallback never ran:
      // the gateway was called exactly once (the classifier).
      expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
      expect(gateway.complete).toHaveBeenCalledTimes(1);
    },
  );

  it('text-mode approval intent keeps the existing behavior (falls to the LLM reply)', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'approve_proposal', confidence: 0.95, extractedEntities: {} }),
      JSON.stringify({ content: 'You can approve it from the proposals inbox.' }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const app = buildAppWithAudit(gateway, proposalRepo, auditRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'approve the pending estimate' }] });

    expect(res.status).toBe(200);
    // Unchanged: unrouted intent falls through to the generic LLM path.
    expect(res.body.message.content).toBe('You can approve it from the proposals inbox.');
    expect(gateway.complete).toHaveBeenCalledTimes(2);
    // No refusal audit on the text path.
    expect(
      auditRepo.getAll().filter((e) => e.eventType === 'assistant.voice_approval_refused'),
    ).toHaveLength(0);
  });
});

describe('UC-2 — chat holds no request transaction across the LLM call', () => {
  it('probe: at gateway time there is no ALS client and no pool checkout', async () => {
    // Regression pin for the PgBouncer known-offender: with the middleware
    // mounted the way app.ts mounts it (before the /api routers), the chat
    // handler must reach the gateway with NO request-scoped transaction —
    // otherwise every concurrent slow chat pins a server backend for the
    // whole LLM call. The middleware bypasses POST /assistant/chat; repos on
    // this route open their own short SET LOCAL transactions instead.
    const { withTenantTransaction, currentTenantContext } = await import(
      '../../src/middleware/tenant-context'
    );
    const connect = vi.fn(async () => {
      throw new Error('pool must not be touched by the chat request transaction');
    });
    const pool = { connect } as unknown as import('pg').Pool;

    const probed: { store: unknown; connects: number }[] = [];
    const gateway = {
      complete: vi.fn(async () => {
        probed.push({ store: currentTenantContext(), connects: connect.mock.calls.length });
        return {
          content: JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        } satisfies LLMResponse;
      }),
    } as unknown as LLMGateway;

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/assistant',
      createAssistantRouter({ gateway, proposalRepo: new InMemoryProposalRepository() }),
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'what should I do next?' }] });

    expect(res.status).toBe(200);
    // The gateway was reached (classifier and/or fallback path) …
    expect(probed.length).toBeGreaterThan(0);
    // … and at EVERY gateway call there was no request-scoped client and the
    // request transaction never checked out a connection.
    for (const p of probed) {
      expect(p.store).toBeUndefined();
      expect(p.connects).toBe(0);
    }
  });
});

// ─── Money-path handler wiring: assistant chat intents must route to the
// DEDICATED task handler for their proposal type (not a same-family
// draft handler that mints the wrong proposalType / skips catalog
// grounding). Covers both dispatch paths in routes/assistant.ts:
// the single-intent `proposalHandlers` map and the multi-step
// `chainHandlers` map used by "X then Y" transcripts. ─────────────────────

describe('money-path handler wiring — update_invoice/send_invoice/issue_invoice route to their own handler', () => {
  function buildAppFor(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
    return app;
  }

  it('single-intent path: update_invoice yields an update_invoice proposal, not draft_invoice', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'update_invoice', confidence: 0.9, extractedEntities: {} }),
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 } },
        ],
        confidence_score: 0.9,
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppFor(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Add a trip fee to invoice INV-0042' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.update_invoice');
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('update_invoice');
  });

  it('single-intent path: send_invoice yields a send_invoice proposal, not draft_invoice', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'send_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042' },
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppFor(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Send invoice INV-0042 to the customer' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.send_invoice');
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('send_invoice');
    // SendInvoiceTaskHandler makes no LLM call of its own — only the
    // classifier reaches the gateway.
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it('single-intent path: issue_invoice yields an issue_invoice proposal, not draft_invoice', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'issue_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042' },
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppFor(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Issue invoice INV-0042' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.issue_invoice');
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('issue_invoice');
    expect(persisted[0].payload).toEqual({ invoiceId: 'INV-0042' });
  });

  it('chain path ("X then Y"): update_invoice and issue_invoice steps each route to their own handler', async () => {
    const gateway = scriptedGateway([
      // generateAssistantReply classifies the FULL message once before it
      // detects the "then" chain and re-classifies per segment; content
      // doesn't matter here since the chain branch returns before this
      // whole-message classification is used.
      JSON.stringify({ intentType: 'unknown', confidence: 0.5 }),
      // Step 1 classify → update_invoice
      JSON.stringify({ intentType: 'update_invoice', confidence: 0.9, extractedEntities: {} }),
      // Step 1 handler (InvoiceEditTaskHandler) LLM call
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 } },
        ],
        confidence_score: 0.9,
      }),
      // Step 2 classify → issue_invoice (IssueInvoiceTaskHandler makes no LLM call)
      JSON.stringify({
        intentType: 'issue_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042' },
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppFor(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: 'Add a trip fee to invoice INV-0042, then issue invoice INV-0042' },
        ],
      });

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.map((p) => p.proposalType).sort()).toEqual(['issue_invoice', 'update_invoice']);
    // Neither chain step should have fallen back to the draft_invoice handler.
    expect(persisted.some((p) => p.proposalType === 'draft_invoice')).toBe(false);
  });
});

describe('money-path handler wiring — update_estimate is catalog-grounded (both dispatch paths)', () => {
  async function seedSiteVisit(): Promise<{ repo: InMemoryCatalogItemRepository; itemId: string }> {
    const repo = new InMemoryCatalogItemRepository();
    const item = await repo.create(
      createCatalogItem({
        tenantId: TEST_TENANT,
        name: 'Site Visit',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 15000,
      }),
    );
    return { repo, itemId: item.id };
  }

  function buildAppWithCatalog(
    gateway: LLMGateway,
    proposalRepo: InMemoryProposalRepository,
    catalogRepo: CatalogItemRepository,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER,
        sessionId: 'sess-1',
        tenantId: TEST_TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo, catalogRepo }));
    return app;
  }

  // The LLM mishears the price ($150.50) for a line that matches an
  // existing catalog item ("Site Visit", $150.00). The deviation (50c) is
  // BELOW both PRICE_CONFLICT_MIN_ABS_CENTS (100c) and PRICE_CONFLICT_MIN_REL
  // (10%), so per edit-action-grounding.ts this is a sub-tolerance mishear,
  // not a deliberate custom price — it snaps to the catalog price. If
  // EstimateEditTaskHandler was constructed without deps.catalogRepo (the
  // pre-fix bug — the 3rd constructor arg was omitted), this line would
  // never resolve against the catalog and would ride the LLM's price as
  // 'uncatalogued' instead of being grounded/snapped to the catalog price.
  it('single-intent path: a catalog-matching update_estimate line takes the catalog price, not the LLM guess', async () => {
    const { repo } = await seedSiteVisit();
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'update_estimate', confidence: 0.9, extractedEntities: {} }),
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'site visit', quantity: 1, unitPrice: 15050 } },
        ],
        confidence_score: 0.9,
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppWithCatalog(gateway, proposalRepo, repo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Add a site visit to estimate EST-0001' }] });

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('update_estimate');
    const payload = persisted[0].payload as { editActions: Array<{ lineItem: Record<string, unknown> }> };
    const lineItem = payload.editActions[0].lineItem;
    expect(lineItem.pricingSource).toBe('catalog');
    // Catalog price ($150.00) snaps the LLM's near-miss $150.50 — a
    // sub-tolerance mishear, not a price conflict.
    expect(lineItem.unitPrice).toBe(15000);
    expect(lineItem.unitPriceCents).toBe(15000);
  });

  // The LLM invents a price ($999.99) for a line that matches an existing
  // catalog item ("Site Visit", $150.00). The deviation (84999c, ~567%) is
  // far past BOTH PRICE_CONFLICT_MIN_ABS_CENTS and PRICE_CONFLICT_MIN_REL,
  // so per edit-action-grounding.ts this is a "did you mean" price
  // conflict, not a mishear — the spoken price is KEPT (never silently
  // overwritten; the owner may have deliberately quoted a custom price)
  // and the line is routed to review. This still proves the assistant path
  // passes catalogRepo so grounding actually runs: without it, this line
  // would ride as 'uncatalogued' instead of 'ambiguous', and the catalog
  // match/markers below would never be produced at all.
  it('chain path ("X then Y"): the update_estimate step is catalog-grounded and send_invoice routes to its own handler', async () => {
    const { repo } = await seedSiteVisit();
    const gateway = scriptedGateway([
      // generateAssistantReply classifies the FULL message once before it
      // detects the "then" chain and re-classifies per segment; content
      // doesn't matter here since the chain branch returns before this
      // whole-message classification is used.
      JSON.stringify({ intentType: 'unknown', confidence: 0.5 }),
      // Step 1 classify → update_estimate
      JSON.stringify({ intentType: 'update_estimate', confidence: 0.9, extractedEntities: {} }),
      // Step 1 handler (EstimateEditTaskHandler) LLM call
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          { type: 'add_line_item', lineItem: { description: 'site visit', quantity: 1, unitPrice: 99999 } },
        ],
        confidence_score: 0.9,
      }),
      // Step 2 classify → send_invoice (SendInvoiceTaskHandler makes no LLM call)
      JSON.stringify({
        intentType: 'send_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042' },
      }),
    ]);
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildAppWithCatalog(gateway, proposalRepo, repo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: 'Add a site visit to estimate EST-0001, then send invoice INV-0042' },
        ],
      });

    expect(res.status).toBe(200);
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.map((p) => p.proposalType).sort()).toEqual(['send_invoice', 'update_estimate']);

    const estimateProposal = persisted.find((p) => p.proposalType === 'update_estimate')!;
    const payload = estimateProposal.payload as {
      editActions: Array<{ lineItem: Record<string, unknown> }>;
      _meta?: { overallConfidence?: string; markers?: Array<{ path: string; reason: string }> };
    };
    const lineItem = payload.editActions[0].lineItem;
    // Price conflict: the spoken $999.99 is KEPT, not snapped to the
    // catalog's $150.00 — grounding never silently overwrites a deliberate
    // custom price.
    expect(lineItem.pricingSource).toBe('ambiguous');
    expect(lineItem.unitPrice).toBe(99999);
    expect(lineItem.unitPriceCents).toBeNull();
    expect(lineItem.needsPricing).toBe(true);
    expect(lineItem.catalogItemId).toBeUndefined();
    // Untrusted price hard-blocks auto-approval via _meta.overallConfidence,
    // independent of the numeric confidence score / any tenant threshold.
    expect(payload._meta?.overallConfidence).toBe('low');
    expect(payload._meta?.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'editActions[0].lineItem.unitPrice' }),
      ]),
    );
  });
});
