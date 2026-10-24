/**
 * PRIV-3 (durability) — a split card's failed live rewrite survives a
 * restart, against real Postgres with RLS_RUNTIME_ROLE on.
 *
 * The live rewrite of the earlier rows is fire-and-forget. When it failed,
 * the rewrite used to live only in the session's memory
 * (`unwrittenCardRedactions`), for the recording hook: a restart or deploy
 * before the recording callback, or a call with no recording at all, left
 * the card's fragments in call_transcript_turns for good (the completing row
 * was stored as the marker, so no re-read of the rows can find the card
 * again). The store now hands every rewrite to the durable queue (P0-009)
 * before its live write, and the retry worker writes it. The recording hook
 * reads what is still queued for the call, so a callback that lands on the
 * fresh process before its poll loop has run the job ingests clean rows; and
 * the ingestion upsert never puts text with fewer card markers back over a
 * row, so a snapshot read before the rewrite landed cannot undo it.
 *
 * Production pieces: `VoiceSessionStore` with the real
 * `PgCallTranscriptTurnRepository` and `PgQueue`, the real retry worker run
 * through `processMessage` (the poll loop's per-message path). Only the
 * first live rewrite is made to fail. The shared container holds rows from
 * other files, so assertions are on this file's own tenant, call and
 * session; the queue is left as found (queue.test.ts relies on it empty).
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { CARD_NUMBER_SPLIT_REDACTED_EVENT } from '../../src/voice/call-transcript-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { callerTranscriptText } from '../../src/ai/voice-turn/transcript-append';
import { PgQueue } from '../../src/queues/pg-queue';
import { processMessage, type QueueMessage } from '../../src/queues/queue';
import {
  CARD_NUMBER_REWRITE_RETRY_JOB,
  createCardNumberRewriteRetryWorker,
  pendingCardNumberRewrites,
  type CardNumberRewriteRetryJob,
} from '../../src/voice/card-number-rewrite-retry';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { recordInboundCall } from '../../src/voice/voice-service';
import { createRecordingTranscriptHook } from '../../src/telephony/recording-transcript-hook';
import {
  createTranscriptIngestionWorker,
  type TranscriptIngestionPayload,
} from '../../src/workers/transcript-ingestion-worker';
import { PgKnowledgeChunkRepository } from '../../src/ai/training/knowledge-chunks';

const MARKER = '[card number]';
/** The fresh processes' stores and the sessions whose retry jobs the tests leave queued, cleaned up after each. */
const stores: VoiceSessionStore[] = [];
const queuedFor: string[] = [];
const FRAGMENTS = /4111|(?<!\d)1111(?!\d)/;
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

type JobRow = {
  id: string;
  type: string;
  payload: CardNumberRewriteRetryJob;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  created_at: Date;
};

