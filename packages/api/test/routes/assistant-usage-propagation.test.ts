/**
 * #913 — `routes/assistant.ts`'s proposal / chain / policy builders reported
 * `usage: { input: 0, output: 0, total: 0 }` no matter what the intent
 * classifier actually spent, so every client (and the AI-capability sweep)
 * saw zero usage on turns that had just paid for a real classify call.
 *
 * These tests pin that the classifier's provider-reported usage is threaded
 * into the reply envelope on every path that follows a real classify call,
 * that the chain path SUMS the top-level classify plus every segment
 * classify, and that a deterministic pre-classifier path (the unpaid-invoice
 * data lookup) stays at zero because no model was consulted.
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake whose per-response
 * `tokenUsage` is the whole point (mocked-classifier harness pattern:
 * assistant-dropped-intents.test.ts).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = 'tenant-usage-propagation';
const TEST_USER = 'user-usage-propagation';

interface ScriptedTurn {
  content: string;
  usage: { input: number; output: number };
}

/**
 * Strict scripted gateway: every completion carries its scripted
 * `tokenUsage`, and a call past the script throws so a handler making an
 * unexpected extra gateway call fails loudly instead of skewing the sum.
 */
function strictGateway(turns: ScriptedTurn[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      if (i >= turns.length) {
        throw new Error(
          `strictGateway: gateway.complete() called ${i + 1} times but only ${turns.length} turn(s) were scripted`,
        );
      }
      const turn = turns[i++];
      return {
        content: turn.content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { ...turn.usage, total: turn.usage.input + turn.usage.output },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(
  gateway: LLMGateway,
  opts: { proposalRepo?: InMemoryProposalRepository; invoiceRepo?: InMemoryInvoiceRepository } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-usage',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: opts.proposalRepo ?? new InMemoryProposalRepository(),
      ...(opts.invoiceRepo ? { invoiceRepo: opts.invoiceRepo } : {}),
    }),
  );
  return app;
}

async function chat(app: ReturnType<typeof buildApp>, content: string) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }] });
}

describe('#913 — assistant chat replies carry the classifier usage actually spent', () => {
  it('a proposal-draft reply reports the classifier call\'s non-zero usage', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      strictGateway([
        { content: classifierReply('convert_lead', { leadReference: 'the Johnson lead' }), usage: { input: 412, output: 57 } },
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'Convert the Johnson lead to a customer');

    expect(res.status).toBe(200);
    expect(res.body.message.proposal).toBeTruthy();
    expect(res.body.model).toBe('intent-classifier');
    expect(res.body.usage).toEqual({ input: 412, output: 57, total: 469 });
  });

  it('a chained multi-segment reply sums the top-level classify and every segment classify', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      strictGateway([
        // Top-level classify of the FULL turn (chain detection runs after it).
        { content: classifierReply('unknown'), usage: { input: 100, output: 10 } },
        // Segment 1 classify.
        { content: classifierReply('convert_lead', { leadReference: 'the Johnson lead' }), usage: { input: 200, output: 20 } },
        // Segment 2 classify.
        { content: classifierReply('convert_lead', { leadReference: 'the Patel lead' }), usage: { input: 300, output: 30 } },
      ]),
      { proposalRepo },
    );

    const res = await chat(app, 'Convert the Johnson lead then convert the Patel lead');

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.chain');
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(2);
    expect(res.body.usage).toEqual({ input: 600, output: 60, total: 660 });
  });

  it('the deterministic unpaid-invoice lookup never consults a model, so its usage stays zero', async () => {
    // An empty script: any gateway call at all throws, so a zero here is a
    // true "no model consulted", not a masked one.
    const app = buildApp(strictGateway([]), { invoiceRepo: new InMemoryInvoiceRepository() });

    const res = await chat(app, 'Which invoices are unpaid?');

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('data-lookup');
    expect(res.body.usage).toEqual({ input: 0, output: 0, total: 0 });
  });
});
