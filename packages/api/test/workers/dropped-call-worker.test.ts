import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  InMemoryDroppedCallRecoveryRepository,
} from '../../src/sms/recovery/scheduler';
import type { DroppedCallHandlerDeps } from '../../src/sms/recovery/dropped-call-handler';
import { runDroppedCallRecoverySweep } from '../../src/workers/dropped-call-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '00000000-0000-0000-0000-000000000001';
const E164 = '+15551234567';
const NOW = new Date('2026-05-21T12:01:05Z');

function handlerDeps(
  repo: InMemoryDroppedCallRecoveryRepository,
  overrides: Partial<Omit<DroppedCallHandlerDeps, 'repo'>> = {},
): Omit<DroppedCallHandlerDeps, 'repo'> {
  return {
    audit: new InMemoryAuditRepository(),
    logger,
    rateLimit: { check: vi.fn(async () => true), record: vi.fn(async () => undefined) },
    resolvedSince: vi.fn(async () => null),
    compose: vi.fn(async () => 'Sorry we got cut off — text us back anytime.'),
    sendSms: vi.fn(async () => 'SM_sid'),
    now: () => NOW,
    ...overrides,
  };
}

async function seedRow(
  repo: InMemoryDroppedCallRecoveryRepository,
  sessionId: string,
  scheduledFor: Date,
): Promise<void> {
  await repo.schedule({ tenantId: TENANT, voiceSessionId: sessionId, callerE164: E164, scheduledFor });
}

