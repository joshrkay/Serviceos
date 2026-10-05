/**
 * #1602 — `GET /api/voice/quality` (owner-only): 7/30-day graded pass rates
 * and the last graded calls; `POST /api/voice/quality/grade`: the owner's
 * on-demand grading trigger.
 *
 * Seam: supertest against the router with the real auth guards, the
 * in-memory grade store and a fake judge gateway. Expected numbers follow
 * from the seeded verdicts (one passing call, one failing call).
 */
import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { createVoiceQualityRouter } from '../../src/routes/voice-quality';
import { createVoiceSessionGrader } from '../../src/voice/quality/grade-voice-session';
import { InMemoryVoiceSessionGradeStore } from '../../src/voice/quality/voice-session-grade-store';
import { createVoiceQualityGradingWorker } from '../../src/workers/voice-quality-grading-worker';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const GOOD_CALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAD_CALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNGRADED_CALL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-10-05T08:00:00.000Z');

const PASS_REPLIES: Record<string, string> = {
  voice_quality_perceived_completion: JSON.stringify({
    perceivedSatisfaction: 'good',
    rationale: 'Caller got the appointment time',
    abandonmentRisk: 0,
  }),
  voice_quality_judge: JSON.stringify({
    answerMeaningMatches: true,
    softSlotsReasonable: true,
    rationale: 'Correct day and time',
  }),
};
const FAIL_REPLIES: Record<string, string> = {
  voice_quality_perceived_completion: JSON.stringify({
    perceivedSatisfaction: 'poor',
    rationale: 'Caller hung up without an answer',
    abandonmentRisk: 2,
  }),
  voice_quality_judge: JSON.stringify({
    answerMeaningMatches: false,
    softSlotsReasonable: true,
    rationale: 'Agent never answered the question',
  }),
};

/** Judge replies keyed by the tenant-attributed request's session, via the script id in the prompt. */
function fakeGateway() {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      const prompt = req.messages.map((m) => m.content).join('\n');
      const replies = prompt.includes('hung up') ? FAIL_REPLIES : PASS_REPLIES;
      return {
        content: replies[req.taskType] ?? '{}',
        model: 'judge-mock-1',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        costMicroCents: 100_000,
      };
    }),
  };
}

function seedCall(
  store: InMemoryVoiceSessionGradeStore,
  id: string,
  endedAt: Date,
  transcript: string[],
  tenantId = TENANT,
) {
  store.seedSession({
    id,
    tenantId,
    channel: 'voice_inbound',
    startedAt: new Date(endedAt.getTime() - 60_000),
    endedAt,
    outcome: 'completed',
    transcript,
    recordingDisclosed: true,
    billable: true,
  });
}

function buildApp(role: 'owner' | 'dispatcher', store: InMemoryVoiceSessionGradeStore) {
  const gateway = fakeGateway();
  const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });
  const worker = createVoiceQualityGradingWorker({
    store,
    grader,
    listTenantIds: async () => [TENANT, OTHER_TENANT],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
  });
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role,
    };
    next();
  });
  app.use('/api/voice/quality', createVoiceQualityRouter({ store, grader, worker, now: () => NOW }));
  return { app, grader };
}

