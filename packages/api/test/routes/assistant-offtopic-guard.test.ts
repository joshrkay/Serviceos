/**
 * Off-topic scope guard (owner-approved 2026-09-30, alongside #1480): the chat
 * assistant politely declines non-business requests — poems, jokes, trivia,
 * general knowledge — with one short on-brand line pointing at what it CAN
 * do, and never sends them to the generic model. Business questions,
 * including ambiguous ones, are always answered: when in doubt, answer.
 *
 * Deterministic and post-classification — the classifier prompt is untouched.
 * Seam: POST /api/assistant/chat with a scripted gateway whose classifier
 * returns `unknown` (what these turns classify as), and whose generic-LLM
 * call is observable.
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
const GENERIC_ANSWER = 'Here is how I would approach that for your business.';

/** Classifier → `unknown`; the generic fallback (the no-action directive's call) → GENERIC_ANSWER. */
function scriptedGateway() {
  const genericCalls: string[] = [];
  const complete = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const generic = system.includes('YOU HAVE TAKEN NO ACTION');
    if (generic) genericCalls.push(user);
    return {
      content: generic
        ? JSON.stringify({ content: GENERIC_ANSWER })
        : JSON.stringify({ intentType: 'unknown', confidence: 0.3, reasoning: 'scripted' }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse;
  });
  return { gateway: { complete } as unknown as LLMGateway, genericCalls };
}

function buildApp(gateway: LLMGateway) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: TEST_USER, sessionId: 'sess-scope', tenantId: TEST_TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      tenantTimezoneResolver: async () => 'America/Phoenix',
      proposalRepo: new InMemoryProposalRepository(),
      gateway,
    } as unknown as AssistantRouterDeps),
  );
  return app;
}

async function ask(content: string) {
  const { gateway, genericCalls } = scriptedGateway();
  const res = await request(buildApp(gateway))
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }] });
  return { res, genericCalls };
}

/** The decline: short, says what it does instead, and invites a business ask. */
function expectDeclined(res: request.Response, genericCalls: string[]) {
  expect(res.status).toBe(200);
  expect(genericCalls).toEqual([]);
  const content: string = res.body.message.content;
  expect(content).toMatch(/stick to (?:the|your) business/i);
  expect(content).toMatch(/estimates|invoices|schedul/i);
  expect(content).not.toContain(GENERIC_ANSWER);
}

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('off-topic scope guard — non-business asks are politely declined', () => {
  it('a poem', async () => {
    const { res, genericCalls } = await ask('Write me a poem about the ocean.');
    expectDeclined(res, genericCalls);
  });

  it('a joke', async () => {
    const { res, genericCalls } = await ask('Tell me a joke.');
    expectDeclined(res, genericCalls);
  });

  it('geography trivia', async () => {
    const { res, genericCalls } = await ask("What's the capital of France?");
    expectDeclined(res, genericCalls);
  });

  it('sports trivia', async () => {
    const { res, genericCalls } = await ask('Who won the Super Bowl in 2020?');
    expectDeclined(res, genericCalls);
  });
});

describe('off-topic scope guard — business asks are always answered', () => {
  /** Answered: the generic model was asked, and its answer is the reply. */
  function expectAnswered(res: request.Response, genericCalls: string[]) {
    expect(res.status).toBe(200);
    expect(genericCalls).toHaveLength(1);
    expect(res.body.message.content).toBe(GENERIC_ANSWER);
  }

  it('creative writing FOR the business (a poem for the customer thank-you card)', async () => {
    const { res, genericCalls } = await ask(
      'Write a short poem for the thank-you card we send customers after a furnace install.',
    );
    expectAnswered(res, genericCalls);
  });

  it('a joke to use WITH a customer', async () => {
    const { res, genericCalls } = await ask('Give me a clean joke to break the ice with a customer at the door.');
    expectAnswered(res, genericCalls);
  });

  it('trade history that reads like trivia (who invented the heat pump)', async () => {
    const { res, genericCalls } = await ask('Who invented the heat pump?');
    expectAnswered(res, genericCalls);
  });

  it('an ambiguous ask with no business keyword is answered, not declined', async () => {
    const { res, genericCalls } = await ask('Any tips for a slow week?');
    expectAnswered(res, genericCalls);
  });
});
