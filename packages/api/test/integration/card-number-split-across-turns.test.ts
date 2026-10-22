/**
 * PRIV-3 follow-up — a card number a caller splits across turns, against real
 * Postgres with RLS_RUNTIME_ROLE on.
 *
 * A caller who pauses mid-number leaves several call_transcript_turns rows,
 * each under 13 digits, which the per-turn scrub cannot see. Driven through
 * the production writer: `VoiceSessionStore.appendTranscript` with the real
 * `PgCallTranscriptTurnRepository` (what build-repositories wires), so the
 * mid-call inserts and the cross-turn rewrite are the shipped SQL on the real
 * columns (the mocked-pool trap in
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md).
 *
 * The shared container holds rows from other integration files, so only
 * row-level assertions on this file's own tenants, calls and sessions are
 * made.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  closeSharedTestDb,
  createTestFile,
  createTestTenant,
  getSharedTestDb,
  RLS_APP_ROLE,
  type TestTenant,
} from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import {
  CARD_NUMBER_SPLIT_REDACTED_EVENT,
  type CallTranscriptTurn,
} from '../../src/voice/call-transcript-turn';
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../../src/ai/agents/customer-calling/voice-session-store';
import { callerTranscriptText } from '../../src/ai/voice-turn/transcript-append';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { recordInboundCall } from '../../src/voice/voice-service';
import { createRecordingTranscriptHook } from '../../src/telephony/recording-transcript-hook';
import {
  createTranscriptIngestionWorker,
  type TranscriptIngestionPayload,
} from '../../src/workers/transcript-ingestion-worker';
import { PgKnowledgeChunkRepository } from '../../src/ai/training/knowledge-chunks';
import { createLogger } from '../../src/logging/logger';

const MARKER = '[card number]';

let pool: Pool;
let repo: PgCallTranscriptTurnRepository;
let store: VoiceSessionStore;
let tenant: TestTenant;
let otherTenant: TestTenant;

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new PgCallTranscriptTurnRepository(pool);
  store = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
  tenant = await createTestTenant(pool);
  otherTenant = await createTestTenant(pool);
});

afterAll(async () => {
  store.dispose();
  await closeSharedTestDb();
});

function newCallSid(): string {
  return `CA${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Run `fn` as the app's least-privilege runtime role under `tenantId`'s
 * context (mirrors src/db/tenant-transaction.ts), always rolled back. Queries
 * inside carry NO tenant filter of their own, so only RLS can hide a row.
 */
async function asTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** One live call leg: every line through the production append path. */
function say(session: VoiceSession, lines: ReadonlyArray<readonly ['agent' | 'caller', string]>): void {
  for (const [speaker, spoken] of lines) {
    store.appendTranscript(session.id, {
      speaker,
      text: speaker === 'caller' ? callerTranscriptText(session, spoken) : spoken,
      ts: Date.now(),
    });
  }
}

/**
 * Agent rows are fire-and-forget inserts nothing retains a promise for, so
 * wait until every line of the leg has its row; then the session's rewrite
 * chain (behind the caller inserts) has settled too.
 */
async function settled(session: VoiceSession, t: TestTenant = tenant): Promise<CallTranscriptTurn[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await session.cardRedactionWrites;
    const rows = (await repo.listByCallSid(t.tenantId, session.callSid!)).filter(
      (r) => r.sessionId === session.id,
    );
    if (rows.length === session.transcript.length) return rows;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`rows for session ${session.id} never all landed`);
}