describe('GET /api/voice/quality (#1602)', () => {
  it('returns the 7/30-day graded pass rates, the Layer 2 gate and the last graded calls for the owner', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    // One good call 2 days ago, one bad call 10 days ago (inside 30d, outside 7d).
    seedCall(store, GOOD_CALL, new Date('2026-10-03T15:00:00.000Z'), [
      'caller: When is my appointment?',
      'agent: Tuesday at 10am.',
    ]);
    seedCall(store, BAD_CALL, new Date('2026-09-25T15:00:00.000Z'), [
      'caller: Can someone come today?',
      'agent: One moment.',
      'caller: Hello? I hung up last time.',
    ]);
    const { app, grader } = buildApp('owner', store);
    await grader.gradeVoiceSession(TENANT, BAD_CALL, { trigger: 'nightly' });
    await grader.gradeVoiceSession(TENANT, GOOD_CALL, { trigger: 'nightly' });

    const res = await request(app).get('/api/voice/quality');

    expect(res.status).toBe(200);
    expect(res.body.windows).toEqual({
      last7d: { graded: 1, passed: 1, passRate: 1 },
      last30d: { graded: 2, passed: 1, passRate: 0.5 },
    });
    expect(res.body.gate).toEqual({ passRateMin: 0.85 });
    expect(res.body.quota).toEqual({ sampleRatePct: 20, dailyCap: 20, gradedToday: 2 });
    // Newest grade first, with the criteria + rationale the owner can read.
    expect(res.body.recent).toHaveLength(2);
    expect(res.body.recent[0]).toMatchObject({
      sessionId: GOOD_CALL,
      passed: true,
      model: 'judge-mock-1',
      callEndedAt: '2026-10-03T15:00:00.000Z',
      trigger: 'nightly',
    });
    expect(res.body.recent[1]).toMatchObject({ sessionId: BAD_CALL, passed: false });
    expect(res.body.recent[1].criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grader: 'perceived_completion',
          passed: false,
          rationale: 'Caller hung up without an answer',
        }),
      ]),
    );
  });

  it('reports null pass rates when nothing has been graded yet', async () => {
    const { app } = buildApp('owner', new InMemoryVoiceSessionGradeStore());
    const res = await request(app).get('/api/voice/quality');
    expect(res.status).toBe(200);
    expect(res.body.windows.last7d).toEqual({ graded: 0, passed: 0, passRate: null });
    expect(res.body.recent).toEqual([]);
  });

  it('is owner-only: a dispatcher is refused', async () => {
    const { app } = buildApp('dispatcher', new InMemoryVoiceSessionGradeStore());
    expect((await request(app).get('/api/voice/quality')).status).toBe(403);
    expect((await request(app).post('/api/voice/quality/grade').send({})).status).toBe(403);
  });
});

describe('POST /api/voice/quality/grade (#1602)', () => {
  it('runs the owner\'s tenant through the grading pass now and the result shows up on GET', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedCall(store, UNGRADED_CALL, new Date('2026-10-05T01:00:00.000Z'), [
      'caller: Are you open Saturday?',
      'agent: Yes, 8 to noon.',
    ]);
    // Another tenant's call must not be touched by this owner's trigger.
    seedCall(store, GOOD_CALL, new Date('2026-10-05T01:00:00.000Z'), ['caller: Hi', 'agent: Hello'], OTHER_TENANT);
    const { app } = buildApp('owner', store);

    const run = await request(app).post('/api/voice/quality/grade').send({});

    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ ran: true, tenantsSwept: 1, graded: 1, failures: 0 });
    const res = await request(app).get('/api/voice/quality');
    expect(res.body.recent.map((g: { sessionId: string; trigger: string }) => [g.sessionId, g.trigger])).toEqual([
      [UNGRADED_CALL, 'manual'],
    ]);
    expect((await store.summary(OTHER_TENANT, NOW)).recent).toEqual([]);
  });

  it('grades one named call on demand and answers with its grade', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedCall(store, UNGRADED_CALL, new Date('2026-10-05T01:00:00.000Z'), [
      'caller: Are you open Saturday?',
      'agent: Yes, 8 to noon.',
    ]);
    const { app } = buildApp('owner', store);

    const res = await request(app).post('/api/voice/quality/grade').send({ sessionId: UNGRADED_CALL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'graded',
      grade: { sessionId: UNGRADED_CALL, passed: true, trigger: 'manual', judgeCalls: 2 },
    });
  });

  it('rejects a malformed session id', async () => {
    const { app } = buildApp('owner', new InMemoryVoiceSessionGradeStore());
    const res = await request(app).post('/api/voice/quality/grade').send({ sessionId: 'nope' });
    expect(res.status).toBe(400);
  });
});
