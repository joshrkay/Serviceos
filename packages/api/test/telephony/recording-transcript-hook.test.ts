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
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../../src/ai/agents/customer-calling/voice-session-store';
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
    cardRedactionWrites: Promise.resolve(),
    unwrittenCardRedactions: [],
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
  // PRIV-3 — the recording flag for a call whose transcript carries a card number.
  const markCardNumberDetected = vi.fn(async () => undefined);
  const hook = createRecordingTranscriptHook({
    store,
    callTranscriptTurnRepo: repo,
    voiceRepo: { markCardNumberDetected },
    auditRepo,
    ...(opts.queue === false ? {} : { queue: { send } }),
    logger,
  });
  return { hook, store, repo, auditRepo, send, markCardNumberDetected };
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
  it('never ingests a session whose tenant differs from the webhook tenant (cross-tenant guard)', async () => {
    // The store is keyed by CallSid only; the webhook may resolve a different
    // tenant (phone-number fallback, TWILIO_DEFAULT_TENANT_ID). The other
    // tenant's transcript must not land in this tenant's recording or index.
    const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
    const foreign = { ...fakeSession({ transcript: ['agent: hi', 'caller: my address is 1 Main St'] }), tenantId: OTHER_TENANT } as VoiceSession;
    const { hook, send, auditRepo, repo } = harness({ session: foreign });

    await hook(event());

    expect(send).not.toHaveBeenCalled();
    expect(await repo.listByCallSid(TENANT, CALL_SID)).toHaveLength(0);
    expect(await unrecoverableAudits(auditRepo, RECORDING_1)).toHaveLength(1);
  });

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

  it('voicemail leg WITH a live session: the second recording never re-ingests turns the first one claimed', async () => {
    // Found at runtime verification of PR #975: the session-wins rule saw
    // zero rows for RECORDING_2, decided the session was "more complete",
    // and enqueued the whole transcript again under the second id — four
    // duplicate rows with no call_sid/session_id.
    const session = fakeSession({
      transcript: ['agent: hi', 'caller: leave a message'],
      ended: false,
      outcome: 'no_intent',
    });
    const { hook, repo, send, auditRepo } = harness({ session });
    await seedLeg(repo, SESSION_1, [['agent', 'hi'], ['caller', 'leave a message']]);
    await hook(event({ voiceRecordingId: RECORDING_1 }));
    expect(send).toHaveBeenCalledTimes(1);

    await hook(event({ voiceRecordingId: RECORDING_2 }));

    expect((await repo.listByRecording(TENANT, RECORDING_1)).length).toBe(2);
    expect(await repo.listByRecording(TENANT, RECORDING_2)).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await unrecoverableAudits(auditRepo, RECORDING_2)).toEqual([]);
  });

  it('rows split across two recordings: a longer live session does not re-ingest the first recording\'s turns under the second', async () => {
    // Leg 1 was attached to RECORDING_1; leg 2 persisted afterwards and is
    // claimed by RECORDING_2. The session holds every line of both legs plus
    // one that never persisted — but the session-wins rule must not fire
    // when another recording holds part of the call, or leg 1 would be
    // ingested twice. RECORDING_2 ingests exactly its own rows.
    const session = fakeSession({
      transcript: ['agent: hi', 'caller: my AC is broken', 'agent: leave a message', 'caller: call me back', 'caller: thanks'],
      ended: false,
    });
    const { hook, repo, send } = harness({ session });
    await seedLeg(repo, SESSION_1, [['agent', 'hi'], ['caller', 'my AC is broken']]);
    await hook(event({ voiceRecordingId: RECORDING_1 }));
    await seedLeg(repo, SESSION_2, [['agent', 'leave a message'], ['caller', 'call me back']]);

    await hook(event({ voiceRecordingId: RECORDING_2 }));

    expect((await repo.listByRecording(TENANT, RECORDING_1)).map((t) => t.text)).toEqual(['hi', 'my AC is broken']);
    expect(send).toHaveBeenCalledTimes(2);
    const payload = send.mock.calls[1][1] as unknown as { voiceRecordingId: string; turns: unknown[] };
    expect(payload.voiceRecordingId).toBe(RECORDING_2);
    expect(payload.turns).toEqual([
      { index: 0, speaker: 'agent', text: 'leave a message' },
      { index: 1, speaker: 'caller', text: 'call me back' },
    ]);
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

  // PRIV-3 — a card number recited on the call reached the transcript as the
  // `[card number]` marker (callerTranscriptText). The audio still holds the
  // digits, so the recording is flagged for the prompt audio purge.
  it('PRIV-3: flags the recording when a persisted caller turn carries the card-number marker', async () => {
    const { hook, repo, markCardNumberDetected } = harness();
    await seedLeg(repo, SESSION_1, [
      ['agent', 'you owe $120'],
      ['caller', 'can I just pay now, my card is [card number] expires 09/27'],
    ]);

    await hook(event());

    expect(markCardNumberDetected).toHaveBeenCalledTimes(1);
    expect(markCardNumberDetected).toHaveBeenCalledWith(TENANT, RECORDING_1);
  });

  it('PRIV-3: flags the recording from the in-memory session when nothing was persisted', async () => {
    const session = fakeSession({ transcript: ['agent: hi', 'caller: it is [card number]'] });
    const { hook, markCardNumberDetected } = harness({ session });

    await hook(event());

    expect(markCardNumberDetected).toHaveBeenCalledWith(TENANT, RECORDING_1);
  });

  it('PRIV-3: a call with no card number is never flagged', async () => {
    const { hook, repo, markCardNumberDetected } = harness();
    await seedLeg(repo, SESSION_1, [
      ['agent', 'hi'],
      ['caller', 'call me back on 602 555 0199, the gate code is 4821'],
    ]);

    await hook(event());

    expect(markCardNumberDetected).not.toHaveBeenCalled();
  });

  it('PRIV-3: a failing flag write is logged and never blocks the ingestion enqueue', async () => {
    const { hook, repo, send, markCardNumberDetected } = harness();
    markCardNumberDetected.mockRejectedValueOnce(new Error('db down'));
    const errorLog = vi.spyOn(logger, 'error');
    await seedLeg(repo, SESSION_1, [['caller', 'my card is [card number]']]);

    await expect(hook(event())).resolves.toBeUndefined();

    // The flag write was attempted (and failed) ...
    expect(markCardNumberDetected).toHaveBeenCalledTimes(1);
    // ... the failure is logged so the missed flag is visible ...
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('flag write failed'),
      expect.objectContaining({ tenantId: TENANT, voiceRecordingId: RECORDING_1, error: 'db down' }),
    );
    // ... and the ingestion enqueue still ran.
    expect(send).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  // PRIV-3 — a card split across caller turns is rewritten in memory at once,
  // but the rewrite of the stored rows is fire-and-forget. The completing turn
  // is stored already rewritten, so once that rewrite fails the rows left
  // ("my card is 4111 1111", "1111") no longer hold a card any re-read could
  // find: only the session knows what they must say. Ingested as they are,
  // the fragments reach knowledge_chunks, whose per-chunk scrub cannot see a
  // card spread over several "caller:" lines.
  describe('PRIV-3: a card split across caller turns whose stored rewrite never landed', () => {
    const MARKER = '[card number]';

    function payloadTurns(send: ReturnType<typeof harness>['send']) {
      const [type, payload] = send.mock.calls[0] as unknown as [
        string,
        { turns: Array<{ speaker: string; text: string }> },
      ];
      expect(type).toBe('transcript_ingestion');
      return payload.turns;
    }

    /** A live call through the real store whose rows' rewrite fails. */
    async function liveCallWithFailedRewrite(repo: InMemoryCallTranscriptTurnRepository) {
      const store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
      const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
      const live = vi.spyOn(repo, 'redactCardNumberTurns').mockRejectedValueOnce(new Error('db down'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const [speaker, text] of [
        ['agent', 'how can I help'],
        ['caller', 'my card is 4111 1111'],
        ['agent', 'go on'],
        ['caller', '1111'],
        ['agent', 'and the rest?'],
        ['caller', '1111 thanks'],
      ] as const) {
        store.appendTranscript(session.id, { speaker, text });
      }
      await session.cardRedactionWrites;
      consoleError.mockRestore();
      live.mockClear();
      // The live rewrite failed: the rows still hold the fragments.
      expect((await repo.listByCallSid(TENANT, CALL_SID)).map((r) => r.text)).toEqual([
        'how can I help',
        'my card is 4111 1111',
        'go on',
        '1111',
        'and the rest?',
        `${MARKER} thanks`,
      ]);
      return { store, session, live };
    }

    it('writes the rewrite that did not land, in one audited repository call, before the call is ingested', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const { store, session, live } = await liveCallWithFailedRewrite(repo);
      const auditRepo = new InMemoryAuditRepository();
      const send = vi.fn(async () => 'msg-1');
      const markCardNumberDetected = vi.fn(async () => undefined);
      const hook = createRecordingTranscriptHook({
        store,
        callTranscriptTurnRepo: repo,
        voiceRepo: { markCardNumberDetected },
        auditRepo,
        queue: { send },
        logger,
      });

      await hook(event());

      const rows = await repo.listByRecording(TENANT, RECORDING_1);
      expect(rows.map((r) => r.text)).toEqual([
        'how can I help',
        `my card is ${MARKER}`,
        'go on',
        MARKER,
        'and the rest?',
        `${MARKER} thanks`,
      ]);
      expect(live).toHaveBeenCalledTimes(1);
      expect(live).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, callSid: CALL_SID, sessionId: session.id, actorId: 'recording_webhook' }),
      );
      expect(session.unwrittenCardRedactions).toEqual([]);
      expect(payloadTurns(send).filter((t) => t.speaker === 'caller').map((t) => t.text)).toEqual([
        `my card is ${MARKER}`,
        MARKER,
        `${MARKER} thanks`,
      ]);
      expect(JSON.stringify(payloadTurns(send))).not.toMatch(/4111|\b1111\b/);
      expect(markCardNumberDetected).toHaveBeenCalledWith(TENANT, RECORDING_1);
    });

    it('still ingests the redacted text when that write fails again, and logs indexes, never text', async () => {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const { store, session, live } = await liveCallWithFailedRewrite(repo);
      live.mockRejectedValueOnce(new Error('db still down'));
      const send = vi.fn(async () => 'msg-1');
      const markCardNumberDetected = vi.fn(async () => undefined);
      const hook = createRecordingTranscriptHook({
        store,
        callTranscriptTurnRepo: repo,
        voiceRepo: { markCardNumberDetected },
        auditRepo: new InMemoryAuditRepository(),
        queue: { send },
        logger,
      });
      const errorLog = vi.spyOn(logger, 'error');
      try {
        await expect(hook(event())).resolves.toBeUndefined();

        expect(errorLog).toHaveBeenCalledWith(
          'recording-transcript-hook: card-number rewrite of stored turns failed',
          expect.objectContaining({
            callSid: CALL_SID,
            voiceRecordingId: RECORDING_1,
            turnIndexes: [1, 3, 5],
            error: 'db still down',
          }),
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/4111|\b1111\b|my card/);
        expect(JSON.stringify(payloadTurns(send))).not.toMatch(/4111|\b1111\b/);
        expect(payloadTurns(send).filter((t) => t.speaker === 'caller').map((t) => t.text)).toEqual([
          `my card is ${MARKER}`,
          MARKER,
          `${MARKER} thanks`,
        ]);
        expect(markCardNumberDetected).toHaveBeenCalledWith(TENANT, RECORDING_1);
        // Kept for any later attempt.
        expect(session.unwrittenCardRedactions).toHaveLength(1);
      } finally {
        errorLog.mockRestore();
      }
    });

    it('reads the stored caller turns again: a split card no live rewrite ever saw is rewritten too', async () => {
      // Rows from a process that never stitched them (no session here).
      const { hook, repo, send } = harness();
      await seedLeg(repo, SESSION_1, [
        ['agent', 'how can I help'],
        ['caller', 'my card is 4111 1111'],
        ['agent', 'go on'],
        ['caller', '1111'],
        ['agent', 'and the rest?'],
        ['caller', '1111 thanks'],
      ]);
      const rewrite = vi.spyOn(repo, 'redactCardNumberTurns');

      await hook(event());

      const rows = await repo.listByRecording(TENANT, RECORDING_1);
      expect(rows.filter((r) => r.speaker === 'caller').map((r) => r.text)).toEqual([
        `my card is ${MARKER}`,
        MARKER,
        `${MARKER} thanks`,
      ]);
      expect(rewrite).toHaveBeenCalledWith({
        tenantId: TENANT,
        callSid: CALL_SID,
        sessionId: SESSION_1,
        actorId: 'recording_webhook',
        turns: [
          { id: rows[1].id, turnIndex: 1, text: `my card is ${MARKER}` },
          { id: rows[3].id, turnIndex: 3, text: MARKER },
          { id: rows[5].id, turnIndex: 5, text: `${MARKER} thanks` },
        ],
      });
      expect(JSON.stringify(payloadTurns(send))).not.toMatch(/4111|\b1111\b/);
    });

    it('reads each session leg on its own, as the live window does, and never stitches turns a minute apart', async () => {
      const { hook, repo, send } = harness();
      const t0 = Date.now() - 300_000;
      const seed = (sessionId: string, turnIndex: number, text: string, atMs: number) =>
        repo.recordTurn({
          tenantId: TENANT,
          callSid: CALL_SID,
          sessionId,
          turnIndex,
          speaker: 'caller',
          text,
          startedAt: new Date(atMs),
        });
      // Leg 1 ends on the first half; leg 2 (a restart) opens on the second.
      await seed(SESSION_1, 0, '4111 1111', t0);
      await seed(SESSION_2, 0, '1111 1111', t0 + 5_000);
      await seed(SESSION_2, 1, 'and my zip, 4111 1111', t0 + 10_000);
      // Said more than a minute after the turn before it.
      await seed(SESSION_2, 2, '1111 1111', t0 + 75_000);
      const rewrite = vi.spyOn(repo, 'redactCardNumberTurns');

      await hook(event());

      expect(rewrite).not.toHaveBeenCalled();
      expect(payloadTurns(send).map((t) => t.text)).toEqual([
        '4111 1111',
        '1111 1111',
        'and my zip, 4111 1111',
        '1111 1111',
      ]);
    });

    // A group of four per caller turn is a card only where it is mentioned;
    // the re-read sees the agent's rows around the caller's, as the live path
    // sees its lines, and leaves them as stored unless one repeats a part of
    // the card the caller had already said.
    it("reads the agent's stored rows for a mention of the card, and leaves them as stored", async () => {
      const { hook, repo, send } = harness();
      await seedLeg(repo, SESSION_1, [
        ['caller', '4111'],
        ['agent', "Sorry, I can't take card numbers over the phone, 1111."],
        ['caller', '1111'],
        ['caller', '1111'],
        ['caller', '1111'],
      ]);
      await seedLeg(repo, SESSION_2, [
        ['agent', 'What is the gate code?'],
        ['caller', '4111'],
        ['caller', '1111'],
        ['caller', '1111'],
        ['caller', '1111'],
      ]);
      const rewrite = vi.spyOn(repo, 'redactCardNumberTurns');

      await hook(event());

      expect(rewrite).toHaveBeenCalledTimes(1);
      expect(rewrite).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_1 }));
      const rows = await repo.listByRecording(TENANT, RECORDING_1);
      expect(rows.filter((r) => r.sessionId === SESSION_1).map((r) => r.text)).toEqual([
        MARKER,
        "Sorry, I can't take card numbers over the phone, 1111.",
        MARKER,
        MARKER,
        MARKER,
      ]);
      expect(rows.filter((r) => r.sessionId === SESSION_2).map((r) => r.text)).toEqual([
        'What is the gate code?',
        '4111',
        '1111',
        '1111',
        '1111',
      ]);
      expect(payloadTurns(send).filter((t) => t.speaker === 'caller').map((t) => t.text).slice(0, 4)).toEqual(
        Array(4).fill(MARKER),
      );
    });

    // The agent has the caller fetch the card while it pulls up the invoice
    // itself ("While you grab that, I'll pull up your invoice."): the invoice
    // is the agent's own, no number asked for, and the card read after
    // "okay" and "Okay, go ahead." is still the card, live and at the
    // recording. Read as an ask for another number, it was left in clear.
    it('rewrites a card read after the agent has the caller fetch it while it pulls up the invoice', async () => {
      const said = [
        ['agent', 'How can I help?'],
        ['caller', 'I want to pay my invoice by card'],
        ['agent', "Sure. While you grab that, I'll pull up your invoice."],
        ['caller', 'okay'],
        ['agent', 'Okay, go ahead.'],
        ['caller', '4111'],
        ['caller', '1111'],
        ['caller', '1111'],
        ['caller', '1111'],
      ] as const;
      const liveRepo = new InMemoryCallTranscriptTurnRepository();
      const store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: liveRepo });
      const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
      for (const [speaker, text] of said) store.appendTranscript(session.id, { speaker, text });
      await session.cardRedactionWrites;
      expect(session.transcript.slice(-4), 'live transcript').toEqual(Array(4).fill(`caller: ${MARKER}`));
      store.dispose();

      const { hook, repo, send, markCardNumberDetected } = harness();
      await seedLeg(repo, SESSION_1, said);
      await hook(event());
      const rows = await repo.listByRecording(TENANT, RECORDING_1);
      expect(rows.filter((r) => r.speaker === 'caller').map((r) => r.text)).toEqual([
        'I want to pay my invoice by card',
        'okay',
        ...Array(4).fill(MARKER),
      ]);
      expect(JSON.stringify(payloadTurns(send))).not.toMatch(/4111|\b1111\b/);
      expect(markCardNumberDetected).toHaveBeenCalledWith(TENANT, RECORDING_1);
    });

    // The agent's confirm readback renders what the classifier took from the
    // caller's turn: its stored row holds the card's first part as well.
    it("rewrites the agent's stored readback of a part of the card with the caller's rows", async () => {
      const { hook, repo, send } = harness();
      await seedLeg(repo, SESSION_1, [
        ['caller', 'add a note, the card on file is 4111 1111 1111'],
        ['agent', 'Just to confirm: the card on file is 4111 1111 1111. Is that right?'],
        ['caller', "1111. Yes, that's right."],
        ['agent', 'Done.'],
      ]);
      const rewrite = vi.spyOn(repo, 'redactCardNumberTurns');

      await hook(event());

      const rows = await repo.listByRecording(TENANT, RECORDING_1);
      expect(rows.map((r) => r.text)).toEqual([
        `add a note, the card on file is ${MARKER}`,
        `Just to confirm: the card on file is ${MARKER}. Is that right?`,
        `${MARKER}. Yes, that's right.`,
        'Done.',
      ]);
      expect(rewrite).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [
            { id: rows[0].id, turnIndex: 0, text: `add a note, the card on file is ${MARKER}` },
            { id: rows[1].id, turnIndex: 1, speaker: 'agent', text: `Just to confirm: the card on file is ${MARKER}. Is that right?` },
            { id: rows[2].id, turnIndex: 2, text: `${MARKER}. Yes, that's right.` },
          ],
        }),
      );
      expect(JSON.stringify(payloadTurns(send))).not.toMatch(/4111|\b1111\b/);
    });

    it('leaves a call whose rows were already rewritten live as it is', async () => {
      const { hook, repo } = harness();
      await seedLeg(repo, SESSION_1, [
        ['caller', `my card is ${MARKER}`],
        ['caller', MARKER],
        ['caller', `${MARKER} thanks`],
      ]);
      const rewrite = vi.spyOn(repo, 'redactCardNumberTurns');
      await hook(event());
      expect(rewrite).not.toHaveBeenCalled();
    });
  });

  // PRIV-3 — card talk, a pause turn ("sure", "mm-hmm", "okay"), then the
  // agent's intake questions answered with bare numbers. The mention of the
  // card was read past the pause, so the answers were stitched into a "card"
  // live (the transcript and the rows rewritten) and again from the stored
  // rows at the recording, which was flagged for its audio to be purged. The
  // agent's question right before them asks for another number: no card.
  describe('PRIV-3: intake answers after card talk and a pause turn are no card, live or at the recording', () => {
    type Said = ReadonlyArray<readonly ['agent' | 'caller', string]>;
    const LEGS: ReadonlyArray<readonly [string, Said]> = [
      [
        'the agent on cards, "sure", then a customer number and two house numbers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'Do you want the card on file charged after the visit?'],
          ['caller', 'sure'],
          ['agent', 'Your customer number?'],
          ['caller', '67500046'],
          ['agent', "What's the house number?"],
          ['caller', '7179'],
          ['agent', "What's the house number?"],
          ['caller', '2407'],
        ],
      ],
      [
        'the caller asks about paying by card, "mm-hmm", then lockbox codes, a PIN and a last four',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['caller', 'can I pay by card when they come'],
          ['agent', 'Yes, we do.'],
          ['caller', 'mm-hmm'],
          ['agent', 'And the lockbox code?'],
          ['caller', 'five three zero nine'],
          ['agent', 'And the account PIN?'],
          ['caller', 'nine five zero eight'],
          ['caller', 'sure'],
          ['agent', 'And the lockbox code?'],
          ['caller', '0518'],
          ['agent', 'Last four of your phone?'],
          ['caller', '6429'],
        ],
      ],
      [
        // 3605550006 then 2247: fourteen digit words from 36 passing the Luhn check.
        'card talk, "okay", then a callback number from 360 read straight on into four more digits',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['caller', 'okay'],
          ['agent', "What's a good callback number?"],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      // The agent's ask said before the caller's pause, between two pauses,
      // or in the card talk's own line; a request with no question mark; a
      // phone number asked for without naming one. Each pause is an old one
      // ("yeah", "okay") or an aside ("Yep.", "One sec.", "Un momento.").
      [
        'card talk, the gate code asked, "Yep.", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['caller', "I'll pay with my Visa at the visit"],
          ['agent', "What's the gate code?"],
          ['caller', 'Yep.'],
          ['caller', "it's two three two eight"],
          ['agent', 'And the lockbox code?'],
          ['caller', 'one four zero four'],
          ['agent', "What's the house number?"],
          ['caller', 'eight five one one'],
          ['agent', 'And the account PIN?'],
          ['caller', 'four five one one'],
        ],
      ],
      [
        'the agent on cards and the PIN asked, "yeah", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'We take all major cards at the visit.'],
          ['agent', 'And the account PIN?'],
          ['caller', 'yeah'],
          ['caller', '5104'],
          ['agent', 'And the account PIN?'],
          ['caller', 'zero nine zero five'],
          ['agent', 'Unit number?'],
          ['caller', 'four six six eight'],
          ['agent', 'What year is the unit?'],
          ['caller', 'sure'],
          ['caller', '2001'],
          ['agent', 'Unit number?'],
          ['caller', 'five two six'],
        ],
      ],
      [
        'card talk, "okay", the lockbox code asked, "yeah", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['caller', "I'll pay with my Visa at the visit"],
          ['agent', 'Yes, we do.'],
          ['caller', 'okay'],
          ['agent', 'And the lockbox code?'],
          ['caller', 'yeah'],
          ['caller', '4039'],
          ['agent', 'What year is the unit?'],
          ['caller', '2024'],
          ['agent', "What's the gate code?"],
          ['caller', '1398'],
          ['agent', 'And the account PIN?'],
          ['caller', 'six nine three five'],
        ],
      ],
      [
        'the agent on cards, "Yep.", the house number asked, "Hold on.", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'We take all major cards at the visit.'],
          ['caller', 'Yep.'],
          ['agent', 'And the house number, please.'],
          ['caller', 'Hold on.'],
          ['caller', 'five five eight one'],
          ['agent', 'Go ahead with your customer number.'],
          ['caller', 'three eight three zero one four four zero'],
          ['agent', "I'll need the lockbox code."],
          ['caller', 'five four two three'],
        ],
      ],
      [
        'card talk and the PIN asked in one line, "sure", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'We take all major cards at the visit. And the account PIN?'],
          ['caller', 'sure'],
          ['caller', '5104'],
          ['agent', 'Unit number?'],
          ['caller', 'zero nine zero five'],
          ['agent', 'Unit number?'],
          ['caller', 'four six six eight'],
          ['agent', 'What year is the unit?'],
          ['caller', '2001'],
        ],
      ],
      [
        'en español: tarjetas y el PIN en una línea, "Un momento.", then the answers',
        [
          ['agent', '¿En qué le puedo ayudar?'],
          ['caller', 'necesito una cita para el aire'],
          ['agent', 'Aceptamos todas las tarjetas en la visita. ¿El PIN de la cuenta?'],
          ['caller', 'Un momento.'],
          ['caller', 'cinco uno cero cuatro'],
          ['agent', '¿Número de unidad?'],
          ['caller', 'cero nueve cero cinco'],
          ['agent', '¿Número de unidad?'],
          ['caller', 'cuatro seis seis ocho'],
          ['agent', '¿De qué año es el equipo?'],
          ['caller', '2001'],
        ],
      ],
      [
        'the agent on cards, "One sec.", then "Please give me the alarm code." and more requests',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'I can send you a link to pay by card.'],
          ['caller', 'One sec.'],
          ['agent', 'Please give me the alarm code.'],
          ['caller', '2246'],
          ['agent', 'Go ahead with your customer number.'],
          ['caller', 'eight eight nine six three two four five'],
          ['agent', 'Tell me the year of the unit.'],
          ['caller', '1999'],
          ['agent', 'Read me the zip code.'],
          ['caller', '94901'],
        ],
      ],
      [
        'the agent on cards, "okay", then "Go ahead with the gate code." and more requests',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'I can send you a link to pay by card.'],
          ['caller', 'okay'],
          ['agent', 'Go ahead with the gate code.'],
          ['caller', '2246'],
          ['agent', 'Go ahead with your customer number.'],
          ['caller', 'eight eight nine six three two four five'],
          ['agent', 'Tell me the year of the unit.'],
          ['caller', '1999'],
        ],
      ],
      [
        'en español: tarjeta, "A ver.", then "Dígame el código postal." and more requests',
        [
          ['agent', '¿En qué le puedo ayudar?'],
          ['caller', 'necesito una cita para el aire'],
          ['caller', '¿puedo pagar con tarjeta?'],
          ['agent', 'Sí, claro.'],
          ['caller', 'A ver.'],
          ['agent', 'Dígame el código postal.'],
          ['caller', 'dos dos cuatro seis'],
          ['agent', 'Dígame su número de cliente.'],
          ['caller', 'ocho ocho nueve seis tres dos cuatro cinco'],
          ['agent', 'Dígame el año del equipo.'],
          ['caller', '1999'],
        ],
      ],
      [
        'card talk, the callback number asked, "one sec", then 360 read straight on into four more digits',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['agent', "What's a good callback number?"],
          ['caller', 'one sec'],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      [
        'card talk, "okay", "What number should the tech call?", then 360 and four more',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['caller', 'okay'],
          ['agent', 'What number should the tech call?'],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      [
        'card talk, "What is the best number for you?", "One sec.", then 360 and four more',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['agent', 'What is the best number for you?'],
          ['caller', 'One sec.'],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      [
        `card talk, "What's a good number to text you at?", "um", then 360 and four more`,
        [
          ['agent', 'How can I help?'],
          ['caller', 'can I pay with my Visa'],
          ['agent', "What's a good number to text you at?"],
          ['caller', 'um'],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      [
        'en español: tarjeta, "Un momento.", "¿A qué número le podemos llamar?", then 360 and four more',
        [
          ['agent', '¿En qué le puedo ayudar?'],
          ['caller', 'quiero pagar con tarjeta'],
          ['caller', 'Un momento.'],
          ['agent', '¿A qué número le podemos llamar?'],
          ['caller', 'tres seis cero cinco cinco cinco cero cero cero seis dos dos cuatro siete'],
        ],
      ],
      // The ask with a period inside its sentence: an honorific, a clock time.
      [
        'card talk, "okay", "What\'s a good callback number, Dr. Patel?", then 360 and four more',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['caller', 'okay'],
          ['agent', "What's a good callback number, Dr. Patel?"],
          ['caller', 'three six zero five five five zero zero zero six two two four seven'],
        ],
      ],
      [
        'the agent on cards, "okay", the gate code asked "for the 9 a.m. visit", then the answers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'We take all major cards at the visit.'],
          ['caller', 'okay'],
          ['agent', "What's the gate code for the 9 a.m. visit?"],
          ['caller', '4111'],
          ['agent', "What's the lockbox code, Mrs. Lopez?"],
          ['caller', '1111'],
          ['agent', 'And the alarm code... for the tech?'],
          ['caller', '1111'],
          ['agent', 'The house number at 12 Elm St. is?'],
          ['caller', '1111'],
        ],
      ],
      // A hold that asks the caller to fetch another number; card talk and
      // the ask on either side of a Unicode ellipsis.
      [
        'the agent on cards, then "Please hold on while you grab your account number.", "okay", then the number in fours',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'Sure, we take all major cards. Please hold on while you grab your account number.'],
          ['caller', 'okay'],
          ['caller', '4111'],
          ['caller', '1111'],
          ['caller', '1111'],
          ['caller', '1111'],
        ],
      ],
      [
        'en español: tarjeta…¿el código del portón?, "sí", then the answers',
        [
          ['agent', '¿En qué le puedo ayudar?'],
          ['caller', 'necesito que revisen mi aire acondicionado'],
          ['agent', 'Claro, puede pagar con tarjeta en la visita…¿cuál es el código del portón?'],
          ['caller', 'sí'],
          ['caller', '4111'],
          ['caller', '1111'],
          ['caller', '1111'],
          ['caller', '1111'],
        ],
      ],
    ];

    /** The leg said live through the real store, its rows stored as it went. */
    async function liveCall(said: Said) {
      const repo = new InMemoryCallTranscriptTurnRepository();
      const store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
      const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
      const live = vi.spyOn(repo, 'redactCardNumberTurns');
      let ts = 1_000_000;
      for (const [speaker, text] of said) store.appendTranscript(session.id, { speaker, text, ts: (ts += 3000) });
      await session.cardRedactionWrites;
      return { repo, store, session, live };
    }

    it.each(LEGS)('%s', async (_name, said) => {
      const asSaid = said.map(([speaker, text]) => `${speaker}: ${text}`);
      // With the session in memory at the recording, and from the stored rows
      // alone (after a restart, or the callback on another replica).
      for (const fromRowsOnly of [false, true]) {
        const { repo, store, session, live } = await liveCall(said);
        expect(session.transcript, 'live transcript').toEqual(asSaid);
        if (fromRowsOnly) store.dispose();
        const send = vi.fn(async () => 'msg-1');
        const markCardNumberDetected = vi.fn(async () => undefined);
        const hook = createRecordingTranscriptHook({
          store: fromRowsOnly ? { findByCallSidIncludingEnded: () => undefined } : store,
          callTranscriptTurnRepo: repo,
          voiceRepo: { markCardNumberDetected },
          auditRepo: new InMemoryAuditRepository(),
          queue: { send },
          logger,
        });
        await hook(event());
        expect(live, 'rows rewritten').not.toHaveBeenCalled();
        expect((await repo.listByCallSid(TENANT, CALL_SID)).map((r) => `${r.speaker}: ${r.text}`), 'stored rows').toEqual(asSaid);
        const [, payload] = send.mock.calls[0] as unknown as [string, { turns: Array<{ speaker: string; text: string }> }];
        expect(payload.turns.map((t) => `${t.speaker}: ${t.text}`), 'ingested').toEqual(asSaid);
        expect(markCardNumberDetected, 'recording flagged for audio purge').not.toHaveBeenCalled();
        if (!fromRowsOnly) store.dispose();
      }
    });
  });
});
