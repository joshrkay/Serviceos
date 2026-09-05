/**
 * U8 (R8) — the recording webhook's onPersisted hook: attach mid-call turns
 * to the freshly-inserted voice_recordings row, then enqueue ingestion from
 * the persisted rows — or the in-memory session when it is the more complete
 * record (more lines than were persisted) or nothing was persisted — and
 * audit `voice.transcript_unrecoverable` only when neither exists.
 *
 * The hook is the app-layer wiring behind `createRecordingRouter`'s
 * `options.onPersisted` (test/telephony/recording-webhook.test.ts covers the
 * router's failure-soft contract around it).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRecordingTranscriptHook,
  TRANSCRIPT_UNRECOVERABLE_EVENT,
} from '../../src/telephony/recording-transcript-hook';
import {
  InMemoryCallTranscriptTurnRepository,
} from '../../src/voice/call-transcript-turn';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { VoiceSession } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { RecordingPersistedEvent } from '../../src/telephony/recording-webhook';
import { createLogger } from '../../src/logging/logger';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CALL_SID = 'CA00000000000000000000000000000001';
const RECORDING_1 = '33333333-3333-3333-3333-333333333333';
const RECORDING_2 = '44444444-4444-4444-4444-444444444444';
const SESSION_1 = 'session-leg-1';
const SESSION_2 = 'session-leg-2';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function fakeSession(opts: {
  id?: string;
  transcript: string[];
  ended?: boolean;
  intent?: string;
  outcome?: string;
}): VoiceSession {
  return {
    id: opts.id ?? SESSION_1,
    tenantId: TENANT,
    callSid: CALL_SID,
    transcript: [...opts.transcript],
    ended: opts.ended ?? true,
    createdAt: new Date(Date.now() - 45_000),
    terminalOutcome: opts.outcome,
    machine: { currentContext: { currentIntent: opts.intent } },
  } as unknown as VoiceSession;
}

function event(overrides: Partial<RecordingPersistedEvent> = {}): RecordingPersistedEvent {
  return {
    tenantId: TENANT,
    voiceRecordingId: RECORDING_1,
    callSid: CALL_SID,
    durationSeconds: 45,
    inserted: true,
    ...overrides,
  };
}

function harness(opts: { session?: VoiceSession; queue?: boolean } = {}) {
  const store = {
    findByCallSidIncludingEnded: vi.fn((callSid: string) =>
      opts.session && opts.session.callSid === callSid ? opts.session : undefined,
    ),
  };
  const repo = new InMemoryCallTranscriptTurnRepository();
  const auditRepo = new InMemoryAuditRepository();
  const send = vi.fn(async () => 'msg-1');
  const hook = createRecordingTranscriptHook({
    store,
    callTranscriptTurnRepo: repo,
    auditRepo,
    ...(opts.queue === false ? {} : { queue: { send } }),
    logger,
  });
  return { hook, store, repo, auditRepo, send };
}

async function seedLeg(
  repo: InMemoryCallTranscriptTurnRepository,
  sessionId: string,
  lines: ReadonlyArray<readonly ['agent' | 'caller', string]>,
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    await repo.recordTurn({
      tenantId: TENANT,
      callSid: CALL_SID,
      sessionId,
      turnIndex: i,
      speaker: lines[i][0],
      text: lines[i][1],
    });
  }
}

async function unrecoverableAudits(auditRepo: InMemoryAuditRepository, recordingId: string) {
  const events = await auditRepo.findByEntity(TENANT, 'voice_recording', recordingId);
  return events.filter((e) => e.eventType === TRANSCRIPT_UNRECOVERABLE_EVENT);
}

describe('createRecordingTranscriptHook (U8)', () => {
  it('Twilio retry (inserted=false): touches nothing — the first delivery already handled it', async () => {
    const { hook, repo, send, store, auditRepo } = harness({
      session: fakeSession({ transcript: ['agent: hi'] }),
    });
    const attach = vi.spyOn(repo, 'attachRecording');
    await hook(event({ inserted: false }));
    expect(store.findByCallSidIncludingEnded).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await unrecoverableAudits(auditRepo, RECORDING_1)).toEqual([]);
  });

  it('Step 0: a normally-ended session (ended=true) is still found and ingestion is enqueued from it', async () => {
    const session = fakeSession({
      transcript: ['agent: hi how can I help', 'caller: my AC is broken'],
      ended: true,
      intent: 'create_appointment',
      outcome: 'completed',
    });
    const { hook, send, store } = harness({ session });

    await hook(event());

    expect(store.findByCallSidIncludingEnded).toHaveBeenCalledWith(CALL_SID);
    expect(send).toHaveBeenCalledTimes(1);
    const [type, payload, idempotencyKey] = send.mock.calls[0] as unknown as [string, Record<string, unknown>, string];
    expect(type).toBe('transcript_ingestion');
    expect(idempotencyKey).toBe(`transcript:${RECORDING_1}:v1`);
    expect(payload).toMatchObject({
      tenantId: TENANT,
      voiceRecordingId: RECORDING_1,
      intent: 'create_appointment',
      outcome: 'completed',
      turns: [
        { index: 0, speaker: 'agent', text: 'hi how can I help' },
        { index: 1, speaker: 'caller', text: 'my AC is broken' },
      ],
    });
    expect(typeof payload.durationMs).toBe('number');
    expect(payload).not.toHaveProperty('transcript');
  });

  it('happy path after a restart: session gone, rows persisted mid-call → attach, renumber, enqueue three turns', async () => {
    const { hook, repo, send, auditRepo } = harness({ session: undefined });
    await seedLeg(repo, SESSION_1, [
      ['agent', 'hi'],
      ['caller', 'my AC is broken'],
      ['agent', 'when did it start'],
    ]);

    await hook(event());

    const attached = await repo.listByRecording(TENANT, RECORDING_1);
    expect(attached.map((t) => [t.turnIndex, t.text])).toEqual([
      [0, 'hi'],
      [1, 'my AC is broken'],
      [2, 'when did it start'],
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'hi' },
      { index: 1, speaker: 'caller', text: 'my AC is broken' },
      { index: 2, speaker: 'agent', text: 'when did it start' },
    ]);
    // Session-derived fields are simply absent when the session is gone.
    expect(payload).not.toHaveProperty('intent');
    expect(payload).not.toHaveProperty('outcome');
    expect(payload).not.toHaveProperty('durationMs');
    expect(await unrecoverableAudits(auditRepo, RECORDING_1)).toEqual([]);
  });

  it('persisted rows are authoritative over the in-memory session when both exist', async () => {
    // Mid-call restart → gather-fallback created a SECOND session for the same
    // CallSid whose transcript restarts at 0. Only that leg is in memory.
    const leg2 = fakeSession({ id: SESSION_2, transcript: ['agent: welcome back', 'caller: still broken'] });
    const { hook, repo, send } = harness({ session: leg2 });
    await seedLeg(repo, SESSION_1, [['agent', 'hi'], ['caller', 'my AC is broken']]);
    await seedLeg(repo, SESSION_2, [['agent', 'welcome back'], ['caller', 'still broken']]);

    await hook(event());

    const payload = send.mock.calls[0][1] as unknown as { turns: unknown[] };
    // Both legs, in order, none overwritten — indices are the renumbered ones.
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'hi' },
      { index: 1, speaker: 'caller', text: 'my AC is broken' },
      { index: 2, speaker: 'agent', text: 'welcome back' },
      { index: 3, speaker: 'caller', text: 'still broken' },
    ]);
  });

  it('a live session with MORE lines than the persisted rows wins: a turn lost to a failed fire-and-forget persist is still ingested', async () => {
    // PR #975 review finding 2. Turn 1's mid-call persist failed (or is still
    // in flight); the session still holds all three lines.
    const session = fakeSession({
      transcript: ['agent: hi', 'caller: my AC is broken', 'agent: when did it start'],
      intent: 'create_appointment',
    });
    const { hook, repo, send } = harness({ session });
    await repo.recordTurn({
      tenantId: TENANT, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 0, speaker: 'agent', text: 'hi',
    });
    await repo.recordTurn({
      tenantId: TENANT, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 2, speaker: 'agent', text: 'when did it start',
    });

    await hook(event());

    // Attach still happened — the rows the worker upserts onto are claimed.
    expect((await repo.listByRecording(TENANT, RECORDING_1)).map((t) => [t.turnIndex, t.text])).toEqual([
      [0, 'hi'],
      [1, 'when did it start'],
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'hi' },
      { index: 1, speaker: 'caller', text: 'my AC is broken' },
      { index: 2, speaker: 'agent', text: 'when did it start' },
    ]);
    expect(payload.intent).toBe('create_appointment');
  });

  it('session gone + a persisted row missing: the N-1 persisted rows are ingested as-is (unchanged behaviour)', async () => {
    const { hook, repo, send, auditRepo } = harness({ session: undefined });
    await repo.recordTurn({
      tenantId: TENANT, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 0, speaker: 'agent', text: 'hi',
    });
    await repo.recordTurn({
      tenantId: TENANT, callSid: CALL_SID, sessionId: SESSION_1, turnIndex: 2, speaker: 'agent', text: 'when did it start',
    });

    await hook(event());

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][1] as unknown as { turns: unknown[] };
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'hi' },
      { index: 1, speaker: 'agent', text: 'when did it start' },
    ]);
    expect(await unrecoverableAudits(auditRepo, RECORDING_1)).toEqual([]);
  });

  it('voicemail leg: a second recording for the same call never steals turns and enqueues nothing without a session', async () => {
    const { hook, repo, send, auditRepo } = harness({ session: undefined });
    await seedLeg(repo, SESSION_1, [['agent', 'hi'], ['caller', 'leave a message']]);
    await hook(event({ voiceRecordingId: RECORDING_1 }));
    expect(send).toHaveBeenCalledTimes(1);

    await hook(event({ voiceRecordingId: RECORDING_2 }));

    expect((await repo.listByRecording(TENANT, RECORDING_1)).length).toBe(2);
    expect(await repo.listByRecording(TENANT, RECORDING_2)).toEqual([]);
    // No turns belong to the second recording and there is no session to
    // fall back to — but the call's transcript is NOT lost, so no audit.
    expect(send).toHaveBeenCalledTimes(1);
    expect(await unrecoverableAudits(auditRepo, RECORDING_2)).toEqual([]);
  });

  it('no session and no rows → audit voice.transcript_unrecoverable, no enqueue, resolves (200 to Twilio)', async () => {
    const { hook, send, auditRepo } = harness({ session: undefined });

    await expect(hook(event())).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    const audits = await unrecoverableAudits(auditRepo, RECORDING_1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: TENANT,
      actorRole: 'system',
      entityType: 'voice_recording',
      entityId: RECORDING_1,
      metadata: { callSid: CALL_SID },
    });
  });

  it('runs without an ingestion queue (no embedding provider): attach + audit still happen, nothing is enqueued', async () => {
    const { hook, repo, auditRepo, send } = harness({ session: undefined, queue: false });
    await seedLeg(repo, SESSION_1, [['agent', 'hi']]);
    await hook(event({ voiceRecordingId: RECORDING_1 }));
    expect((await repo.listByRecording(TENANT, RECORDING_1)).map((t) => t.text)).toEqual(['hi']);
    expect(send).not.toHaveBeenCalled();

    // And the unrecoverable audit does not depend on the queue either.
    await hook(event({ voiceRecordingId: RECORDING_2, callSid: 'CA-other-call' }));
    expect(await unrecoverableAudits(auditRepo, RECORDING_2)).toHaveLength(1);
  });

  it('a failing attach/load falls back to the in-memory session and still enqueues', async () => {
    const session = fakeSession({ transcript: ['agent: hi', 'caller: hello'] });
    const { hook, repo, send } = harness({ session });
    vi.spyOn(repo, 'attachRecording').mockRejectedValue(new Error('db down'));

    await expect(hook(event())).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][1] as unknown as { turns: unknown[] };
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'hi' },
      { index: 1, speaker: 'caller', text: 'hello' },
    ]);
  });

  it('a failing enqueue is logged, never thrown', async () => {
    const { hook, send } = harness({ session: fakeSession({ transcript: ['agent: hi'] }) });
    send.mockRejectedValueOnce(new Error('queue down'));
    await expect(hook(event())).resolves.toBeUndefined();
  });
});
