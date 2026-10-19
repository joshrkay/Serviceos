import { describe, it, expect, vi } from 'vitest';
import {
  runRecordingRetentionSweep,
  InMemoryRecordingRetentionRepository,
  RECORDING_RETENTION_SWEEP_BATCH,
  AI_RUN_CONTENT_SWEEP_BATCH,
} from '../../src/workers/recording-retention-worker';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { StorageProvider } from '../../src/files/file-service';

const NOW = new Date('2026-06-11T00:00:00Z');
const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

/** PRIV-2 — sweeps without a Twilio deleter (or with nothing due) report zero for the retry phase. */
const NO_TWILIO_COPIES = { twilioCopiesDeleted: 0, twilioCopiesFailed: 0 };
/** PRIV-3 — sweeps with no card-number-flagged recordings report zero for that phase. */
const NO_CARD_AUDIO = { cardNumberAudioPurged: 0, cardNumberAudioFailed: 0, ...NO_TWILIO_COPIES };
/** PRIV-1 — sweeps with no ai_runs past the horizon report zero for that phase. */
const NO_AI_RUNS = { aiRunContentPurged: 0, aiRunContentTenantsFailed: 0, ...NO_CARD_AUDIO };
/** #1202 — sweeps with no unattached transcript turns report zero for that phase. */
const NO_SESSIONS = {
  sessionTranscriptsPurged: 0,
  sessionTranscriptTenantsFailed: 0,
  ...NO_AI_RUNS,
};
const NO_UNATTACHED = { unattachedTurnsPurged: 0, unattachedTurnTenantsFailed: 0, ...NO_SESSIONS };

function ageDays(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 3600 * 1000);
}

function row(
  id: string,
  opts: Partial<{
    tenantId: string;
    callSid: string;
    createdAt: Date;
    retentionDays: number;
    legalHold: boolean;
    purgedAt: Date | null;
    storageBucket: string | null;
    storageKey: string | null;
    pciDetected: boolean;
    audioPurgedAt: Date | null;
    recordingUrl: string | null;
    twilioDeletedAt: Date | null;
    twilioDeleteAttemptedAt: Date | null;
  }> = {},
) {
  return {
    id,
    tenantId: opts.tenantId ?? 't1',
    callSid: opts.callSid ?? `CA-${id}`,
    storageBucket: opts.storageBucket === undefined ? 'bkt' : opts.storageBucket,
    storageKey: opts.storageKey === undefined ? `t1/${id}.mp3` : opts.storageKey,
    createdAt: opts.createdAt ?? ageDays(400),
    retentionDays: opts.retentionDays ?? 365,
    legalHold: opts.legalHold ?? false,
    purgedAt: opts.purgedAt ?? null,
    pciDetected: opts.pciDetected ?? false,
    audioPurgedAt: opts.audioPurgedAt ?? null,
    recordingUrl: opts.recordingUrl ?? null,
    twilioDeletedAt: opts.twilioDeletedAt ?? null,
    twilioDeleteAttemptedAt: opts.twilioDeleteAttemptedAt ?? null,
  };
}

