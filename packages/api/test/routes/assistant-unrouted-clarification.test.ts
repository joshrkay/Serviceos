/**
 * POST /api/assistant/chat — the assistant must never claim it did something.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two field utterances produced confident, entirely false confirmations:
 *
 *   "put me down for two hours on this one"
 *     → "I've scheduled you for two hours on this job."
 *   "book her for Thursday at ten"
 *     → "I have scheduled the appointment for Thursday at 10 AM."
 *
 * NO proposal row was created in either case and nothing happened. A
 * tradesperson reading that drives away believing the time was logged and the
 * job booked — the worst possible failure mode for this product.
 *
 * The mechanism: the classifier forces anything below
 * CLASSIFIER_CONFIDENCE_THRESHOLD (0.6) to 'unknown' while keeping its best
 * guess in `lowConfidenceIntent`. 'unknown' matched no dispatch entry, so the
 * route fell through to a generic LLM prompt ("provide concise, high-signal
 * operational help") holding the raw imperative. A past-tense confirmation is
 * that prompt's most natural completion, and nothing in the reply schema, the
 * output contract, or any post-parse check could tell truth from fiction.
 *
 * The voice pipeline never had this hole — an 'unknown' classification emits a
 * `voice_clarification` proposal (workers/voice-action-router.ts). These tests
 * pin the chat-surface equivalent.
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake, so the classifier output
 * is forced directly.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import {
  createAssistantRouter,
  NOTHING_WAS_SAVED_NOTICE,
} from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = '33333333-3333-4333-8333-333333333333';
const TEST_USER = 'user-unrouted';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-unrouted',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
  return app;
}

/**
 * The classifier's low-confidence shape: `intentType` is hard-forced to
 * 'unknown' and the best guess is preserved on `lowConfidenceIntent`. Scripting
 * the RAW LLM reply (confidence < 0.6 with a real intent) makes the real
 * classifier produce that shape, so this pins the production path end to end
 * rather than a hand-built classification object.
 */
function lowConfidenceClassifierReply(intentType: string, confidence = 0.42): string {
  return JSON.stringify({
    intentType,
    confidence,
    reasoning: 'terse field utterance',
    extractedEntities: {},
  });
}

/**
 * Past-tense / imminent-action claims. If the assistant emits any of these for
 * an utterance that created nothing, the operator has been lied to.
 */
const COMPLETION_CLAIM_RE =
  /\b(?:i(?:'ve| have)\s+(?:scheduled|booked|logged|recorded|added|sent|created|updated|put)|i\s+scheduled|i\s+booked|i\s+logged|has been (?:scheduled|booked|logged|recorded|sent|created)|(?:that'?s|it'?s) (?:done|all set|booked|scheduled)|all set)\b/i;

/**
 * The two live incidents, plus the intent the classifier leaned toward for
 * each. `lowConfidenceIntent` is what the clarification offers back as a
 * "did you mean".
 */
const INCIDENTS: Array<{ utterance: string; leanedIntent: string; likelyLie: string }> = [
  {
    utterance: 'put me down for two hours on this one',
    leanedIntent: 'log_time_entry',
    likelyLie: "I've scheduled you for two hours on this job.",
  },
  {
    utterance: 'book her for Thursday at ten',
    leanedIntent: 'create_appointment',
    likelyLie: 'I have scheduled the appointment for Thursday at 10 AM.',
  },
];

describe('POST /api/assistant/chat — an unrouted utterance never claims an action', () => {
  for (const { utterance, leanedIntent, likelyLie } of INCIDENTS) {
    it(`"${utterance}" gets a clarification, not a false confirmation`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      // Second entry is what the generic LLM fallback WOULD have said. If the
      // guard regresses, this is the reply the operator sees — and the
      // assertions below fail on it.
      const gateway = scriptedGateway([
        lowConfidenceClassifierReply(leanedIntent),
        JSON.stringify({ content: likelyLie, autoApplied: false, proposal: null }),
      ]);
      const app = buildApp(gateway, proposalRepo);

      const res = await request(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: utterance }] });

      expect(res.status).toBe(200);
      const content: string = res.body.message.content;

      // 1. No completion claim of any kind.
      expect(content).not.toMatch(COMPLETION_CLAIM_RE);
      expect(content).not.toBe(likelyLie);

      // 2. It says, in words, that nothing was saved.
      expect(content).toContain(NOTHING_WAS_SAVED_NOTICE);

      // 3. It is a clarification — it asks, and names the intent it leaned
      //    toward so the operator can confirm in one turn.
      expect(res.body.taskType).toBe('assistant.clarification');
      expect(content).toContain('?');
      expect(content).toContain(leanedIntent.replace(/_/g, ' '));

      // 4. Reality check: nothing was persisted, and no proposal card is
      //    dangled that the operator could tap.
      expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
      expect(res.body.message.proposal ?? null).toBeNull();

      // 5. The generic LLM improvisation never ran — only the classifier call.
      expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });
  }

  it('an unknown with no leaned intent still refuses to improvise', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      // Classifier itself picked 'unknown' at HIGH confidence — no
      // lowConfidenceIntent to offer, so there is no "did you mean".
      JSON.stringify({ intentType: 'unknown', confidence: 0.95, extractedEntities: {} }),
      JSON.stringify({ content: "I've taken care of that.", proposal: null }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'sort that thing out for me' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.clarification');
    expect(res.body.message.content).not.toMatch(COMPLETION_CLAIM_RE);
    expect(res.body.message.content).toContain(NOTHING_WAS_SAVED_NOTICE);
    expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('a confidently classified utterance is untouched — it still drafts a proposal', async () => {
    // The guard must not shadow the happy path: the SAME utterance, classified
    // above threshold, still routes to its handler and persists a real row.
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'log_time_entry',
        confidence: 0.93,
        reasoning: 'clear time log',
        extractedEntities: { durationMinutes: 120 },
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'log two hours on the Miller job' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).not.toBe('assistant.clarification');
    expect(res.body.message.proposal).toBeTruthy();
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('log_time_entry');
  });
});

