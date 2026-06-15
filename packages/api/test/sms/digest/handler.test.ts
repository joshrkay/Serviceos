import { describe, it, expect, vi } from 'vitest';
import {
  handleDigestAckSms,
  type DigestAckHandlerDeps,
} from '../../../src/sms/digest/handler';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';

const TENANT = '11111111-1111-1111-1111-111111111111';

function makeCtx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: '+15551234567',
    body: 'LOOKS GOOD',
    messageSid: 'SM-ack-1',
    ...overrides,
  };
}

function makeDeps(
  opts: { role?: string | null; timezone?: string | null; entry?: { id: string } | null } = {},
) {
  const userRepo = {
    findByMobileNumber: vi
      .fn()
      .mockResolvedValue(
        opts.role === undefined
          ? { id: 'u1', role: 'owner' }
          : opts.role === null
            ? null
            : { id: 'u1', role: opts.role },
      ),
  };
  const digestRepo = {
    findByTenantAndDate: vi
      .fn()
      .mockResolvedValue(opts.entry === undefined ? { id: 'd1', tenantId: TENANT } : opts.entry),
    insert: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const settingsRepo = {
    findByTenant: vi
      .fn()
      .mockResolvedValue(opts.timezone === null ? null : { timezone: opts.timezone ?? 'America/Los_Angeles' }),
  };
  const deps = { userRepo, digestRepo, settingsRepo } as unknown as DigestAckHandlerDeps;
  return { deps, userRepo, digestRepo, settingsRepo };
}

describe("handleDigestAckSms (P5-020, on main's digest model)", () => {
  it('acks the tenant digest on LOOKS GOOD from the owner, recording the reply', async () => {
    const { deps, digestRepo, settingsRepo } = makeDeps({ timezone: 'America/Los_Angeles' });
    const result = await handleDigestAckSms(makeCtx({ body: 'Looks good!' }), deps);

    expect(settingsRepo.findByTenant).toHaveBeenCalledWith(TENANT);
    expect(digestRepo.findByTenantAndDate).toHaveBeenCalledWith(TENANT, expect.any(String));
    expect(digestRepo.update).toHaveBeenCalledWith(
      TENANT,
      expect.any(String),
      expect.objectContaining({ status: 'acked', ownerReply: 'Looks good!' }),
    );
    expect(result).toEqual({ handled: true, handler: 'digest-ack', reason: 'acked' });
  });

  it('reports handled even when no digest exists for the date (no update)', async () => {
    const { deps, digestRepo } = makeDeps({ entry: null });
    const result = await handleDigestAckSms(makeCtx(), deps);

    expect(digestRepo.update).not.toHaveBeenCalled();
    expect(result.reason).toBe('acked');
  });

  it('declines a non-owner mobile without touching settings or digests', async () => {
    const { deps, settingsRepo, digestRepo } = makeDeps({ role: 'technician' });
    const result = await handleDigestAckSms(makeCtx(), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');
    expect(settingsRepo.findByTenant).not.toHaveBeenCalled();
    expect(digestRepo.findByTenantAndDate).not.toHaveBeenCalled();
  });

  it('declines a body that is not a LOOKS GOOD ack', async () => {
    const { deps, settingsRepo } = makeDeps();
    const result = await handleDigestAckSms(makeCtx({ body: 'thanks' }), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unrecognized');
    expect(settingsRepo.findByTenant).not.toHaveBeenCalled();
  });
});