describe('RV-132 — recording retention sweep', () => {
  it('purges recordings older than the tenant retention horizon: S3 delete + tombstone + audit', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('old-1'),
      row('fresh-1', { createdAt: ageDays(10) }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const storage = { deleteObject } as unknown as StorageProvider;
    const auditRepo = new InMemoryAuditRepository();

    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result).toEqual({ due: 1, purged: 1, failed: 0, ...NO_UNATTACHED });
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't1/old-1.mp3');
    expect(repo.rows.find((r) => r.id === 'old-1')?.purgedAt).toEqual(NOW);
    expect(repo.rows.find((r) => r.id === 'fresh-1')?.purgedAt).toBeNull();
    const audit = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.purged');
    expect(audit?.entityId).toBe('old-1');
    expect((audit?.metadata as { hadStoredObject?: boolean }).hadStoredObject).toBe(true);
  });

  it('legal_hold rows are exempt regardless of age', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('held-1', { legalHold: true, createdAt: ageDays(2000) }),
    ]);
    const deleteObject = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result.due).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(repo.rows[0].purgedAt).toBeNull();
  });

  it('per-tenant horizons: a 30-day tenant purges what a 365-day tenant keeps', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('short-tenant', { tenantId: 'tA', retentionDays: 30, createdAt: ageDays(60) }),
      row('long-tenant', { tenantId: 'tB', retentionDays: 365, createdAt: ageDays(60) }),
    ]);
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result.purged).toBe(1);
    expect(repo.rows.find((r) => r.id === 'short-tenant')?.purgedAt).toEqual(NOW);
    expect(repo.rows.find((r) => r.id === 'long-tenant')?.purgedAt).toBeNull();
  });

  it('rows without a stored object are tombstoned without an S3 call', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('keyless', { storageBucket: null, storageKey: null }),
    ]);
    const deleteObject = vi.fn();
    const auditRepo = new InMemoryAuditRepository();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject } as unknown as StorageProvider,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result.purged).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(
      (auditRepo.getAll()[0].metadata as { hadStoredObject?: boolean }).hadStoredObject,
    ).toBe(false);
  });

  it('an S3 delete failure leaves the row unpurged for the next sweep', async () => {
    const repo = new InMemoryRecordingRetentionRepository([row('flaky-1'), row('ok-1')]);
    const deleteObject = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('s3 down'));
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 2, purged: 1, failed: 1, ...NO_UNATTACHED });
    expect(repo.rows.find((r) => r.id === 'flaky-1')?.purgedAt).toBeNull();
    expect(repo.rows.find((r) => r.id === 'ok-1')?.purgedAt).toEqual(NOW);
  });

  it('findDue failure returns zeroed counts (never throws)', async () => {
    const repo = new InMemoryRecordingRetentionRepository();
    repo.findDue = vi.fn(async () => {
      throw new Error('pg down');
    });
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: noopLogger,
    });
    expect(result).toEqual({ due: 0, purged: 0, failed: 0, ...NO_UNATTACHED });
  });

  it('respects the batch bound', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      Array.from({ length: 5 }, (_, i) => row(`r-${i}`)),
    );
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
      batchSize: 2,
    });
    expect(result.due).toBe(2);
    expect(RECORDING_RETENTION_SWEEP_BATCH).toBeGreaterThan(0);
  });

  it('dev-storage provider: the sweep completes against DevStorageProvider (no-op deletes)', async () => {
    const repo = new InMemoryRecordingRetentionRepository([row('dev-1')]);
    const provider = new DevStorageProvider({
      bucket: 'dev',
      publicUrlBase: 'http://localhost:3000/storage-dev',
    });
    const result = await runRecordingRetentionSweep({
      repo,
      storage: provider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 1, purged: 1, failed: 0, ...NO_UNATTACHED });
    expect(repo.rows[0].purgedAt).toEqual(NOW);
  });
});

// ─── Comms C6 — the sweep reaches all four data classes ──────────────────────

describe('C6 derived-data purge', () => {
  it('purges derived data BEFORE the tombstone and audits the per-class counts', async () => {
    const repo = new InMemoryRecordingRetentionRepository([row('rec-1')]);
    repo.derivedCounts.set('rec-1', {
      transcriptTurns: 12,
      callSummaries: 1,
      knowledgeChunks: 5,
    });
    const auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
    const storage = { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider;
    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auditRepo: auditRepo as any,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 1, purged: 1, failed: 0, ...NO_UNATTACHED });
    expect(repo.derivedPurged).toEqual([{ tenantId: 't1', id: 'rec-1' }]);
    expect(repo.rows[0].purgedAt).toEqual(NOW);
    const audit = auditRepo.create.mock.calls[0][0];
    expect(audit.metadata.derivedPurged).toEqual({
      transcriptTurns: 12,
      callSummaries: 1,
      knowledgeChunks: 5,
    });
  });

  it('a failed derived purge leaves the row un-tombstoned for the next sweep', async () => {
    const repo = new InMemoryRecordingRetentionRepository([row('rec-2')]);
    repo.purgeDerived = async () => {
      throw new Error('kaboom');
    };
    const storage = { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider;
    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 1, purged: 0, failed: 1, ...NO_UNATTACHED });
    expect(repo.rows[0].purgedAt).toBeFalsy();
  });
});

// ─── #1202 — transcript turns that never got a recording ─────────────────────