describe('generic LLM fallback prompt — explicit no-action rule', () => {
  it('the fallback system prompt forbids claiming an action was taken', async () => {
    // Defence in depth: the guard above keeps 'unknown' away from this path,
    // but a classifier EXCEPTION still lands here. The prompt must carry the
    // capability disclaimer so the model cannot confirm work it never did.
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = {
      complete: vi.fn(async (req: { taskType: string }) => {
        // First call is the classifier — blow it up so the route falls into
        // the generic path with the raw imperative.
        if (!req.taskType.startsWith('assistant.')) {
          throw new Error('classifier exploded');
        }
        return {
          content: JSON.stringify({ content: 'Here is what I can tell you.', proposal: null }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        } satisfies LLMResponse;
      }),
    } as unknown as LLMGateway;
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'put me down for two hours on this one' }] });

    expect(res.status).toBe(200);
    const calls = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls;
    const fallbackCall = calls.find(
      (c) => (c[0] as { taskType: string }).taskType === 'assistant.general',
    );
    expect(fallbackCall).toBeTruthy();

    const system = (
      (fallbackCall![0] as { messages: Array<{ role: string; content: string }> }).messages
    )
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    expect(system).toContain('YOU CANNOT PERFORM ACTIONS');
    expect(system).toMatch(/never state or imply that an action was taken/i);
    expect(system).toContain("I've scheduled");
  });

  it('a classifier failure is logged, never swallowed silently', async () => {
    // The classifier catch used to be a bare `} catch {}` with no logging at
    // all, so every one of these turns was invisible in production.
    const proposalRepo = new InMemoryProposalRepository();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const gateway = {
        complete: vi.fn(async (req: { taskType: string }) => {
          if (!req.taskType.startsWith('assistant.')) {
            throw new Error('classifier exploded');
          }
          return {
            content: JSON.stringify({ content: 'ok', proposal: null }),
            model: 'mock',
            provider: 'mock',
            tokenUsage: { input: 1, output: 1, total: 2 },
            latencyMs: 1,
          } satisfies LLMResponse;
        }),
      } as unknown as LLMGateway;
      const app = buildApp(gateway, proposalRepo);

      await request(app)
        .post('/api/assistant/chat')
        .send({ messages: [{ role: 'user', content: 'book her for Thursday at ten' }] });

      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('assistant/chat: intent path failed');
      expect(written).toContain('classifier exploded');
    } finally {
      stderr.mockRestore();
    }
  });
});
