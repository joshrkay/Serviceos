import { describe, it, expect, vi } from 'vitest';
import {
  runRecordingRetentionSweep,
  InMemoryRecordingRetentionRepository,
  RECORDING_RETENTION_SWEEP_BATCH,
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

/** #1202 — sweeps with no unattached transcript turns report zero for that phase. */
const NO_UNATTACHED = { unattachedTurnsPurged: 0, unattachedTurnTenantsFailed: 0 };

function ageDays(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 3600 * 1000);
}

function row(
  id: string,
  opts: Partial<{
    tenantId: string;
    createdAt: Date;
    retentionDays: number;
    legalHold: boolean;
    purgedAt: Date | null;
    storageBucket: string | null;
    storageKey: string | null;
  }> = {},
) {
  return {
    id,
    tenantId: opts.tenantId ?? 't1',
    callSid: `CA-${id}`,
    storageBucket: opts.storageBucket === undefined ? 'bkt' : opts.storageBucket,
    storageKey: opts.storageKey === undefined ? `t1/${id}.mp3` : opts.storageKey,
    createdAt: opts.createdAt ?? ageDays(400),
    retentionDays: opts.retentionDays ?? 365,
    legalHold: opts.legalHold ?? false,
    purgedAt: opts.purgedAt ?? null,
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
