/**
 * POST /api/assistant/chat — the assistant must never confirm work it did not do.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * A live diagnostic against Development (main `19de36cb`) produced two
 * replies, each reproduced twice, that are worse than any error. Verbatim
 * from `ai_runs`:
 *
 *   "Put me down for two hours on this one."
 *     classify_intent   completed → {"intentType":"unknown","confidence":0.4}
 *     assistant.general completed → "I've scheduled you for two hours on this job."
 *
 *   "Book her for Thursday at ten."
 *     classify_intent   FAILED → 429 requests per day (RPD) 10000/10000
 *     assistant.general completed → "I have scheduled the appointment for Thursday at 10 AM."
 *
 * No proposal existed for either turn. Nothing was created. The two cases
 * below are replayed EXACTLY — same classifier output, same fabricated LLM
 * reply — and both must now come back honest.
 *
 * The assertions are deliberately double-sided: the absence of a proposal AND
 * the absence of success language. Either alone would pass on a reply that is
 * still a lie.
 *
 * NO LIVE LLM CALLS — the gateway is a scripted fake throughout.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { detectFabricatedActionClaim } from '../../src/ai/orchestration/assistant-honesty-guard';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TEST_TENANT = 'tenant-honest-refusal';
const TEST_USER = 'user-honest-refusal';

/**
 * Any first-person claim that work is DONE. Every reply this route can emit
 * without a proposal is checked against it — that is the whole contract.
 */
const SUCCESS_LANGUAGE =
  /\b(?:I(?:['’]ve|\s+have)?\s+(?:scheduled|booked|logged|created|added|put\s+you\s+down)|has\s+been\s+(?:scheduled|booked|logged)|you(?:['’]re|\s+are)\s+(?:all\s+set|booked|scheduled))\b/i;

function scriptedGateway(responses: Array<string | Error>): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        content: next,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

/** Classifier responses are read as JSON by classifyIntent. */
function classifierReply(
  intentType: string,
  confidence: number,
  entities: Record<string, unknown> = {},
): string {
  return JSON.stringify({ intentType, confidence, reasoning: 'test', extractedEntities: entities });
}

/** The generic fallback LLM's envelope (assistantReplySchema). */
function llmReply(content: string, proposal: unknown = null): string {
  return JSON.stringify({ content, reasoning: 'test', autoApplied: false, proposal });
}

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-honest',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
  return app;
}

// ─── The two production fabrications, replayed ───────────────────────────────

