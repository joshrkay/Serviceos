import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleDigestAckSms,
  type DigestAckHandlerDeps,
} from '../../../src/sms/digest/handler';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';

function makeCtx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: 'tenant-1',
    fromE164: '+15551234567',
    body: 'LOOKS GOOD',
    messageSid: 'SM-ack-1',
    ...overrides,
  };
}

function makeDeps(opts: { role?: string; timezone?: string | null; entry?: { id: string } | null } = {}) {
  const userRepo = {
    findByMobileNumber: vi
      .fn()
      .mockResolvedValue(opts.role === undefined ? { id: 'u1', role: 'owner' } : opts.role === null ? null : { id: 'u1', role: opts.role }),
  };
  const digestRepo = {
    findByTenantDate: vi.fn().mockResolvedValue(opts.entry === undefined ? { id: 'd1' } : opts.entry),
    markAcked: vi.fn().mockResolvedValue(undefined),
  };
  const settingsRepo = {
    findByTenant: vi
      .fn()
      .mockResolvedValue(opts.timezone === null ? null : { timezone: opts.timezone ?? 'America/Los_Angeles' }),
  };
  const deps = { userRepo, digestRepo, settingsRepo } as unknown as DigestAckHandlerDeps;
  return { deps, userRepo, digestRepo, settingsRepo };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('handleDigestAckSms', () => {
  it('looks up the digest by the tenant local date in the CONFIGURED timezone', async () => {
    // 04:30 UTC → 2026-03-14 (21:30 PDT, America/Los_Angeles) but
    // 2026-03-15 in America/New_York. The handler must use the tenant tz.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const { deps, digestRepo, settingsRepo } = makeDeps({ timezone: 'America/Los_Angeles' });
    const result = await handleDigestAckSms(makeCtx(), deps);

    expect(settingsRepo.findByTenant).toHaveBeenCalledWith('tenant-1');
    expect(digestRepo.findByTenantDate).toHaveBeenCalledWith('tenant-1', '2026-03-14');
    expect(digestRepo.markAcked).toHaveBeenCalledWith('tenant-1', 'd1');
    expect(result).toEqual({ handled: true, handler: 'digest-ack', reason: 'acked' });
  });

  it('falls back to America/New_York when the tenant has no timezone configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const { deps, digestRepo } = makeDeps({ timezone: null });
    await handleDigestAckSms(makeCtx(), deps);

    expect(digestRepo.findByTenantDate).toHaveBeenCalledWith('tenant-1', '2026-03-15');
  });

  it('returns handled:acked even when no digest row exists for the date (no markAcked)', async () => {
    const { deps, digestRepo } = makeDeps({ entry: null });
    const result = await handleDigestAckSms(makeCtx(), deps);

    expect(digestRepo.markAcked).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, handler: 'digest-ack', reason: 'acked' });
  });

  it('declines a non-owner mobile without touching settings or digests', async () => {
    const { deps, digestRepo, settingsRepo } = makeDeps({ role: 'technician' });
    const result = await handleDigestAckSms(makeCtx(), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');
    expect(settingsRepo.findByTenant).not.toHaveBeenCalled();
    expect(digestRepo.findByTenantDate).not.toHaveBeenCalled();
  });

  it('declines a body that is not a LOOKS GOOD ack', async () => {
    const { deps, settingsRepo } = makeDeps();
    const result = await handleDigestAckSms(makeCtx({ body: 'thanks' }), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unrecognized');
    expect(settingsRepo.findByTenant).not.toHaveBeenCalled();
  });
});