describe('PRIV-3 follow-up — a card number split across caller turns (real Postgres, RLS on)', () => {
  it("the third caller turn completes a card: all three caller rows end redacted with the agent's repeat of one, other agent rows and sessions untouched", async () => {
    const callSid = newCallSid();
    const session = store.create(tenant.tenantId, 'telephony', { callSid });
    // Another leg of the SAME call (gather fallback after a restart) holding
    // digits of its own, another call of the same tenant, and another
    // tenant's call under the very same CallSid.
    const otherLeg = store.create(tenant.tenantId, 'telephony', { callSid });
    const otherCall = store.create(tenant.tenantId, 'telephony', { callSid: newCallSid() });
    const otherTenantCall = store.create(otherTenant.tenantId, 'telephony', { callSid });

    say(otherLeg, [['caller', 'my account is 4111 1111']]);
    say(otherCall, [['caller', 'my card is 4111 1111'], ['agent', 'go on']]);
    say(otherTenantCall, [['caller', 'it is 4111 1111']]);
    say(session, [
      ['agent', 'Thanks for calling Acme Plumbing, how can I help?'],
      ['caller', 'can I pay now, my card is 4111 1111'],
      ['agent', 'go on'],
      ['caller', '1111'],
      ['agent', 'and the last four, 1111?'],
      ['caller', '1111 thanks'],
    ]);

    const rows = await settled(session);
    expect(rows.map((r) => [r.turnIndex, r.speaker, r.text])).toEqual([
      [0, 'agent', 'Thanks for calling Acme Plumbing, how can I help?'],
      [1, 'caller', `can I pay now, my card is ${MARKER}`],
      [2, 'agent', 'go on'],
      [3, 'caller', MARKER],
      // The agent repeated the group the caller had just said.
      [4, 'agent', `and the last four, ${MARKER}?`],
      [5, 'caller', `${MARKER} thanks`],
    ]);
    // The in-memory history the next prompt is built from says the same.
    expect(session.transcript.filter((l) => l.startsWith('caller: '))).toEqual([
      `caller: can I pay now, my card is ${MARKER}`,
      `caller: ${MARKER}`,
      `caller: ${MARKER} thanks`,
    ]);

    expect((await settled(otherLeg)).map((r) => r.text)).toEqual(['my account is 4111 1111']);
    expect((await settled(otherCall)).map((r) => r.text)).toEqual(['my card is 4111 1111', 'go on']);
    expect((await settled(otherTenantCall, otherTenant)).map((r) => r.text)).toEqual(['it is 4111 1111']);

    // RLS for real: as the runtime role, with no tenant filter in the query,
    // the other tenant's context sees none of this session's rows and, under
    // the shared CallSid, only its own one; this tenant's context sees all six.
    const bySession = `SELECT text FROM call_transcript_turns WHERE session_id = $1`;
    const byCallSid = `SELECT text FROM call_transcript_turns WHERE call_sid = $1`;
    expect((await asTenant(otherTenant.tenantId, (c) => c.query(bySession, [session.id]))).rows).toEqual([]);
    expect((await asTenant(otherTenant.tenantId, (c) => c.query(byCallSid, [callSid]))).rows).toEqual([
      { text: 'it is 4111 1111' },
    ]);
    expect((await asTenant(tenant.tenantId, (c) => c.query(bySession, [session.id]))).rows).toHaveLength(6);
    // Nor can that context rewrite them.
    const update = await asTenant(otherTenant.tenantId, (c) =>
      c.query(`UPDATE call_transcript_turns SET text = 'x' WHERE session_id = $1`, [session.id]),
    );
    expect(update.rowCount).toBe(0);

    // One audit row for the rewrite, in the same tenant, with no text in it.
    const { rows: audits } = await pool.query(
      `SELECT tenant_id, actor_role, entity_type, metadata
         FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, session.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: tenant.tenantId,
      actor_role: 'system',
      entity_type: 'voice_session',
      // The caller rows that held the card, and the agent's repeat of a group.
      metadata: { callSid, turnIndexes: [1, 3, 4, 5], rows: 4 },
    });
    expect(JSON.stringify(audits[0].metadata)).not.toContain('1111');
  });

  // The agent's confirm readback renders what the classifier took from the
  // turn: its row holds the card's first part too, and is rewritten in the
  // same transaction as the caller's.
  it("rewrites the agent's stored readback of the card's first part with the caller's rows", async () => {
    const callSid = newCallSid();
    const session = store.create(tenant.tenantId, 'telephony', { callSid });
    say(session, [
      ['caller', 'add a note for Dana, the card on file is 4111 1111 1111'],
      ['agent', 'Just to confirm: a note for Dana, the card on file is 4111 1111 1111. Is that right?'],
      ['caller', "1111. Yes, that's right."],
      ['agent', 'Done.'],
    ]);
    const rows = await settled(session);
    expect(rows.map((r) => [r.turnIndex, r.speaker, r.text])).toEqual([
      [0, 'caller', `add a note for Dana, the card on file is ${MARKER}`],
      [1, 'agent', `Just to confirm: a note for Dana, the card on file is ${MARKER}. Is that right?`],
      [2, 'caller', `${MARKER}. Yes, that's right.`],
      [3, 'agent', 'Done.'],
    ]);
    const { rows: audits } = await pool.query(
      `SELECT metadata FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, session.id],
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ callSid, turnIndexes: [0, 1, 2], rows: 3 }]);
  });

  // A group of four per caller turn is also how gate codes and years are
  // answered: it is stitched only where the card is mentioned, here by the
  // agent's line between the turns.
  it("stitches a card read a group per turn where the agent mentions it, and leaves the same groups given as codes", async () => {
    const agentOnCard = "Sorry, I can't take card numbers over the phone.";
    const card = store.create(tenant.tenantId, 'telephony', { callSid: newCallSid() });
    say(card, [['caller', '4111'], ['agent', agentOnCard], ['caller', '1111'], ['caller', '1111'], ['caller', '1111']]);
    expect((await settled(card)).map((r) => r.text)).toEqual([MARKER, agentOnCard, MARKER, MARKER, MARKER]);

    const codes = store.create(tenant.tenantId, 'telephony', { callSid: newCallSid() });
    say(codes, [['agent', 'What is the gate code?'], ['caller', '4111'], ['caller', '1111'], ['caller', '1111'], ['caller', '1111']]);
    expect((await settled(codes)).map((r) => r.text)).toEqual(['What is the gate code?', '4111', '1111', '1111', '1111']);
  });

  it("rewrites by the mid-call key when no row id is known, a row only as its own speaker's, never a row a recording claimed", async () => {
    const callSid = newCallSid();
    const sessionId = crypto.randomUUID();
    const seed = async (turnIndex: number, speaker: 'agent' | 'caller', text: string) =>
      repo.recordTurn({ tenantId: tenant.tenantId, callSid, sessionId, turnIndex, speaker, text });
    await seed(0, 'caller', '4111 1111');
    const agent = await seed(1, 'agent', '1111');

    const rewritten = await repo.redactCardNumberTurns({
      tenantId: tenant.tenantId,
      callSid,
      sessionId,
      actorId: 'voice-session-store',
      turns: [
        { turnIndex: 0, text: MARKER },
        // An agent row is never rewritten as a caller's, by key or by id.
        { turnIndex: 1, text: MARKER },
        { id: agent.id, turnIndex: 1, text: MARKER },
        // Nor a caller row as an agent's.
        { turnIndex: 0, speaker: 'agent', text: 'x' },
      ],
    });
    expect(rewritten).toBe(1);
    const rows = await repo.listByCallSid(tenant.tenantId, callSid);
    expect(rows.map((r) => r.text)).toEqual([MARKER, '1111']);
    // Named as the agent's, it is.
    expect(
      await repo.redactCardNumberTurns({
        tenantId: tenant.tenantId,
        callSid,
        sessionId,
        actorId: 'voice-session-store',
        turns: [{ id: agent.id, turnIndex: 1, speaker: 'agent', text: `you said ${MARKER}` }],
      }),
    ).toBe(1);
    expect((await repo.listByCallSid(tenant.tenantId, callSid)).map((r) => r.text)).toEqual([MARKER, `you said ${MARKER}`]);

    // Once a recording claims the call's rows (renumbered at end of call), a
    // mid-call index no longer names a row: a key-only rewrite touches none.
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const recording = await new PgVoiceRepository(pool).create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      fileId,
      status: 'pending',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await seed(2, 'caller', '1111 1111');
    expect(await repo.attachRecording(tenant.tenantId, callSid, recording.id)).toBe(3);
    expect(
      await repo.redactCardNumberTurns({
        tenantId: tenant.tenantId,
        callSid,
        sessionId,
        actorId: 'voice-session-store',
        turns: [{ turnIndex: 2, text: MARKER }],
      }),
    ).toBe(0);
    expect((await repo.listByCallSid(tenant.tenantId, callSid)).map((r) => r.text)).toEqual([
      MARKER,
      `you said ${MARKER}`,
      '1111 1111',
    ]);

    // Under another tenant nothing is rewritten (RLS itself is proven with no
    // tenant filter in the first test).
    expect(
      await repo.redactCardNumberTurns({
        tenantId: otherTenant.tenantId,
        callSid,
        sessionId,
        actorId: 'voice-session-store',
        turns: [{ turnIndex: 1, text: 'x' }],
      }),
    ).toBe(0);
  });

  it('is one transaction: a failing row leaves every row of the rewrite as it was, with no audit row', async () => {
    const callSid = newCallSid();
    const sessionId = crypto.randomUUID();
    const first = await repo.recordTurn({
      tenantId: tenant.tenantId,
      callSid,
      sessionId,
      turnIndex: 0,
      speaker: 'caller',
      text: '4111 1111',
    });
    await expect(
      repo.redactCardNumberTurns({
        tenantId: tenant.tenantId,
        callSid,
        sessionId,
        actorId: 'voice-session-store',
        turns: [
          { id: first.id, turnIndex: 0, text: MARKER },
          // Not a uuid: Postgres rejects the second UPDATE.
          { id: 'not-a-row-id', turnIndex: 1, text: MARKER },
        ],
      }),
    ).rejects.toThrow();
    const rows = await repo.listByCallSid(tenant.tenantId, callSid);
    expect(rows.map((r) => r.text)).toEqual(['4111 1111']);
    const { rows: audits } = await pool.query(
      `SELECT 1 FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, sessionId],
    );
    expect(audits).toHaveLength(0);
  });
});