describe('#1202 unattached transcript-turn purge', () => {
  function turn(tenantId: string, callSid: string | null, age: number, retentionDays = 30) {
    return { tenantId, callSid, createdAt: ageDays(age), retentionDays };
  }

  it('purges per tenant horizon, counts the rows, and audits one event per call', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      [],
      [
        turn('tA', 'CA-old', 31),
        turn('tA', 'CA-old', 32),
        turn('tA', 'CA-fresh', 1),
        turn('tB', 'CA-b', 31, 90),
      ],
    );
    const auditRepo = new InMemoryAuditRepository();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({
      due: 0,
      purged: 0,
      failed: 0,
      unattachedTurnsPurged: 2,
      unattachedTurnTenantsFailed: 0,
      ...NO_SESSIONS,
    });
    expect(repo.unattachedTurns.map((t) => t.callSid)).toEqual(['CA-fresh', 'CA-b']);
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: 'tA',
      actorId: 'recording-retention-worker',
      actorRole: 'system',
      eventType: 'voice_session.transcript_purged',
      entityType: 'voice_session',
      entityId: 'CA-old',
    });
    expect(events[0].metadata).toEqual({
      callSid: 'CA-old',
      reason: 'no_recording_past_retention',
      oldestTurnAt: ageDays(32).toISOString(),
      derivedPurged: { transcriptTurns: 2 },
    });
  });

  it('a tenant whose purge throws is counted and logged; the next tenant is still purged', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      [],
      [turn('t-doomed', 'CA-1', 60), turn('t-ok', 'CA-2', 40)],
    );
    const real = repo.purgeUnattachedTurns.bind(repo);
    repo.purgeUnattachedTurns = async (tenantId, now, limit) => {
      if (tenantId === 't-doomed') throw new Error('delete failed');
      return real(tenantId, now, limit);
    };
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.unattachedTurnTenantsFailed).toBe(1);
    expect(result.unattachedTurnsPurged).toBe(1);
    expect(repo.unattachedTurns.map((t) => t.tenantId)).toEqual(['t-doomed']);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: unattached-turn purge failed for tenant',
      { tenantId: 't-doomed', error: 'delete failed' },
    );
  });

  it('still runs when the recording selection fails', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [turn('tA', 'CA-1', 45)]);
    repo.findDue = vi.fn(async () => {
      throw new Error('pg down');
    });
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result).toEqual({
      due: 0,
      purged: 0,
      failed: 0,
      unattachedTurnsPurged: 1,
      unattachedTurnTenantsFailed: 0,
      ...NO_SESSIONS,
    });
  });

  it('respects the per-tenant batch bound', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      [],
      [turn('tA', 'CA-1', 40), turn('tA', 'CA-1', 41), turn('tA', 'CA-1', 42)],
    );
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
      unattachedTurnBatchSize: 2,
    });
    expect(result.unattachedTurnsPurged).toBe(2);
    // Oldest first: the 40-day-old row is the one left for the next sweep.
    expect(repo.unattachedTurns.map((t) => t.createdAt)).toEqual([ageDays(40)]);
  });

  it("a legal hold on a same-tenant recording for the call's CallSid protects its unattached turns; another tenant's hold does not", async () => {
    // Recording rows are young (not due), so the recording drain is a no-op;
    // only their CallSid + legal_hold matter here.
    const repo = new InMemoryRecordingRetentionRepository(
      [
        { ...row('vm-held', { tenantId: 'tA', createdAt: ageDays(1), legalHold: true }), callSid: 'CA-held' },
        { ...row('vm-open', { tenantId: 'tA', createdAt: ageDays(1) }), callSid: 'CA-open' },
        { ...row('vm-other', { tenantId: 'tOther', createdAt: ageDays(1), legalHold: true }), callSid: 'CA-shared' },
      ],
      [turn('tA', 'CA-held', 45), turn('tA', 'CA-open', 45), turn('tB', 'CA-shared', 45)],
    );
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result.unattachedTurnsPurged).toBe(2);
    expect(repo.unattachedTurns.map((t) => `${t.tenantId}/${t.callSid}`)).toEqual(['tA/CA-held']);
  });

  it('a failed audit write after the purge is logged with tenant, CallSid and turn count', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      [],
      [turn('tA', 'CA-1', 45), turn('tA', 'CA-1', 46)],
    );
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      auditRepo: { create: vi.fn().mockRejectedValue(new Error('audit down')) } as never,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.unattachedTurnsPurged).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: unattached-turn audit write failed',
      { tenantId: 'tA', callSid: 'CA-1', transcriptTurns: 2, error: 'audit down' },
    );
  });
});

describe('#1208 — voice_sessions.transcript phase', () => {
  function session(id: string, tenantId: string, callSid: string | null, days: number, lines = ['caller: hi']) {
    return { id, tenantId, callSid, startedAt: ageDays(days), transcript: [...lines], retentionDays: 30 };
  }

  it('clears past-horizon session transcripts, skips held CallSids, and audits per session', async () => {
    const repo = new InMemoryRecordingRetentionRepository(
      [
        {
          id: 'rec-held',
          tenantId: 'tA',
          callSid: 'CA-held',
          storageBucket: null,
          storageKey: null,
          createdAt: ageDays(1),
          legalHold: true,
          retentionDays: 30,
        },
      ],
      [],
      [
        session('s-old', 'tA', 'CA-old', 40, ['caller: a', 'agent: b']),
        session('s-held', 'tA', 'CA-held', 40),
        session('s-fresh', 'tA', 'CA-fresh', 2),
        session('s-inapp', 'tB', null, 31),
      ],
    );
    const auditRepo = new InMemoryAuditRepository();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });
    expect(result.sessionTranscriptsPurged).toBe(2);
    expect(result.sessionTranscriptTenantsFailed).toBe(0);
    expect(repo.sessionTranscripts.filter((s) => s.transcript !== null).map((s) => s.id)).toEqual([
      's-held',
      's-fresh',
    ]);
    const events = auditRepo.getAll().filter((e) => e.entityId === 's-old');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      callSid: 'CA-old',
      reason: 'session_transcript_past_retention',
      startedAt: ageDays(40).toISOString(),
      derivedPurged: { sessionTranscriptLines: 2 },
    });
  });

  it('a tenant whose clear throws is counted and logged; the next tenant is still cleared', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [
      session('s-1', 't-doomed', 'CA-1', 60),
      session('s-2', 't-ok', 'CA-2', 40),
    ]);
    const real = repo.purgeSessionTranscripts.bind(repo);
    repo.purgeSessionTranscripts = async (tenantId, now, limit) => {
      if (tenantId === 't-doomed') throw new Error('update failed');
      return real(tenantId, now, limit);
    };
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.sessionTranscriptTenantsFailed).toBe(1);
    expect(result.sessionTranscriptsPurged).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: session-transcript purge failed for tenant',
      { tenantId: 't-doomed', error: 'update failed' },
    );
  });

  it('a failed tenant selection is logged and returns zero (never throws)', async () => {
    const repo = new InMemoryRecordingRetentionRepository();
    repo.findTenantsWithDueSessionTranscripts = vi.fn(async () => {
      throw new Error('pg down');
    });
    const error = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      logger: { ...(noopLogger as object), error } as never,
      now: () => NOW,
    });
    expect(result).toMatchObject(NO_SESSIONS);
    expect(error).toHaveBeenCalledWith(
      'recording-retention sweep: session-transcript tenant selection failed',
      { error: 'pg down' },
    );
  });

  it('a failed audit write after the clear is logged with tenant and session id', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [session('s-1', 'tA', 'CA-1', 45)]);
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn() } as unknown as StorageProvider,
      auditRepo: { create: vi.fn().mockRejectedValue(new Error('audit down')) } as never,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.sessionTranscriptsPurged).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: session-transcript audit write failed',
      { tenantId: 'tA', sessionId: 's-1', error: 'audit down' },
    );
  });
});