/** The retry jobs still queued for a session, oldest first. */
async function queuedJobs(sessionId: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, type, payload, attempts, max_attempts, idempotency_key, created_at
       FROM _queue_messages WHERE type = $1 AND payload->>'sessionId' = $2
      ORDER BY created_at`,
    [CARD_NUMBER_REWRITE_RETRY_JOB, sessionId],
  );
  return rows;
}

/**
 * The jobs a failed live rewrite leaves: one queued in the tick the
 * completing turn was appended, before the rows' inserts had landed (by the
 * mid-call key), and one once the live write failed (by the rows' ids, which
 * a recording claiming the rows leaves as they are). Both hold only
 * already-redacted text.
 */
function expectQueuedTwice(jobs: JobRow[]): void {
  expect(jobs.map((job) => job.payload.turns.map((turn) => [turn.id !== undefined, turn.turnIndex]))).toEqual([
    [
      [false, 1],
      [false, 3],
      [false, 5],
    ],
    [
      [true, 1],
      [true, 3],
      [true, 5],
    ],
  ]);
  for (const job of jobs) {
    expect(job.payload.turns.map((turn) => turn.text)).toEqual([`my card is ${MARKER}`, MARKER, `${MARKER} thanks`]);
    expect(withoutRandomIds(job.payload)).not.toMatch(/4111|1111/);
  }
}

/** A job's payload with its random ids left out: a tenant, CallSid, session or row id is hex that can hold "1111". */
function withoutRandomIds(payload: CardNumberRewriteRetryJob): string {
  return JSON.stringify(payload, (key, value: unknown) => (['tenantId', 'callSid', 'sessionId', 'id'].includes(key) ? undefined : value));
}

/** A fresh process's poll loop: claims the job and runs the real worker through `processMessage`. */
async function runRetryWorker(queue: PgQueue, job: JobRow): Promise<void> {
  const worker = createCardNumberRewriteRetryWorker({
    callTranscriptTurnRepo: new PgCallTranscriptTurnRepository(pool),
    auditRepo: new PgAuditRepository(pool),
  });
  const claimed: QueueMessage<CardNumberRewriteRetryJob> = {
    id: job.id,
    type: job.type,
    payload: job.payload,
    attempts: job.attempts + 1,
    maxAttempts: job.max_attempts,
    idempotencyKey: job.idempotency_key,
    createdAt: job.created_at.toISOString(),
  };
  expect(await processMessage(claimed, worker, logger)).toEqual({ success: true });
  await queue.delete(claimed.id);
}

/**
 * A live call whose rewrite of the stored rows fails, then a restart: the
 * process holding the session (and its in-memory list of what did not land)
 * is gone. Returns the call and its recording, inserted by the webhook.
 */
async function failedLiveRewriteThenRestart(queue: PgQueue) {
  const t = await createTestTenant(pool);
  const callSid = `CA${crypto.randomUUID().replace(/-/g, '')}`;
  const failing = {
    recordTurn: repo.recordTurn.bind(repo),
    markReplyAudio: repo.markReplyAudio.bind(repo),
    redactCardNumberTurns: vi.fn(async () => {
      throw new Error('connection terminated unexpectedly');
    }),
  };
  const liveStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: failing, cardRewriteRetryQueue: queue });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const session = liveStore.create(t.tenantId, 'telephony', { callSid });
  try {
    for (const [speaker, spoken] of [
      ['agent', 'Thanks for calling, how can I help?'],
      ['caller', 'my card is 4111 1111'],
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
  expect(failing.redactCardNumberTurns).toHaveBeenCalledTimes(1);
  expect((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text)).toEqual([
    'Thanks for calling, how can I help?',
    'my card is 4111 1111',
    'go on',
    '1111',
    'and the rest?',
    `${MARKER} thanks`,
  ]);
  const sessionId = session.id;
  queuedFor.push(sessionId);
  liveStore.dispose();
  const { voiceRecordingId } = await recordInboundCall(pool, {
    tenantId: t.tenantId,
    callSid,
    recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${crypto.randomUUID().replace(/-/g, '')}`,
    durationSeconds: 30,
    storageBucket: 'test-bucket',
    storageKey: `${t.tenantId}/${callSid}.mp3`,
    sizeBytes: 1024,
    contentType: 'audio/mpeg',
  });
  return { tenantId: t.tenantId, callSid, sessionId, voiceRecordingId };
}

/** The recording webhook's hook on the fresh process, collecting what it hands the ingestion worker. */
function freshProcessHook(withPendingRewrites: PgQueue | undefined) {
  const freshStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
  stores.push(freshStore);
  const sent: TranscriptIngestionPayload[] = [];
  const hook = createRecordingTranscriptHook({
    store: freshStore,
    callTranscriptTurnRepo: repo,
    voiceRepo: new PgVoiceRepository(pool),
    auditRepo: new PgAuditRepository(pool),
    queue: {
      send: async (_type: string, payload: unknown) => {
        sent.push(payload as TranscriptIngestionPayload);
        return 'msg-ingest';
      },
    },
    ...(withPendingRewrites ? { pendingCardNumberRewrites: pendingCardNumberRewrites(withPendingRewrites) } : {}),
    logger,
  });
  return { hook, sent };
}

/** The transcript-ingestion worker run on what the hook enqueued. */
async function ingest(payload: TranscriptIngestionPayload): Promise<void> {
  const worker = createTranscriptIngestionWorker({
    callTranscriptTurnRepo: repo,
    voiceRepo: new PgVoiceRepository(pool),
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
      id: 'msg-ingest',
      type: 'transcript_ingestion',
      payload,
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: `transcript:${payload.voiceRecordingId}:v1`,
      createdAt: new Date().toISOString(),
    },
    logger,
  );
}

