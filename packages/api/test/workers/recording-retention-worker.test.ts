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

    expect(result).toEqual({ due: 1, purged: 1, failed: 0 });
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't1/old-1.mp3');
    expect(repo.rows.find((r) => r.id === 'old-1')?.purgedAt).toEqual(NOW);
    expect(repo.rows.find((r) => r.id === 'fresh-1')?.purgedAt).toBeNull();
    const audit = auditRepo.events.find((e) => e.eventType === 'voice_recording.purged');
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
      (auditRepo.events[0].metadata as { hadStoredObject?: boolean }).hadStoredObject,
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
    expect(result).toEqual({ due: 2, purged: 1, failed: 1 });
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
    expect(result).toEqual({ due: 0, purged: 0, failed: 0 });
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
    expect(result).toEqual({ due: 1, purged: 1, failed: 0 });
    expect(repo.rows[0].purgedAt).toEqual(NOW);
  });
});
