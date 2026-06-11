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
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
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