async function chunksOf(tenantId: string, voiceRecordingId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT content, content_scrubbed FROM knowledge_chunks WHERE tenant_id = $1 AND source_id LIKE $2`,
    [tenantId, `${voiceRecordingId}%`],
  );
  expect(rows.length).toBeGreaterThan(0);
  return JSON.stringify(rows);
}

let pool: Pool;
let repo: PgCallTranscriptTurnRepository;

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new PgCallTranscriptTurnRepository(pool);
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  // The queue is left as found (queue.test.ts relies on it empty).
  for (const sessionId of queuedFor.splice(0)) {
    await pool.query(`DELETE FROM _queue_messages WHERE type = $1 AND payload->>'sessionId' = $2`, [
      CARD_NUMBER_REWRITE_RETRY_JOB,
      sessionId,
    ]);
  }
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('PRIV-3 — a failed live card rewrite is retried by the durable worker after a restart (real Postgres)', () => {
  it('the rows end clean with one audit row, and the job held no digit of the card', async () => {
    const t = await createTestTenant(pool);
    const callSid = `CA${crypto.randomUUID().replace(/-/g, '')}`;
    const queue = new PgQueue(pool, { maxRetries: 3 });
    const failingOnce = {
      recordTurn: repo.recordTurn.bind(repo),
      markReplyAudio: repo.markReplyAudio.bind(repo),
      redactCardNumberTurns: vi.fn(async () => {
        throw new Error('connection terminated unexpectedly');
      }),
    };
    const liveStore = new VoiceSessionStore({
      startInterval: false,
      callTranscriptTurnRepo: failingOnce,
      cardRewriteRetryQueue: queue,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = liveStore.create(t.tenantId, 'telephony', { callSid });
    const sessionId = session.id;
    try {
      for (const [speaker, spoken] of [
        ['agent', 'Thanks for calling Acme Plumbing, how can I help?'],
        ['caller', 'my card is 4111 1111'],
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
    expect(failingOnce.redactCardNumberTurns).toHaveBeenCalledTimes(1);
    // The live rewrite failed: the earlier rows hold the card's fragments.
    expect((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text)).toEqual([
      'Thanks for calling Acme Plumbing, how can I help?',
      'my card is 4111 1111',
      'go on',
      '1111',
      'and the rest?',
      `${MARKER} thanks`,
    ]);

    // Restart: the process holding the session (and its in-memory list of
    // rewrites that did not land) is gone.
    liveStore.dispose();

    // The jobs are in the queue table, holding only already-redacted text.
    const jobs = await queuedJobs(sessionId);
    expectQueuedTwice(jobs);

    // A fresh process's poll loop claims the first and runs the worker: the
    // rows are still unclaimed by a recording, so their mid-call key finds
    // them.
    const worker = createCardNumberRewriteRetryWorker({
      callTranscriptTurnRepo: new PgCallTranscriptTurnRepository(pool),
      auditRepo: new PgAuditRepository(pool),
    });
    const claimed: QueueMessage<CardNumberRewriteRetryJob> = {
      id: jobs[0].id,
      type: jobs[0].type,
      payload: jobs[0].payload,
      attempts: jobs[0].attempts + 1,
      maxAttempts: jobs[0].max_attempts,
      idempotencyKey: jobs[0].idempotency_key,
      createdAt: jobs[0].created_at.toISOString(),
    };
    const result = await processMessage(
      claimed,
      worker,
      createLogger({ service: 'test', environment: 'test', level: 'error' }),
    );
    expect(result).toEqual({ success: true });
    await queue.delete(claimed.id);

    expect((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text)).toEqual([
      'Thanks for calling Acme Plumbing, how can I help?',
      `my card is ${MARKER}`,
      'go on',
      MARKER,
      'and the rest?',
      `${MARKER} thanks`,
    ]);
    const { rows: audits } = await pool.query(
      `SELECT tenant_id, actor_id, metadata FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, sessionId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: t.tenantId,
      actor_id: 'card-number-rewrite-retry',
      // The completing row was stored rewritten; the two earlier ones change.
      metadata: { callSid, turnIndexes: [1, 3], rows: 2 },
    });

    // Run again (a redelivery): nothing changes, and no second audit row.
    expect(await processMessage({ ...claimed, attempts: claimed.attempts + 1 }, worker, createLogger({ service: 'test', environment: 'test', level: 'error' }))).toEqual({
      success: true,
    });
    // The second, by id, has nothing left to do either.
    await runRetryWorker(queue, jobs[1]);
    const { rows: again } = await pool.query(
      `SELECT 1 FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
      [CARD_NUMBER_SPLIT_REDACTED_EVENT, sessionId],
    );
    expect(again).toHaveLength(1);
    const { rows: left } = await pool.query(
      `SELECT 1 FROM _queue_messages WHERE type = $1 AND payload->>'sessionId' = $2`,
      [CARD_NUMBER_REWRITE_RETRY_JOB, sessionId],
    );
    expect(left).toHaveLength(0);
  });

  // The recording callback lands on the fresh process before its poll loop
  // has run the retry: no session in memory, and the completing row is the
  // marker, so no re-read of the rows can find the card. The hook reads the
  // rewrites still queued for the call and writes them before anything is
  // ingested; the worker then has nothing left to do.
  it('a restart, then the recording callback before the retry worker: rows, the ingestion payload and knowledge_chunks end clean', async () => {
    const queue = new PgQueue(pool, { maxRetries: 3 });
    const call = await failedLiveRewriteThenRestart(queue);
    const { hook, sent } = freshProcessHook(queue);
    {
      await hook({ tenantId: call.tenantId, voiceRecordingId: call.voiceRecordingId, callSid: call.callSid, durationSeconds: 30, inserted: true });

      expect(sent).toHaveLength(1);
      expect(sent[0].turns.filter((turn) => turn.speaker === 'caller').map((turn) => turn.text)).toEqual([
        `my card is ${MARKER}`,
        MARKER,
        `${MARKER} thanks`,
      ]);
      expect(JSON.stringify(sent[0].turns)).not.toMatch(FRAGMENTS);
      const rows = () => repo.listByRecording(call.tenantId, call.voiceRecordingId);
      expect(JSON.stringify((await rows()).map((r) => r.text))).not.toMatch(FRAGMENTS);

      // The poll loop then runs the jobs: no-ops, and no second audit row.
      const jobs = await queuedJobs(call.sessionId);
      expectQueuedTwice(jobs);
      for (const job of jobs) await runRetryWorker(queue, job);
      const { rows: audits } = await pool.query(
        `SELECT actor_id FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
        [CARD_NUMBER_SPLIT_REDACTED_EVENT, call.sessionId],
      );
      expect(audits).toEqual([{ actor_id: 'recording_webhook' }]);

      await ingest(sent[0]);
      expect((await rows()).map((r) => r.text)).toEqual([
        'Thanks for calling, how can I help?',
        `my card is ${MARKER}`,
        'go on',
        MARKER,
        'and the rest?',
        `${MARKER} thanks`,
      ]);
      const chunks = await chunksOf(call.tenantId, call.voiceRecordingId);
      expect(chunks).toContain(MARKER);
      expect(chunks).not.toMatch(FRAGMENTS);
    }
  });

  // The completing row is stored as the marker, so its insert waits for the
  // queue's send to commit: sent side by side, a process that died after the
  // insert committed and before the send did left the earlier rows' fragments
  // with no job. Here the process dies at that insert (it never lands), and
  // never gets to the live write; no recording ever comes.
  it('the process dies at the completing row insert, after the send: the job is already committed and alone cleans the rows', async () => {
    const t = await createTestTenant(pool);
    const callSid = `CA${crypto.randomUUID().replace(/-/g, '')}`;
    const queue = new PgQueue(pool, { maxRetries: 3 });
    let sessionId = '';
    const jobsAtCompletingInsert: number[] = [];
    const dying = {
      recordTurn: async (input: Parameters<PgCallTranscriptTurnRepository['recordTurn']>[0]) => {
        if (input.turnIndex !== 5) return repo.recordTurn(input);
        jobsAtCompletingInsert.push((await queuedJobs(sessionId)).length);
        return new Promise<never>(() => undefined);
      },
      markReplyAudio: repo.markReplyAudio.bind(repo),
      redactCardNumberTurns: vi.fn(() => new Promise<number>(() => undefined)),
    };
    // A send that takes a while to commit (a busy pool): the insert must not overtake it.
    const slowSend: Pick<PgQueue, 'send'> = {
      send: async (...args: Parameters<PgQueue['send']>) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        return queue.send(...args);
      },
    };
    const liveStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: dying, cardRewriteRetryQueue: slowSend });
    const session = liveStore.create(t.tenantId, 'telephony', { callSid });
    sessionId = session.id;
    queuedFor.push(sessionId);
    for (const [speaker, spoken] of [
      ['agent', 'Thanks for calling, how can I help?'],
      ['caller', 'my card is 4111 1111'],
      ['agent', 'go on'],
      ['caller', '1111'],
      ['agent', 'and the rest?'],
    ] as const) {
      liveStore.appendTranscript(session.id, { speaker, text: speaker === 'caller' ? callerTranscriptText(session, spoken) : spoken, ts: Date.now() });
    }
    for (let attempt = 0; attempt < 100 && (await repo.listByCallSid(t.tenantId, callSid)).length < 5; attempt++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    liveStore.appendTranscript(session.id, { speaker: 'caller', text: callerTranscriptText(session, '1111 thanks'), ts: Date.now() });
    for (let attempt = 0; attempt < 100 && jobsAtCompletingInsert.length === 0; attempt++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    // Committed before the completing row's insert was even issued.
    expect(jobsAtCompletingInsert).toEqual([1]);
    liveStore.dispose();
    expect((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text)).toEqual([
      'Thanks for calling, how can I help?',
      'my card is 4111 1111',
      'go on',
      '1111',
      'and the rest?',
    ]);
    const jobs = await queuedJobs(sessionId);
    expect(jobs.map((job) => job.payload.turns)).toEqual([
      [
        { turnIndex: 1, text: `my card is ${MARKER}` },
        { turnIndex: 3, text: MARKER },
        { turnIndex: 5, text: `${MARKER} thanks` },
      ],
    ]);
    await runRetryWorker(queue, jobs[0]);
    expect(JSON.stringify((await repo.listByCallSid(t.tenantId, callSid)).map((r) => r.text))).not.toMatch(FRAGMENTS);
    const { rows: audits } = await pool.query(`SELECT metadata FROM audit_events WHERE event_type = $1 AND entity_id = $2`, [
      CARD_NUMBER_SPLIT_REDACTED_EVENT,
      sessionId,
    ]);
    expect(audits).toEqual([{ metadata: { callSid, turnIndexes: [1, 3], rows: 2 } }]);
  });

  // Only the rewrite queued before the rows' ids were known is left (the
  // process died before the live write), and the hook's write of it fails:
  // what is ingested is still its redacted text, the rows it names looked up
  // by their mid-call key before the recording claims and renumbers them.
  it('a rewrite queued by turn index only, whose write by the hook fails, is still what is ingested', async () => {
    const t = await createTestTenant(pool);
    const callSid = `CA${crypto.randomUUID().replace(/-/g, '')}`;
    const queue = new PgQueue(pool, { maxRetries: 3 });
    const hanging = {
      recordTurn: repo.recordTurn.bind(repo),
      markReplyAudio: repo.markReplyAudio.bind(repo),
      redactCardNumberTurns: () => new Promise<number>(() => undefined),
    };
    const liveStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: hanging, cardRewriteRetryQueue: queue });
    const session = liveStore.create(t.tenantId, 'telephony', { callSid });
    queuedFor.push(session.id);
    for (const [speaker, spoken] of [
      ['agent', 'Thanks for calling, how can I help?'],
      ['caller', 'my card is 4111 1111'],
      ['agent', 'go on'],
      ['caller', '1111'],
      ['agent', 'and the rest?'],
      ['caller', '1111 thanks'],
    ] as const) {
      liveStore.appendTranscript(session.id, { speaker, text: speaker === 'caller' ? callerTranscriptText(session, spoken) : spoken, ts: Date.now() });
    }
    for (let attempt = 0; attempt < 100 && (await repo.listByCallSid(t.tenantId, callSid)).length < 6; attempt++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    liveStore.dispose();
    expect((await queuedJobs(session.id)).map((job) => job.payload.turns.every((turn) => turn.id === undefined))).toEqual([true]);
    const { voiceRecordingId } = await recordInboundCall(pool, {
      tenantId: t.tenantId,
      callSid,
      recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${crypto.randomUUID().replace(/-/g, '')}`,
      durationSeconds: 30,
      storageBucket: 'test-bucket',
      storageKey: `${t.tenantId}/${callSid}.mp3`,
      sizeBytes: 1024,
      contentType: 'audio/mpeg',
    });
    const freshStore = new VoiceSessionStore({ startInterval: false, callTranscriptTurnRepo: repo });
    stores.push(freshStore);
    const sent: TranscriptIngestionPayload[] = [];
    const failingWrite = {
      attachRecording: repo.attachRecording.bind(repo),
      listByCallSid: repo.listByCallSid.bind(repo),
      redactCardNumberTurns: vi.fn(async () => {
        throw new Error('connection terminated unexpectedly');
      }),
    };
    const hook = createRecordingTranscriptHook({
      store: freshStore,
      callTranscriptTurnRepo: failingWrite,
      voiceRepo: new PgVoiceRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      queue: {
        send: async (_type: string, payload: unknown) => {
          sent.push(payload as TranscriptIngestionPayload);
          return 'msg-ingest';
        },
      },
      pendingCardNumberRewrites: pendingCardNumberRewrites(queue),
      logger,
    });
    await hook({ tenantId: t.tenantId, voiceRecordingId, callSid, durationSeconds: 30, inserted: true });
    expect(failingWrite.redactCardNumberTurns).toHaveBeenCalled();
    // The rows themselves still hold the fragments (the write failed)…
    expect(JSON.stringify((await repo.listByRecording(t.tenantId, voiceRecordingId)).map((r) => r.text))).toMatch(FRAGMENTS);
    // …but what is ingested does not, and the recording is flagged.
    expect(sent).toHaveLength(1);
    expect(sent[0].turns.filter((turn) => turn.speaker === 'caller').map((turn) => turn.text)).toEqual([
      `my card is ${MARKER}`,
      MARKER,
      `${MARKER} thanks`,
    ]);
    const { rows: flagged } = await pool.query(`SELECT pci_detected FROM voice_recordings WHERE id = $1`, [voiceRecordingId]);
    expect(flagged).toEqual([{ pci_detected: true }]);
    // The ingestion upsert then writes the redacted text over the rows.
    await ingest(sent[0]);
    expect(JSON.stringify((await repo.listByRecording(t.tenantId, voiceRecordingId)).map((r) => r.text))).not.toMatch(FRAGMENTS);
  });

  // A hook that cannot see the queued rewrite (a process without the lookup
  // wired) ingests the fragments it read. The retry worker cleans the rows
  // before the ingestion worker upserts that snapshot: the upsert never puts
  // back text with fewer markers than the row holds, and the chunks are built
  // from the rows as stored.
  it('the ingestion upsert never writes the fragments back over rows the retry worker cleaned, nor embeds them', async () => {
    const queue = new PgQueue(pool, { maxRetries: 3 });
    const call = await failedLiveRewriteThenRestart(queue);
    const { hook, sent } = freshProcessHook(undefined);
    {
      await hook({ tenantId: call.tenantId, voiceRecordingId: call.voiceRecordingId, callSid: call.callSid, durationSeconds: 30, inserted: true });
      // What it read: the earlier rows still held the fragments.
      expect(JSON.stringify(sent[0].turns)).toMatch(FRAGMENTS);

      // The recording claimed (and renumbered) the rows: the job queued by
      // their mid-call key finds none, the one by their ids cleans them.
      const jobs = await queuedJobs(call.sessionId);
      expectQueuedTwice(jobs);
      for (const job of jobs) await runRetryWorker(queue, job);
      const rows = () => repo.listByRecording(call.tenantId, call.voiceRecordingId);
      expect(JSON.stringify((await rows()).map((r) => r.text))).not.toMatch(FRAGMENTS);

      await ingest(sent[0]);
      expect((await rows()).map((r) => r.text)).toEqual([
        'Thanks for calling, how can I help?',
        `my card is ${MARKER}`,
        'go on',
        MARKER,
        'and the rest?',
        `${MARKER} thanks`,
      ]);
      expect(await chunksOf(call.tenantId, call.voiceRecordingId)).not.toMatch(FRAGMENTS);
    }
  });
});