/**
 * PRIV-3 (durability) — the live rewrite of the stored rows is fire-and-forget.
 * When it fails, the completing turn's row is already the marker and the
 * earlier rows keep their fragments, which no longer read as a card. The
 * recording webhook's transcript hook must leave neither call_transcript_turns
 * nor what it hands the ingestion worker (and so knowledge_chunks) holding
 * them. Real store, real hook, real worker, real Postgres, RLS role on.
 */
describe('PRIV-3 follow-up — the recording hook clears a split card whose live rewrite failed (real Postgres)', () => {
  const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
  const FRAGMENTS = /4111|\b1111\b/;

  it('rewrites the rows in one audited transaction, and neither the ingestion payload nor knowledge_chunks carries a fragment', async () => {
    const t = await createTestTenant(pool);
    const callSid = newCallSid();
    // The live store writes through a repository whose card rewrite fails.
    const failingRewrite = {
      recordTurn: repo.recordTurn.bind(repo),
      markReplyAudio: repo.markReplyAudio.bind(repo),
      redactCardNumberTurns: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    };
    const liveStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: failingRewrite });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = liveStore.create(t.tenantId, 'telephony', { callSid });
    try {
      for (const [speaker, spoken] of [
        ['agent', 'Thanks for calling Acme Plumbing, how can I help?'],
        ['caller', 'can I pay now, my card is 4111 1111'],
        ['agent', 'go on'],
        ['caller', '1111'],
        ['agent', 'and the rest?'],
        ['caller', '1111 thanks'],
      ] as const) {
        liveStore.appendTranscript(session.id, {
          speaker,
          text: speaker === 'caller' ? callerTranscriptText(session, spoken) : spoken,
          ts: Date.now(),
        });
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        await session.cardRedactionWrites;
        if ((await repo.listByCallSid(t.tenantId, callSid)).length === 6) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    } finally {
      consoleError.mockRestore();
    }
    expect(failingRewrite.redactCardNumberTurns).toHaveBeenCalledTimes(1);
    // The live rewrite failed: the rows hold the fragments.
    expect((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text)).toEqual([
      'Thanks for calling Acme Plumbing, how can I help?',
      'can I pay now, my card is 4111 1111',
      'go on',
      '1111',
      'and the rest?',
      `${MARKER} thanks`,
    ]);

    // Hangup → Twilio's recording webhook: the row insert, then its hook.
    const { voiceRecordingId, inserted } = await recordInboundCall(pool, {
      tenantId: t.tenantId,
      callSid,
      recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${crypto.randomUUID().replace(/-/g, '')}`,
      durationSeconds: 30,
      storageBucket: 'test-bucket',
      storageKey: `${t.tenantId}/${callSid}.mp3`,
      sizeBytes: 1024,
      contentType: 'audio/mpeg',
    });
    expect(inserted).toBe(true);
    const voiceRepo = new PgVoiceRepository(pool);
    const sent: TranscriptIngestionPayload[] = [];
    const hook = createRecordingTranscriptHook({
      store: liveStore,
      callTranscriptTurnRepo: repo,
      voiceRepo,
      auditRepo: new PgAuditRepository(pool),
      queue: {
        send: async (_type: string, payload: unknown) => {
          sent.push(payload as TranscriptIngestionPayload);
          return 'msg-1';
        },
      },
      logger,
    });
    await hook({ tenantId: t.tenantId, voiceRecordingId, callSid, durationSeconds: 30, inserted: true });

    // call_transcript_turns: every caller row that held part of the card.
    const rows = await repo.listByRecording(t.tenantId, voiceRecordingId);
    expect(rows.map((r) => [r.speaker, r.text])).toEqual([
      ['agent', 'Thanks for calling Acme Plumbing, how can I help?'],
      ['caller', `can I pay now, my card is ${MARKER}`],
      ['agent', 'go on'],
      ['caller', MARKER],
      ['agent', 'and the rest?'],
      ['caller', `${MARKER} thanks`],
    ]);
    const { rows: audits } = await pool.query(
      `SELECT tenant_id, actor_id, metadata FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, session.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenant_id: t.tenantId, actor_id: 'recording_webhook' });
    expect(JSON.stringify(audits[0].metadata)).not.toMatch(FRAGMENTS);
    expect(session.unwrittenCardRedactions).toEqual([]);

    // The ingestion payload, and the recording flagged for its audio purge.
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].turns)).not.toMatch(FRAGMENTS);
    expect(sent[0].turns.filter((turn) => turn.speaker === 'caller').map((turn) => turn.text)).toEqual([
      `can I pay now, my card is ${MARKER}`,
      MARKER,
      `${MARKER} thanks`,
    ]);
    const { rows: recording } = await pool.query(
      `SELECT pci_detected FROM voice_recordings WHERE tenant_id = $1 AND id = $2`,
      [t.tenantId, voiceRecordingId],
    );
    expect(recording[0].pci_detected).toBe(true);

    // The worker it is handed to: knowledge_chunks and the rows it upserts.
    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo: repo,
      voiceRepo,
      knowledgeChunkRepo: new PgKnowledgeChunkRepository(pool),
      embeddings: {
        name: 'fake',
        createEmbedding: async () => ({
          embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
          model: 'text-embedding-3-small',
          tokenUsage: 1,
          latencyMs: 1,
        }),
      },
    });
    await worker.handle(
      {
        id: 'msg-1',
        type: 'transcript_ingestion',
        payload: sent[0],
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: `transcript:${voiceRecordingId}:v1`,
        createdAt: new Date().toISOString(),
      },
      logger,
    );
    const { rows: chunks } = await pool.query(
      `SELECT content, content_scrubbed FROM knowledge_chunks WHERE tenant_id = $1 AND source_id LIKE $2`,
      [t.tenantId, `${voiceRecordingId}%`],
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(JSON.stringify(chunks)).toContain(MARKER);
    expect(JSON.stringify(chunks)).not.toMatch(FRAGMENTS);
    expect(JSON.stringify((await repo.listByRecording(t.tenantId, voiceRecordingId)).map((r) => r.text))).not.toMatch(
      FRAGMENTS,
    );
    liveStore.dispose();
  });
});
