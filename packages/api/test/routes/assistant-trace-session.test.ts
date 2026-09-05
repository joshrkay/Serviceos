/**
 * U10 — session threading on the chat route (plan 2026-09-05-001, R10).
 *
 * Every gateway call the chat route makes carries the conversation id as
 * `request.metadata.sessionId`, so Langfuse groups a conversation's calls
 * into one session — on turn ONE (where the route mints the id, #909) as
 * well as on later client-pinned turns, and on both the classifier path and
 * the generic free-text fallback.
 *
 * NO LIVE LLM CALLS — scripted gateway (harness pattern:
 * assistant-usage-propagation.test.ts).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = 'tenant-trace-session';
const TEST_USER = 'user-trace-session';

/** Each entry is either the reply content or an Error the call should throw. */
function scriptedGateway(turns: Array<string | Error>) {
  const calls: LLMRequest[] = [];
  let i = 0;
  const gateway = {
    complete: vi.fn(async (req: LLMRequest) => {
      calls.push(req);
      const turn = turns[i++];
      if (turn === undefined) {
        throw new Error(`scriptedGateway: unexpected gateway call #${i}`);
      }
      if (turn instanceof Error) throw turn;
      return {
        content: turn,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
  return { gateway, calls };
}

function classifierReply(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

const GENERIC_REPLY = JSON.stringify({ content: 'I can help with that.', proposal: null });

function buildApp(gateway: LLMGateway) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-trace',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({ gateway, proposalRepo: new InMemoryProposalRepository() }),
  );
  return app;
}

async function chat(
  app: ReturnType<typeof buildApp>,
  content: string,
  conversationId?: string,
) {
  return request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], ...(conversationId ? { conversationId } : {}) });
}

describe('U10 — chat route threads the conversation id as the gateway session id', () => {
  it('turn one (no conversationId sent): the classify call carries the minted id the reply returns', async () => {
    const { gateway, calls } = scriptedGateway([
      classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
    ]);

    const res = await chat(buildApp(gateway), 'Convert the Johnson lead to a customer');

    expect(res.status).toBe(200);
    expect(typeof res.body.conversationId).toBe('string');
    expect(res.body.conversationId.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe('classify_intent');
    expect(calls[0].metadata?.sessionId).toBe(res.body.conversationId);
    expect(calls[0].metadata?.tenantId).toBe(TEST_TENANT);
  });

  it('turn one on the generic fallback path: the free-text reply call carries the same minted id', async () => {
    // Classifier throws → intent path fails → generic LLM reply (the
    // `assistant-chat-route` gateway call).
    const { gateway, calls } = scriptedGateway([new Error('classifier 429'), GENERIC_REPLY]);

    const res = await chat(buildApp(gateway), 'What should I do about the Johnson job?');

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].metadata).toMatchObject({
      source: 'assistant-chat-route',
      tenantId: TEST_TENANT,
      sessionId: res.body.conversationId,
    });
    expect(calls[0].metadata?.sessionId).toBe(res.body.conversationId);
  });

  it('later turns: the client-pinned conversationId is the session id on every gateway call', async () => {
    const conversationId = randomUUID();
    const { gateway, calls } = scriptedGateway([
      classifierReply('convert_lead', { leadReference: 'the Johnson lead' }),
    ]);

    const res = await chat(buildApp(gateway), 'Convert the Johnson lead to a customer', conversationId);

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe(conversationId);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.sessionId).toBe(conversationId);
  });
});
