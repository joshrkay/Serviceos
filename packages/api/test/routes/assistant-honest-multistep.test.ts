/**
 * #1499 (LLM QA 2026-09-29) — multi-step chat requests, clarifications and
 * card copy, pinned at the chat SURFACE: POST /api/assistant/chat with a
 * scripted gateway replaying the classifier JSON the live turn produced
 * (evidence: ~/Serviceos-qa-evidence/2026-09-29-llm/chat/, matrix AST-04/07).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter, type AssistantRouterDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type Classified = { intentType: string; entities?: Record<string, unknown> };

/**
 * One gateway for the whole turn. The classifier call is answered from
 * `byText` keyed on the exact text classified (the whole turn, or one chain
 * segment); drafting calls get `drafts[<system prompt prefix>]`.
 */
function scriptedGateway(
  byText: Record<string, Classified>,
  drafts: Record<string, string> = {},
): LLMGateway {
  return {
    complete: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      let content = JSON.stringify({ intentType: 'unknown', confidence: 0.2, reasoning: 'unscripted' });
      const draftKey = Object.keys(drafts).find((prefix) => system.startsWith(prefix));
      if (draftKey) {
        content = drafts[draftKey];
      } else {
        // Longest scripted text the classifier input contains wins, so a
        // segment never matches the whole-turn entry that contains it.
        const key = Object.keys(byText)
          .filter((text) => user.includes(text))
          .sort((a, b) => b.length - a.length)[0];
        if (key) {
          const c = byText[key];
          content = JSON.stringify({
            intentType: c.intentType,
            confidence: 0.92,
            reasoning: 'scripted',
            extractedEntities: c.entities ?? {},
          });
        }
      }
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function buildApp(deps: Partial<AssistantRouterDeps> & { gateway: LLMGateway; proposalRepo: InMemoryProposalRepository }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1499',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({ tenantTimezoneResolver: async () => 'America/Phoenix', ...deps } as AssistantRouterDeps),
  );
  return app;
}

const chat = (app: ReturnType<typeof buildApp>, content: string) =>
  request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], conversationId: CONVERSATION_ID });

const ESTIMATE_DRAFT = JSON.stringify({
  lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 120000 }],
  confidence_score: 0.9,
});

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1499 slice 1 — a multi-step reply names every step it did not draft', () => {
  // AST-07: three "then" steps, two cards, and the reply said "Created 2
  // linked steps" as if that were the whole ask. The invoice step vanished.
  it('chain: the dropped third step is named in the reply, with an offer to do it', async () => {
    const turn =
      'New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, then create and send the invoice.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'create_customer', entities: { displayName: 'Jane Smith', phone: '555-0101' } },
          'New customer Jane Smith, phone 555-0101': {
            intentType: 'create_customer',
            entities: { displayName: 'Jane Smith', phone: '555-0101' },
          },
          'draft an estimate for her for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { lineItemDescriptions: ['water heater install'] },
          },
          'create and send the invoice.': { intentType: 'unknown' },
        },
        { 'You are an estimate generation assistant': ESTIMATE_DRAFT },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType).sort()).toEqual([
      'create_customer',
      'draft_estimate',
    ]);
    const content: string = res.body.message.content;
    expect(content).toContain('create and send the invoice');
    expect(content).toMatch(/didn't draft|haven't drafted/i);
    expect(content).toMatch(/want me to/i);
  });

  // C23: no "then", so the chain path never ran; the classifier picked the
  // customer and the booking was never mentioned again.
  it('compound "X, and book her …": the booking the single card did not cover is named in the reply', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411, and book her for an AC check Thursday at 9am.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType)).toEqual(['create_customer']);
    const content: string = res.body.message.content;
    expect(content).toContain('book her for an AC check Thursday at 9am');
    expect(content).toMatch(/didn't draft/i);
    expect(content).toMatch(/want me to/i);
  });

  it('a single-step request carries no undrafted-step note', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });
});