describe('PRIV-1 — ai_runs prompt and reply content phase', () => {
  function aiRun(
    id: string,
    tenantId: string,
    days: number,
    opts: Partial<{ taskType: string; retentionDays: number }> = {},
  ) {
    return {
      id,
      tenantId,
      taskType: opts.taskType ?? 'classify_intent',
      createdAt: ageDays(days),
      inputSnapshot: {
        messages: [{ role: 'user', content: 'caller: Maria Lopez, 555-201-7788' }],
        temperature: 0,
        maxTokens: 200,
      } as Record<string, unknown>,
      outputSnapshot: {
        content: '{"intentType":"book_appointment"}',
        provider: 'openai',
        providerPath: ['openai:gpt-4o-mini'],
      } as Record<string, unknown> | null,
      contentPurgedAt: null as Date | null,
      retentionDays: opts.retentionDays ?? 30,
    };
  }
  const storage = { deleteObject: vi.fn() } as unknown as StorageProvider;

  it('strips content from runs past each tenant horizon, keeps the non-content keys, and writes one audit event per tenant batch', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [
      aiRun('r-old', 'tA', 40),
      aiRun('r-old-summary', 'tA', 35, { taskType: 'summarize_conversation' }),
      aiRun('r-fresh', 'tA', 2),
      aiRun('r-b', 'tB', 40, { retentionDays: 365 }),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const result = await runRecordingRetentionSweep({ repo, storage, auditRepo, logger: noopLogger, now: () => NOW });

    expect(result.aiRunContentPurged).toBe(2);
    expect(result.aiRunContentTenantsFailed).toBe(0);
    const byId = new Map(repo.aiRuns.map((r) => [r.id, r]));
    expect(byId.get('r-old')).toMatchObject({
      inputSnapshot: { temperature: 0, maxTokens: 200 },
      outputSnapshot: { provider: 'openai', providerPath: ['openai:gpt-4o-mini'] },
      contentPurgedAt: NOW,
    });
    expect(JSON.stringify(byId.get('r-old-summary'))).not.toContain('Maria Lopez');
    expect(JSON.stringify(byId.get('r-fresh'))).toContain('Maria Lopez');
    expect(JSON.stringify(byId.get('r-b'))).toContain('Maria Lopez');

    const events = auditRepo.getAll().filter((e) => e.eventType === 'ai_run.content_purged');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: 'tA', entityType: 'tenant', entityId: 'tA', actorRole: 'system' });
    expect(events[0].metadata).toEqual({
      reason: 'past_retention',
      runsPurged: 2,
      byTaskType: { classify_intent: 1, summarize_conversation: 1 },
      oldestCreatedAt: ageDays(40).toISOString(),
      newestCreatedAt: ageDays(35).toISOString(),
    });
  });

  it('a purged run with no reply keeps output_snapshot null', async () => {
    const run = { ...aiRun('r-pending', 'tA', 40), outputSnapshot: null };
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [run]);
    await runRecordingRetentionSweep({ repo, storage, logger: noopLogger, now: () => NOW });
    expect(repo.aiRuns[0]).toMatchObject({ outputSnapshot: null, contentPurgedAt: NOW });
  });

  it('bounds each tenant to the batch size per sweep, oldest first (default AI_RUN_CONTENT_SWEEP_BATCH)', async () => {
    expect(AI_RUN_CONTENT_SWEEP_BATCH).toBe(500);
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [
      aiRun('r-2', 'tA', 40),
      aiRun('r-1', 'tA', 50),
      aiRun('r-3', 'tA', 31),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const first = await runRecordingRetentionSweep({
      repo, storage, auditRepo, logger: noopLogger, now: () => NOW, aiRunContentBatchSize: 2,
    });
    expect(first.aiRunContentPurged).toBe(2);
    expect(repo.aiRuns.filter((r) => r.contentPurgedAt).map((r) => r.id).sort()).toEqual(['r-1', 'r-2']);
    const second = await runRecordingRetentionSweep({
      repo, storage, auditRepo, logger: noopLogger, now: () => NOW, aiRunContentBatchSize: 2,
    });
    expect(second.aiRunContentPurged).toBe(1);
    const third = await runRecordingRetentionSweep({
      repo, storage, auditRepo, logger: noopLogger, now: () => NOW, aiRunContentBatchSize: 2,
    });
    expect(third.aiRunContentPurged).toBe(0);
    expect(
      auditRepo.getAll().filter((e) => e.eventType === 'ai_run.content_purged').map((e) => e.metadata?.runsPurged),
    ).toEqual([2, 1]);
  });

  it('a tenant whose purge throws is counted and logged; the next tenant is still purged', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [
      aiRun('r-doomed', 't-doomed', 60),
      aiRun('r-ok', 't-ok', 40),
    ]);
    const real = repo.purgeAiRunContent.bind(repo);
    repo.purgeAiRunContent = async (tenantId, now, limit) => {
      if (tenantId === 't-doomed') throw new Error('update failed');
      return real(tenantId, now, limit);
    };
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.aiRunContentTenantsFailed).toBe(1);
    expect(result.aiRunContentPurged).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: ai-run content purge failed for tenant',
      { tenantId: 't-doomed', error: 'update failed' },
    );
    expect(repo.aiRuns.find((r) => r.id === 'r-ok')?.contentPurgedAt).toEqual(NOW);
  });

  it('a failed tenant selection is logged and returns zero; the later phases still run', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('rec-card', { createdAt: ageDays(1), pciDetected: true }),
    ]);
    repo.findTenantsWithDueAiRunContent = vi.fn(async () => {
      throw new Error('pg down');
    });
    const error = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      logger: { ...(noopLogger as object), error } as never,
      now: () => NOW,
    });
    expect(result).toMatchObject({ aiRunContentPurged: 0, aiRunContentTenantsFailed: 0, cardNumberAudioPurged: 1 });
    expect(error).toHaveBeenCalledWith(
      'recording-retention sweep: ai-run content tenant selection failed',
      { error: 'pg down' },
    );
  });

  it('still runs when the recording selection fails', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [aiRun('r-old', 'tA', 40)]);
    repo.findDue = vi.fn(async () => {
      throw new Error('pg down');
    });
    const result = await runRecordingRetentionSweep({ repo, storage, logger: noopLogger, now: () => NOW });
    expect(result.aiRunContentPurged).toBe(1);
  });

  it('a failed audit write after the purge is logged with the tenant and the count', async () => {
    const repo = new InMemoryRecordingRetentionRepository([], [], [], [aiRun('r-1', 'tA', 45)]);
    const warn = vi.fn();
    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      auditRepo: { create: vi.fn().mockRejectedValue(new Error('audit down')) } as never,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });
    expect(result.aiRunContentPurged).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: ai-run content audit write failed',
      { tenantId: 'tA', runsPurged: 1, error: 'audit down' },
    );
  });
});

