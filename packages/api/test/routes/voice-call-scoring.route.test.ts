/**
 * #1736 — `/api/voice/scoring` (owner-only): list scored calls + flags, the
 * opt-in switch, and "correct this call". Supertest against the router with the
 * real auth guards and in-memory stores.
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createVoiceCallScoringRouter } from '../../src/routes/voice-call-scoring';
import { InMemoryVoiceSessionGradeStore } from '../../src/voice/quality/voice-session-grade-store';
import { InMemoryCallScoreStore } from '../../src/voice/scoring/call-score-store';
import type { CallScore } from '../../src/voice/scoring/call-score';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function score(sessionId: string, tenantId: string, over: Partial<CallScore> = {}): CallScore {
  return {
    id: crypto.randomUUID(),
    tenantId,
    sessionId,
    scoredAt: new Date('2026-10-05T08:00:00.000Z'),
    score: 100,
    rubricVersion: 'v1',
    items: [{ id: 'booked', verdict: 'pass', rationale: 'ok' }],
    flags: [],
    summary: 'Booked.',
    model: 'm',
    costMicroCents: 0,
    callEndedAt: new Date('2026-10-04T15:00:00.000Z'),
    ...over,
  };
}

async function build(role: 'owner' | 'dispatcher') {
  const store = new InMemoryCallScoreStore();
  const sessions = new InMemoryVoiceSessionGradeStore();
  await store.saveScore(score(GOOD, TENANT));
  await store.saveScore(
    score(BAD, TENANT, {
      score: 30,
      callEndedAt: new Date('2026-10-04T16:00:00.000Z'),
      items: [{ id: 'booked', verdict: 'fail', rationale: 'Caller asked for Thursday; agent never offered a slot' }],
      flags: [{ kind: 'missed_opportunity', turnIndex: 0, excerpt: 'Caller: can you come Thursday?', note: 'No slot offered' }],
    }),
  );
  await store.saveScore(score('cccccccc-cccc-4ccc-8ccc-cccccccccccc', OTHER));
  sessions.seedSession({
    id: BAD,
    tenantId: TENANT,
    channel: 'voice_inbound',
    startedAt: new Date('2026-10-04T15:58:00.000Z'),
    endedAt: new Date('2026-10-04T16:00:00.000Z'),
    outcome: 'completed',
    transcript: ['caller: can you come Thursday?', 'agent: Let me check.', 'caller: ok?', 'agent: Goodbye.'],
    recordingDisclosed: true,
    billable: true,
  });
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: 'user-1', sessionId: 's', tenantId: TENANT, role };
    next();
  });
  app.use('/api/voice/scoring', createVoiceCallScoringRouter({ store, sessions, auditRepo }));
  return { app, store, auditRepo };
}

describe('GET /api/voice/scoring (#1736)', () => {
  it('lists this tenant\'s scored calls newest first with flags, never another tenant\'s', async () => {
    const { app } = await build('owner');
    const res = await request(app).get('/api/voice/scoring').expect(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.calls.map((c: { sessionId: string }) => c.sessionId)).toEqual([BAD, GOOD]);
    expect(res.body.calls[0]).toMatchObject({ score: 30, needsReview: true, correction: null });
    expect(res.body.calls[0].flags[0]).toMatchObject({ kind: 'missed_opportunity', turnIndex: 0 });
  });

  it('?flagged=1 keeps only calls that need a look', async () => {
    const { app } = await build('owner');
    const res = await request(app).get('/api/voice/scoring?flagged=1').expect(200);
    expect(res.body.calls.map((c: { sessionId: string }) => c.sessionId)).toEqual([BAD]);
  });

  it('is owner-only', async () => {
    const { app } = await build('dispatcher');
    await request(app).get('/api/voice/scoring').expect(403);
    await request(app).put('/api/voice/scoring/settings').send({ enabled: true }).expect(403);
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'other' }).expect(403);
  });
});

describe('PUT /api/voice/scoring/settings (#1736)', () => {
  it('turns scoring on, shows it on the next list, and audits the change', async () => {
    const { app, store, auditRepo } = await build('owner');
    await request(app).put('/api/voice/scoring/settings').send({ enabled: true }).expect(200, { enabled: true });
    expect(await store.isEnabled(TENANT)).toBe(true);
    expect(await store.isEnabled(OTHER)).toBe(false);
    expect((await request(app).get('/api/voice/scoring')).body.enabled).toBe(true);
    const events = await auditRepo.findRecentByTenant!(TENANT, { limit: 5 });
    expect(events[0]).toMatchObject({ eventType: 'voice_call_scoring.setting_changed', metadata: { enabled: true } });
  });

  it('rejects a non-boolean', async () => {
    const { app } = await build('owner');
    await request(app).put('/api/voice/scoring/settings').send({ enabled: 'yes' }).expect(400);
  });
});

describe('POST /api/voice/scoring/:sessionId/correct (#1736)', () => {
  it('records the correction, queues it for export, audits it and shows it on the list', async () => {
    const { app, store, auditRepo } = await build('owner');
    const res = await request(app)
      .post(`/api/voice/scoring/${BAD}/correct`)
      .send({ kind: 'should_have_booked', turnIndex: 0, note: 'Offer Thursday morning' })
      .expect(201);
    expect(res.body.correction).toMatchObject({ kind: 'should_have_booked', turnIndex: 0, exported: false });

    const pending = await store.listPendingExport(TENANT);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sessionId: BAD, createdBy: 'user-1', note: 'Offer Thursday morning' });
    const events = await auditRepo.findRecentByTenant!(TENANT, { limit: 5 });
    expect(events[0]).toMatchObject({ eventType: 'voice_call.corrected', entityId: BAD });
    const list = await request(app).get('/api/voice/scoring');
    expect(list.body.calls[0].correction).toMatchObject({ kind: 'should_have_booked' });
  });

  it('a second correction replaces the first and re-queues it', async () => {
    const { app, store } = await build('owner');
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'other', note: 'a' }).expect(201);
    const [first] = await store.listPendingExport(TENANT);
    await store.markExported(TENANT, first.id, 'owner-correction-x', new Date());
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'wrong_price', note: 'b' }).expect(201);
    const pending = await store.listPendingExport(TENANT);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'wrong_price', note: 'b' });
  });

  it('404s for a call with no score (or another tenant\'s), 400s a bad body or a turn past the end', async () => {
    const { app } = await build('owner');
    await request(app).post('/api/voice/scoring/cccccccc-cccc-4ccc-8ccc-cccccccccccc/correct').send({ kind: 'other' }).expect(404);
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'bogus' }).expect(400);
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'other', note: 'x'.repeat(501) }).expect(400);
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'other', turnIndex: 2 }).expect(400);
    await request(app).post(`/api/voice/scoring/${BAD}/correct`).send({ kind: 'other', turnIndex: 1 }).expect(201);
  });
});
