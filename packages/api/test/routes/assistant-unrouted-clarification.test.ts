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
 * WHAT CHANGED SINCE THE FIRST FIX
 * --------------------------------
 * PR #776 answered BOTH of those with one blanket reply
 * (`assistant.clarification`). That was too coarse in one direction and too
 * narrow in the other:
 *
 *   - too coarse: "I didn't understand you" and "we broke" are different
 *     things to tell an operator standing in someone's kitchen, and the
 *     second is not the operator's fault;
 *   - too narrow: it keyed on `intentType === 'unknown'`, so a CONFIDENT
 *     classification for an intent with no handler ('add_crew_member',
 *     'convert_lead') still fell through to the generic LLM — the exact
 *     fabrication path it was written to close.
 *
 * The taxonomy that replaced it (`assistant.not_understood` /
 * `assistant.intent_failed` / `assistant.unhandled.<intent>`) is specified and
 * pinned in `assistant-honest-refusal.test.ts`. THIS file keeps the coverage
 * that is its own and is not duplicated there: the low-confidence classifier
 * shape produced end to end, and the two defence-in-depth mechanisms behind
 * the taxonomy — the fallback prompt's no-action directive, and the fact that
 * a classifier exception is never swallowed silently.
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake, so the classifier output
 * is forced directly.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
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
 * each. Both are forced BELOW the confidence threshold, so both land as
 * 'unknown' — a failure to classify, not a capability gap.
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
    it(`"${utterance}" is answered honestly, not with a false confirmation`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      // Second entry is what the generic LLM fallback DID say in production.
      // The reply is allowed to reach the guard — what must not happen is
      // that it reaches the OPERATOR.
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
      expect(content).toMatch(/haven't scheduled, logged, or changed anything/i);

      // 3. It is the NOT-UNDERSTOOD outcome — the classifier could not place
      //    the utterance, which is a different thing from "we broke" and from
      //    "I can't do that". It asks rather than dead-ends.
      expect(res.body.taskType).toBe('assistant.not_understood');
      expect(content).toMatch(/not sure what you wanted/i);

      // 4. Reality check: nothing was persisted, and no proposal card is
      //    dangled that the operator could tap.
      expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
      expect(res.body.message.proposal ?? null).toBeNull();
    });
  }

  it('an unknown with no leaned intent still refuses to improvise', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      // Classifier itself picked 'unknown' at HIGH confidence.
      JSON.stringify({ intentType: 'unknown', confidence: 0.95, extractedEntities: {} }),
      JSON.stringify({ content: "I've taken care of that.", proposal: null }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'sort that thing out for me' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.not_understood');
    expect(res.body.message.content).not.toMatch(COMPLETION_CLAIM_RE);
    expect(res.body.message.content).toMatch(/haven't scheduled, logged, or changed anything/i);
  });

  it('a CONFIDENT intent with no handler never reaches the LLM at all', async () => {
    // The hole PR #776 left open. 'update_brand_voice' is a real taxonomy
    // intent DELIBERATELY wired into neither chat dispatch map
    // (handler-registry.ts's module doc: stays surface-specific by design),
    // classified at 0.95 — so it is not a misunderstanding, it is a
    // capability we do not have here. Was 'remove_crew_member' until Task 15
    // (2026-08-07 tradesperson plan) wired that intent onto this surface's
    // shared registry, which turned this into a false negative — the
    // canonical "unmapped" example must be one of the four intents that STAY
    // unmapped on purpose, not an incidental gap that closes over time. The
    // second scripted response is the fabrication the fallback LLM would have
    // returned; the gateway call count proves it was never asked.
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'update_brand_voice',
        confidence: 0.95,
        reasoning: 'clear brand-voice change',
        extractedEntities: {},
      }),
      JSON.stringify({ content: "I've updated the brand voice.", proposal: null }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'From now on sound more casual.' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.unhandled.update_brand_voice');
    expect(res.body.message.content).not.toMatch(COMPLETION_CLAIM_RE);
    expect(res.body.message.content).toMatch(/can't do that from here yet/i);
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // Only the classifier call happened.
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
    expect(res.body.taskType).not.toMatch(/unhandled|not_understood|intent_failed/);
    expect(res.body.message.proposal).toBeTruthy();
    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].proposalType).toBe('log_time_entry');
  });
});

describe('generic LLM fallback prompt — explicit no-action rule', () => {
  it('the fallback system prompt tells the model it has taken no action', async () => {
    // Defence in depth (layer 2). The deterministic refusals above keep
    // confident-but-unmapped intents away from this path entirely, but
    // 'unknown' and a classifier EXCEPTION both still land here. The prompt
    // must carry the one fact the model cannot otherwise know.
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

    expect(system).toContain('YOU HAVE TAKEN NO ACTION');
    expect(system).toMatch(/never state or imply that you have done something/i);
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