describe('the two Development fabrications must never reproduce', () => {
  it('"Put me down for two hours on this one." — unknown@0.4 no longer yields "I\'ve scheduled you for two hours on this job."', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    // EXACTLY what production returned: the classifier's real output, then
    // the real fabricated fallback reply.
    const gateway = scriptedGateway([
      classifierReply('unknown', 0.4),
      llmReply("I've scheduled you for two hours on this job."),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Put me down for two hours on this one.' }] });

    expect(res.status).toBe(200);
    // 1. The lie is gone, verbatim and by pattern.
    expect(res.body.message.content).not.toBe("I've scheduled you for two hours on this job.");
    expect(res.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
    // 2. And there is still no proposal — the absence of success language on a
    //    reply that DID create something would be a different (also wrong) bug.
    expect(res.body.message.proposal ?? null).toBeNull();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // 3. What the operator gets instead: an honest ask, not a dead end.
    expect(res.body.taskType).toBe('assistant.not_understood');
    expect(res.body.message.content).toMatch(/not sure what you wanted/i);
    expect(res.body.message.content).toMatch(/haven't scheduled, logged, or changed anything/i);
  });

  it('"Book her for Thursday at ten." — a classifier 429 no longer yields "I have scheduled the appointment for Thursday at 10 AM."', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    // The classify_intent call threw (OpenAI requests-per-day); the route's
    // bare catch dropped to the generic LLM, which invented a confirmation.
    const gateway = scriptedGateway([
      new Error(
        'AI provider rate limit reached (requests/rate_limit_exceeded); retry after 8.6s. ' +
          'Provider said: 429 Rate limit reached for gpt-4o-mini ... on requests per day (RPD): ' +
          'Limit 10000, Used 10000, Requested 1.',
      ),
      llmReply('I have scheduled the appointment for Thursday at 10 AM.'),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Book her for Thursday at ten.' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).not.toBe('I have scheduled the appointment for Thursday at 10 AM.');
    expect(res.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
    expect(res.body.message.proposal ?? null).toBeNull();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // This one was a BREAKAGE, not a misunderstanding — it must say so.
    expect(res.body.taskType).toBe('assistant.intent_failed');
    expect(res.body.degraded).toBe(true);
    expect(res.body.fallbackStage).toBe('intent-path-failed');
    expect(res.body.message.content).toMatch(/something went wrong/i);
  });
});

// ─── Three failures, three experiences ───────────────────────────────────────

describe('the three no-proposal outcomes are distinguishable', () => {
  it('UNMAPPED CAPABILITY: a confident write intent with no handler refuses deterministically and never reaches the LLM', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    // add_crew_member is a real, supported taxonomy intent with NO entry in
    // either chat dispatch map. The second scripted response is a fabrication
    // the fallback LLM would happily have returned — it must never be asked.
    const gateway = scriptedGateway([
      classifierReply('add_crew_member', 0.95),
      llmReply("I've added Dave to the crew."),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Put Dave on the crew for the Miller work.' }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.unhandled.add_crew_member');
    expect(res.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
    expect(res.body.message.proposal ?? null).toBeNull();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(0);
    // Honest AND useful: names the limit, states nothing happened, offers what does work.
    expect(res.body.message.content).toMatch(/can't do that from here yet/i);
    expect(res.body.message.content).toMatch(/haven't created, changed, or scheduled anything/i);
    // STRUCTURAL, not prompt-shaped: the model was never consulted at all.
    // Only the classifier call happened.
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it('NOT UNDERSTOOD and UNMAPPED CAPABILITY are not the same reply', async () => {
    const unmapped = scriptedGateway([classifierReply('convert_lead', 0.9), llmReply('x')]);
    const unknown = scriptedGateway([
      classifierReply('unknown', 0.3),
      llmReply('I have booked that for you.'),
    ]);

    const a = await request(buildApp(unmapped, new InMemoryProposalRepository()))
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Turn that lead into a customer.' }] });
    const b = await request(buildApp(unknown, new InMemoryProposalRepository()))
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Sort that one out for me.' }] });

    expect(a.body.taskType).toBe('assistant.unhandled.convert_lead');
    expect(b.body.taskType).toBe('assistant.not_understood');
    expect(a.body.message.content).not.toBe(b.body.message.content);
    expect(a.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
    expect(b.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
  });

  it('A GENUINE ERROR still surfaces as an error: when the fallback LLM itself throws, the degraded envelope is unchanged', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    // Classifier says "unknown" cleanly, then the fallback completion blows up.
    // The guard must not swallow this into a clarification.
    const gateway = scriptedGateway([
      classifierReply('unknown', 0.2),
      new Error('provider exploded'),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Anything at all.' }] });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.fallbackStage).toBe('error-envelope');
    expect(res.body.taskType).not.toBe('assistant.not_understood');
    expect(res.body.message.content).not.toMatch(SUCCESS_LANGUAGE);
    expect(res.body.message.proposal ?? null).toBeNull();
  });
});

// ─── No regression ───────────────────────────────────────────────────────────

describe('everything that worked still works', () => {
  it('a MAPPED intent still drafts and persists a proposal exactly as before', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      classifierReply('log_time_entry', 0.95, {
        jobReference: 'Miller',
        timeEntryType: 'job',
        durationMinutes: 120,
      }),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Log two hours on the Miller job.' }] });

    expect(res.status).toBe(200);
    // The guard must not have eaten a real, wired capability.
    expect(res.body.taskType).not.toMatch(/unhandled|not_understood|intent_failed/);
    expect(res.body.message.proposal).toBeTruthy();
    expect(await proposalRepo.findByTenant(TEST_TENANT)).toHaveLength(1);
  });

  it('an ordinary conversational answer passes through untouched', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      classifierReply('unknown', 0.2),
      llmReply('Here is a summary of your pending invoices.'),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: "What's on tomorrow's schedule?" }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe('Here is a summary of your pending invoices.');
  });

  it('a truthful NEGATIVE statement is not mistaken for a fabrication', async () => {
    // "Nothing has been scheduled" contains a completed verb but is honest.
    // Replacing it would swap a good reply for a worse one.
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      classifierReply('unknown', 0.2),
      llmReply("Nothing has been scheduled yet — tell me the customer and I'll draft it."),
    ]);
    const app = buildApp(gateway, proposalRepo);

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Where are we with that one?' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe(
      "Nothing has been scheduled yet — tell me the customer and I'll draft it.",
    );
  });
});

// ─── detectFabricatedActionClaim (unit) ──────────────────────────────────────

describe('detectFabricatedActionClaim', () => {
  it('flags both production fabrications verbatim', () => {
    expect(detectFabricatedActionClaim("I've scheduled you for two hours on this job.")).toBeTruthy();
    expect(
      detectFabricatedActionClaim('I have scheduled the appointment for Thursday at 10 AM.'),
    ).toBeTruthy();
  });

  it('flags the other shapes a completed-action claim takes', () => {
    for (const claim of [
      'I booked her in for Thursday.',
      "I've gone ahead and logged that.",
      'Your time has been logged against the Miller job.',
      "You're all set for Thursday at ten.",
      'Done — two hours on the Miller job.',
      "That's now booked.",
      "I've put you down for two hours.",
    ]) {
      expect(detectFabricatedActionClaim(claim), claim).toBeTruthy();
    }
  });

  it('leaves legitimate future, conditional and negative statements alone', () => {
    for (const honest of [
      'I can schedule that for you — which customer?',
      "I'll draft it once you confirm the time.",
      'Nothing has been scheduled yet.',
      "I have not booked anything — tell me who 'her' is.",
      "I haven't logged that.",
      'Would you like me to book Thursday at ten?',
      'You can approve it from the proposals inbox.',
      'Here is a summary of your pending invoices.',
    ]) {
      expect(detectFabricatedActionClaim(honest), honest).toBeNull();
    }
  });

  it('returns null for empty input', () => {
    expect(detectFabricatedActionClaim('')).toBeNull();
  });
});