describe('PRIV-3 — card-number audio purge', () => {
  it('deletes the stored audio of a flagged recording promptly, stamps audio_purged_at and audits it; the row, its transcript and the horizon tombstone are untouched', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('flagged', { createdAt: ageDays(0), pciDetected: true }),
      row('clean', { createdAt: ageDays(0) }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const storage = { deleteObject } as unknown as StorageProvider;
    const auditRepo = new InMemoryAuditRepository();

    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result).toEqual({
      due: 0,
      purged: 0,
      failed: 0,
      ...NO_UNATTACHED,
      cardNumberAudioPurged: 1,
      cardNumberAudioFailed: 0,
    });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't1/flagged.mp3');
    const flagged = repo.rows.find((r) => r.id === 'flagged');
    expect(flagged?.audioPurgedAt).toEqual(NOW);
    expect(flagged?.purgedAt).toBeNull();
    expect(repo.derivedPurged).toEqual([]);
    expect(repo.rows.find((r) => r.id === 'clean')?.audioPurgedAt).toBeNull();
    const audit = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.audio_purged');
    expect(audit?.entityType).toBe('voice_recording');
    expect(audit?.entityId).toBe('flagged');
    expect(audit?.metadata).toEqual({
      callSid: 'CA-flagged',
      reason: 'card_number_detected',
      hadStoredObject: true,
      // PRIV-2 — a memo-style row with no recording_url never had a Twilio copy.
      hadTwilioCopy: false,
      twilioDeleted: false,
      recordedAt: ageDays(0).toISOString(),
    });
  });

  it('is idempotent: a second sweep deletes nothing and audits nothing', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('flagged', { createdAt: ageDays(0), pciDetected: true }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const storage = { deleteObject } as unknown as StorageProvider;
    const auditRepo = new InMemoryAuditRepository();
    const deps = { repo, storage, auditRepo, logger: noopLogger, now: () => NOW };

    await runRecordingRetentionSweep(deps);
    const second = await runRecordingRetentionSweep(deps);

    expect(second.cardNumberAudioPurged).toBe(0);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'voice_recording.audio_purged')).toHaveLength(1);
  });

  it('legal_hold and already-tombstoned rows are exempt', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('held', { createdAt: ageDays(0), pciDetected: true, legalHold: true }),
      row('tombstoned', { createdAt: ageDays(0), pciDetected: true, purgedAt: ageDays(1) }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const storage = { deleteObject } as unknown as StorageProvider;

    const result = await runRecordingRetentionSweep({ repo, storage, logger: noopLogger, now: () => NOW });

    expect(result.cardNumberAudioPurged).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(repo.rows.every((r) => r.audioPurgedAt === null)).toBe(true);
  });

  it('a failed delete leaves the row flagged for the next sweep and does not stop the rest', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('bad', { createdAt: ageDays(1), pciDetected: true }),
      row('good', { createdAt: ageDays(0), pciDetected: true }),
    ]);
    const deleteObject = vi.fn(async (_bucket: string, key: string) => {
      if (key.includes('bad')) throw new Error('s3 down');
    });
    const storage = { deleteObject } as unknown as StorageProvider;
    const warn = vi.fn();

    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      logger: { ...(noopLogger as object), warn } as never,
      now: () => NOW,
    });

    expect(result.cardNumberAudioPurged).toBe(1);
    expect(result.cardNumberAudioFailed).toBe(1);
    expect(repo.rows.find((r) => r.id === 'bad')?.audioPurgedAt).toBeNull();
    expect(repo.rows.find((r) => r.id === 'good')?.audioPurgedAt).toEqual(NOW);
    expect(warn).toHaveBeenCalledWith(
      'recording-retention sweep: card-number audio purge row failed',
      expect.objectContaining({ tenantId: 't1', voiceRecordingId: 'bad', error: 's3 down' }),
    );
  });

  it('a flagged recording with no stored object is stamped without a storage call', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('no-object', { createdAt: ageDays(0), pciDetected: true, storageBucket: null, storageKey: null }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const storage = { deleteObject } as unknown as StorageProvider;
    const auditRepo = new InMemoryAuditRepository();

    const result = await runRecordingRetentionSweep({ repo, storage, auditRepo, logger: noopLogger, now: () => NOW });

    expect(result.cardNumberAudioPurged).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    const audit = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.audio_purged');
    expect((audit?.metadata as { hadStoredObject?: boolean }).hadStoredObject).toBe(false);
  });

  it('a failed selection is logged and returns zero for the phase (never throws)', async () => {
    const repo = new InMemoryRecordingRetentionRepository([]);
    vi.spyOn(repo, 'findCardNumberAudioDue').mockRejectedValue(new Error('db down'));
    const error = vi.fn();

    const result = await runRecordingRetentionSweep({
      repo,
      storage: new DevStorageProvider({ bucket: 'dev', publicUrlBase: 'http://localhost/dev' }),
      logger: { ...(noopLogger as object), error } as never,
      now: () => NOW,
    });

    expect(result.cardNumberAudioPurged).toBe(0);
    expect(result.cardNumberAudioFailed).toBe(0);
    expect(error).toHaveBeenCalledWith(
      'recording-retention sweep: card-number audio selection failed',
      expect.objectContaining({ error: 'db down' }),
    );
  });
});