describe('P8-015 dropped-call recovery worker sweep', () => {
  let repo: InMemoryDroppedCallRecoveryRepository;

  beforeEach(() => {
    repo = new InMemoryDroppedCallRecoveryRepository();
  });

  it('drains a due row and sends its recovery SMS', async () => {
    await seedRow(repo, 'sess-due', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 1, sent: 1, suppressed: 0, skipped: 0, expired: 0, failed: 0 });
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
  });

  it('skips a not-yet-due row (scheduled_for in the future)', async () => {
    await seedRow(repo, 'sess-future', new Date(NOW.getTime() + 60_000));
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      now: () => NOW,
    });
    expect(result.due).toBe(0);
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  it('counts a suppressed row without sending', async () => {
    await seedRow(repo, 'sess-booked', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo, {
      resolvedSince: vi.fn(async () => 'booking_completed' as const),
    });
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 1, sent: 0, suppressed: 1, skipped: 0, expired: 0, failed: 0 });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  it('isolates a failing row (left pending for retry) without aborting the batch', async () => {
    await seedRow(repo, 'sess-bad', new Date(NOW.getTime() - 2000));
    await seedRow(repo, 'sess-good', new Date(NOW.getTime() - 1000));
    const sendSms = vi
      .fn()
      .mockRejectedValueOnce(new Error('twilio 500'))
      .mockResolvedValue('SM_ok');
    const deps = handlerDeps(repo, { sendSms });
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      now: () => NOW,
    });
    expect(result.due).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    // The failed row stays pending (not stamped) so a later sweep retries it.
    const stillPending = repo.rows.find((r) => r.voiceSessionId === 'sess-bad');
    expect(stillPending?.sentAt).toBeFalsy();
    expect(stillPending?.suppressedReason).toBeFalsy();
  });

  it('does NOT re-drain an already-sent row (idempotent across sweeps)', async () => {
    await seedRow(repo, 'sess-once', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo);
    await runDroppedCallRecoverySweep({ repo, handlerDeps: deps, logger, now: () => NOW });
    await runDroppedCallRecoverySweep({ repo, handlerDeps: deps, logger, now: () => NOW });
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
  });

  it('returns zeroed counts (no throw) when the repo fetches fail', async () => {
    const brokenRepo = {
      findExpired: vi.fn(async () => {
        throw new Error('db down');
      }),
      findDueTenantIds: vi.fn(async () => {
        throw new Error('db down');
      }),
      findDueForTenants: vi.fn(async () => []),
      schedule: vi.fn(),
      markSent: vi.fn(),
      markSuppressed: vi.fn(),
    } as unknown as InMemoryDroppedCallRecoveryRepository;
    const result = await runDroppedCallRecoverySweep({
      repo: brokenRepo,
      handlerDeps: handlerDeps(repo),
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ due: 0, sent: 0, suppressed: 0, skipped: 0, expired: 0, failed: 0 });
  });

  it('skips (leaves pending) a due row whose tenant flag is disabled', async () => {
    await seedRow(repo, 'sess-flagged-off', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant: vi.fn(async () => false),
      now: () => NOW,
    });
    // The disabled tenant is skipped and its row is never fetched into the
    // send batch (due=0); skipped counts the tenant.
    expect(result).toEqual({ due: 0, sent: 0, suppressed: 0, skipped: 1, expired: 0, failed: 0 });
    expect(deps.sendSms).not.toHaveBeenCalled();
    // Skipped, NOT suppressed: enabling the flag within the freshness window
    // lets a later sweep send it.
    const row = repo.rows.find((r) => r.voiceSessionId === 'sess-flagged-off');
    expect(row?.sentAt).toBeFalsy();
    expect(row?.suppressedReason).toBeFalsy();
  });

  it('does not starve an enabled tenant behind a large disabled-tenant backlog', async () => {
    // The starvation guard: a disabled tenant with more rows than the batch
    // limit must not prevent an enabled tenant's fresh row from sending.
    const disabledTenant = '00000000-0000-0000-0000-0000000000d1';
    for (let i = 0; i < 150; i++) {
      // Older than the enabled row so oldest-first would surface these first.
      await repo.schedule({
        tenantId: disabledTenant,
        voiceSessionId: `dis-${i}`,
        callerE164: E164,
        scheduledFor: new Date(NOW.getTime() - 2000),
      });
    }
    await seedRow(repo, 'sess-enabled', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      batchSize: 100,
      isEnabledForTenant: vi.fn(async (t: string) => t === TENANT),
      now: () => NOW,
    });
    // The enabled tenant's row sends despite 150 older disabled rows.
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1); // the one disabled tenant
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
    expect(repo.rows.find((r) => r.voiceSessionId === 'sess-enabled')?.sentAt).toBeTruthy();
  });

  it('processes normally when the flag gate reports enabled', async () => {
    await seedRow(repo, 'sess-flagged-on', new Date(NOW.getTime() - 1000));
    const deps = handlerDeps(repo);
    const isEnabledForTenant = vi.fn(async () => true);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant,
      now: () => NOW,
    });
    expect(result.sent).toBe(1);
    expect(isEnabledForTenant).toHaveBeenCalledWith(TENANT);
  });

  it('terminally expires a row older than maxAgeMs — even for a disabled tenant', async () => {
    const audit = new InMemoryAuditRepository();
    // Scheduled 31 minutes ago (default DROPPED_CALL_MAX_AGE_MS = 30min).
    await seedRow(repo, 'sess-stale', new Date(NOW.getTime() - 31 * 60_000));
    const deps = handlerDeps(repo, { audit });
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant: vi.fn(async () => false),
      now: () => NOW,
    });
    // Stale rows are reaped in Phase 1 (not the send batch) → expired=1,
    // due=0, and the flag is never consulted for them.
    expect(result).toEqual({ due: 0, sent: 0, suppressed: 0, skipped: 0, expired: 1, failed: 0 });
    const row = repo.rows.find((r) => r.voiceSessionId === 'sess-stale');
    expect(row?.suppressedReason).toBe('expired');
    // Expiry routes through the shared suppress path → same audit contract.
    const event = audit.events.find(
      (e) => e.eventType === 'dropped_call_recovery.suppressed',
    );
    expect(event?.metadata?.reason).toBe('expired');
  });

  it('a throwing flag gate isolates that tenant (skipped, left pending) without blocking others', async () => {
    const badTenant = '00000000-0000-0000-0000-0000000000e1';
    // Gate throws for badTenant, resolves true for TENANT.
    await repo.schedule({
      tenantId: badTenant,
      voiceSessionId: 'sess-gate-err',
      callerE164: E164,
      scheduledFor: new Date(NOW.getTime() - 2000),
    });
    await seedRow(repo, 'sess-gate-ok', new Date(NOW.getTime() - 1000));
    const isEnabledForTenant = vi.fn(async (t: string) => {
      if (t === badTenant) throw new Error('flag store down');
      return true;
    });
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant,
      now: () => NOW,
    });
    // badTenant's flag check threw → skipped (row pending); TENANT still sends.
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(1);
    const errRow = repo.rows.find((r) => r.voiceSessionId === 'sess-gate-err');
    expect(errRow?.sentAt).toBeFalsy();
    expect(errRow?.suppressedReason).toBeFalsy();
  });

  it('mixed batch counts every disposition correctly', async () => {
    const flaggedTenant = '00000000-0000-0000-0000-000000000002';
    await seedRow(repo, 'sess-mixed-send', new Date(NOW.getTime() - 1000));
    await seedRow(repo, 'sess-mixed-stale', new Date(NOW.getTime() - 45 * 60_000));
    await repo.schedule({
      tenantId: flaggedTenant,
      voiceSessionId: 'sess-mixed-skip',
      callerE164: E164,
      scheduledFor: new Date(NOW.getTime() - 1000),
    });
    const deps = handlerDeps(repo);
    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: deps,
      logger,
      isEnabledForTenant: vi.fn(async (tenantId: string) => tenantId === TENANT),
      now: () => NOW,
    });
    // send batch = 1 fresh enabled row (due=1); flaggedTenant skipped (1);
    // the 45-min-old row reaped as expired (1).
    expect(result).toEqual({ due: 1, sent: 1, suppressed: 0, skipped: 1, expired: 1, failed: 0 });
  });
});