describe('PRIV-2 — the Twilio-hosted copy of each recording', () => {
  const twilioUrl = (n: string) =>
    `https://api.twilio.com/2010-04-01/Accounts/AC${'b'.repeat(32)}/Recordings/RE${n.padEnd(32, '0')}`;

  function deleterThat(outcomes: Record<string, 'deleted' | 'already_gone' | Error> = {}) {
    return {
      deleteRecording: vi.fn(async (url: string) => {
        const outcome = outcomes[url] ?? 'deleted';
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }),
    };
  }

  it('the horizon purge deletes a legacy recording\'s Twilio copy and records twilioDeleted; recording_url is kept', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('old', { recordingUrl: twilioUrl('1') }),
    ]);
    const storage = { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider;
    const auditRepo = new InMemoryAuditRepository();
    const twilioRecordingDeleter = deleterThat();

    const result = await runRecordingRetentionSweep({
      repo,
      storage,
      auditRepo,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result.purged).toBe(1);
    expect(twilioRecordingDeleter.deleteRecording).toHaveBeenCalledTimes(1);
    expect(twilioRecordingDeleter.deleteRecording).toHaveBeenCalledWith(twilioUrl('1'));
    const old = repo.rows.find((r) => r.id === 'old')!;
    expect(old.purgedAt).toEqual(NOW);
    expect(old.twilioDeletedAt).toEqual(NOW);
    expect(old.recordingUrl).toBe(twilioUrl('1'));
    const purged = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.purged');
    expect(purged?.metadata).toMatchObject({ hadStoredObject: true, hadTwilioCopy: true, twilioDeleted: true });
    const copy = auditRepo.getAll().filter((e) => e.eventType === 'voice_recording.twilio_copy_deleted');
    expect(copy).toHaveLength(1);
    expect(copy[0]).toMatchObject({ entityId: 'old', metadata: { reason: 'past_retention' } });
  });

  it('a failed Twilio delete does not hold the horizon purge hostage: the row is tombstoned, the audit says twilioDeleted:false, and the attempt is recorded for the retry', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('old', { recordingUrl: twilioUrl('1') }),
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const auditRepo = new InMemoryAuditRepository();

    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject } as unknown as StorageProvider,
      auditRepo,
      twilioRecordingDeleter: deleterThat({ [twilioUrl('1')]: new Error('Twilio recording delete failed 503') }),
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result.purged).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't1/old.mp3');
    const old = repo.rows.find((r) => r.id === 'old')!;
    expect(old.purgedAt).toEqual(NOW);
    expect(old.twilioDeletedAt).toBeNull();
    expect(old.twilioDeleteAttemptedAt).toEqual(NOW);
    const purged = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.purged');
    expect(purged?.metadata).toMatchObject({ hadTwilioCopy: true, twilioDeleted: false });
  });

  it('a copy already deleted at ingest is not deleted again; the purge audit still records it gone', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('old', { recordingUrl: twilioUrl('1'), twilioDeletedAt: ageDays(399) }),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const twilioRecordingDeleter = deleterThat();

    await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      auditRepo,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(twilioRecordingDeleter.deleteRecording).not.toHaveBeenCalled();
    const purged = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.purged');
    expect(purged?.metadata).toMatchObject({ hadTwilioCopy: true, twilioDeleted: true });
  });

  it('the retry phase deletes legacy and failed copies, oldest first, and skips fresh, held, recently attempted and confirmed rows', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      // Tombstoned before PRIV-2: the S3 copy is gone, the Twilio copy is not.
      row('legacy-tombstoned', { createdAt: ageDays(500), purgedAt: ageDays(100), recordingUrl: twilioUrl('1') }),
      // Within the horizon; the ingest delete failed two days ago.
      row('failed-ingest', {
        createdAt: ageDays(3),
        recordingUrl: twilioUrl('2'),
        twilioDeleteAttemptedAt: ageDays(2),
      }),
      // Ingested an hour ago: the voicemail retry window still needs the copy.
      row('fresh', { createdAt: new Date(NOW.getTime() - 3600_000), recordingUrl: twilioUrl('3') }),
      row('held', { createdAt: ageDays(30), legalHold: true, recordingUrl: twilioUrl('4') }),
      // Failed an hour ago: backs off rather than being hammered every sweep.
      row('just-failed', {
        createdAt: ageDays(30),
        recordingUrl: twilioUrl('5'),
        twilioDeleteAttemptedAt: new Date(NOW.getTime() - 3600_000),
      }),
      row('confirmed', { createdAt: ageDays(30), recordingUrl: twilioUrl('6'), twilioDeletedAt: ageDays(30) }),
      // A memo upload: never had a Twilio copy.
      row('memo', { createdAt: ageDays(30) }),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const twilioRecordingDeleter = deleterThat({ [twilioUrl('2')]: 'already_gone' });

    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      auditRepo,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(twilioRecordingDeleter.deleteRecording.mock.calls.map((c) => c[0])).toEqual([
      twilioUrl('1'),
      twilioUrl('2'),
    ]);
    expect(result).toMatchObject({ twilioCopiesDeleted: 2, twilioCopiesFailed: 0 });
    const byId = (id: string) => repo.rows.find((r) => r.id === id)!;
    expect(byId('legacy-tombstoned').twilioDeletedAt).toEqual(NOW);
    expect(byId('legacy-tombstoned').recordingUrl).toBe(twilioUrl('1'));
    expect(byId('failed-ingest').twilioDeletedAt).toEqual(NOW);
    for (const id of ['fresh', 'held', 'just-failed', 'memo']) expect(byId(id).twilioDeletedAt).toBeNull();
    const copy = auditRepo.getAll().filter((e) => e.eventType === 'voice_recording.twilio_copy_deleted');
    expect(copy.map((e) => [e.entityId, (e.metadata as { reason: string }).reason])).toEqual([
      ['legacy-tombstoned', 'retry'],
      ['failed-ingest', 'retry'],
    ]);
  });

  // Review round 2 — before per-recording keys, two recordings of one call
  // were stored at one key and the second PUT overwrote the first; the first
  // recording's only copy is at Twilio. The retry phase leaves such rows
  // alone until a purge deliberately deletes their audio.
  it('the retry phase keeps the Twilio copies of legacy rows of one call that share a stored object until a purge', async () => {
    const shared = { callSid: 'CA-shared', storageKey: 't1/CA-shared.mp3', createdAt: ageDays(30) };
    const repo = new InMemoryRecordingRetentionRepository([
      row('shared-a', { ...shared, recordingUrl: twilioUrl('1') }),
      row('shared-b', { ...shared, recordingUrl: twilioUrl('2') }),
      row('shared-tombstoned', {
        ...shared,
        storageKey: 't1/CA-shared-2.mp3',
        callSid: 'CA-shared-2',
        purgedAt: ageDays(1),
        recordingUrl: twilioUrl('3'),
      }),
      row('shared-tombstoned-twin', {
        ...shared,
        storageKey: 't1/CA-shared-2.mp3',
        callSid: 'CA-shared-2',
        recordingUrl: twilioUrl('4'),
      }),
      // Positive control: a lone legacy row of the same age.
      row('lone', { createdAt: ageDays(30), recordingUrl: twilioUrl('5') }),
    ]);
    const twilioRecordingDeleter = deleterThat();

    await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(twilioRecordingDeleter.deleteRecording.mock.calls.map((c) => c[0]).sort()).toEqual(
      [twilioUrl('3'), twilioUrl('5')].sort(),
    );
    const byId = (id: string) => repo.rows.find((r) => r.id === id)!;
    for (const id of ['shared-a', 'shared-b', 'shared-tombstoned-twin']) {
      expect(byId(id).twilioDeletedAt).toBeNull();
    }
  });

  it('a re-run is idempotent: no second delete, no second audit', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('legacy', { createdAt: ageDays(500), purgedAt: ageDays(100), recordingUrl: twilioUrl('1') }),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const twilioRecordingDeleter = deleterThat();
    const deps = {
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      auditRepo,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    };

    await runRecordingRetentionSweep(deps);
    const second = await runRecordingRetentionSweep(deps);

    expect(second).toMatchObject({ twilioCopiesDeleted: 0, twilioCopiesFailed: 0 });
    expect(twilioRecordingDeleter.deleteRecording).toHaveBeenCalledTimes(1);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'voice_recording.twilio_copy_deleted')).toHaveLength(1);
  });

  it('a failed retry is counted, stamped for back-off, and does not stop the rest', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('bad', { createdAt: ageDays(40), recordingUrl: twilioUrl('1') }),
      row('good', { createdAt: ageDays(30), recordingUrl: twilioUrl('2') }),
    ]);
    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      twilioRecordingDeleter: deleterThat({ [twilioUrl('1')]: new Error('Twilio recording delete failed 401') }),
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result).toMatchObject({ twilioCopiesDeleted: 1, twilioCopiesFailed: 1 });
    expect(repo.rows.find((r) => r.id === 'bad')!.twilioDeleteAttemptedAt).toEqual(NOW);
    expect(repo.rows.find((r) => r.id === 'good')!.twilioDeletedAt).toEqual(NOW);
  });

  it('without Twilio credentials (no deleter) nothing is sent and the purge audit says the copy is not deleted', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      row('old', { recordingUrl: twilioUrl('1') }),
    ]);
    const auditRepo = new InMemoryAuditRepository();

    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      auditRepo,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result).toMatchObject({ purged: 1, twilioCopiesDeleted: 0, twilioCopiesFailed: 0 });
    const purged = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.purged');
    expect(purged?.metadata).toMatchObject({ hadTwilioCopy: true, twilioDeleted: false });
  });

  it('the card-number audio purge deletes the Twilio copy too, at once, and records it', async () => {
    const repo = new InMemoryRecordingRetentionRepository([
      // Flagged minutes after ingest: no grace window for a card number.
      row('flagged', {
        createdAt: new Date(NOW.getTime() - 600_000),
        pciDetected: true,
        recordingUrl: twilioUrl('1'),
      }),
    ]);
    const auditRepo = new InMemoryAuditRepository();
    const twilioRecordingDeleter = deleterThat();

    const result = await runRecordingRetentionSweep({
      repo,
      storage: { deleteObject: vi.fn(async () => undefined) } as unknown as StorageProvider,
      auditRepo,
      twilioRecordingDeleter,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result.cardNumberAudioPurged).toBe(1);
    expect(twilioRecordingDeleter.deleteRecording).toHaveBeenCalledTimes(1);
    const flagged = repo.rows.find((r) => r.id === 'flagged')!;
    expect(flagged.twilioDeletedAt).toEqual(NOW);
    const audit = auditRepo.getAll().find((e) => e.eventType === 'voice_recording.audio_purged');
    expect(audit?.metadata).toMatchObject({ hadTwilioCopy: true, twilioDeleted: true });
    const copy = auditRepo.getAll().filter((e) => e.eventType === 'voice_recording.twilio_copy_deleted');
    expect(copy).toHaveLength(1);
    expect(copy[0].metadata).toMatchObject({ reason: 'card_number_detected' });
  });
});
