import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createVoiceGate } from '../../src/voice/voice-gate';
import type { Pool } from 'pg';
import type { AuditRepository } from '../../src/audit/audit';

function mockPool(opts: {
  subscriptionStatus: string | null;
  voiceAgentLiveAt?: Date | null;
  dailyMinutes?: number;
  totalMinutes?: number;
  concurrent?: number;
}): Pool {
  const liveAt = opts.voiceAgentLiveAt === undefined ? new Date() : opts.voiceAgentLiveAt;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return { rows: [{ subscription_status: opts.subscriptionStatus }] };
      }
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: liveAt }] };
      }
      if (sql.includes('FROM voice_sessions')) {
        return {
          rows: [
            {
              daily_minutes: opts.dailyMinutes ?? 0,
              total_minutes: opts.totalMinutes ?? 0,
              concurrent: opts.concurrent ?? 0,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
}

function mockAudit(): AuditRepository {
  return {
    create: vi.fn(async () => undefined),
  } as unknown as AuditRepository;
}

describe('createVoiceGate', () => {
  let auditRepo: AuditRepository;

  beforeEach(() => {
    auditRepo = mockAudit();
  });

  it('allows when subscription is active', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'active' }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('allows when trialing and under caps', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', dailyMinutes: 10, totalMinutes: 20 }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(true);
  });

  it('blocks with no_billing when subscription is null', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: null }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_billing');
    expect(auditRepo.create).toHaveBeenCalledOnce();
  });

  it('blocks with no_billing when subscription is canceled', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'canceled' }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('no_billing');
  });

  it('blocks with trial_cap_total when trial total reached', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', totalMinutes: 100 }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('trial_cap_total');
    expect(auditRepo.create).toHaveBeenCalledOnce();
  });

  it('blocks with trial_cap_daily when daily cap reached', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', dailyMinutes: 60 }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('trial_cap_daily');
  });

  it('blocks with trial_cap_concurrent at concurrency limit', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', concurrent: 2 }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('trial_cap_concurrent');
  });

  it('blocks with not_live when trialing but voice_agent_live_at is null', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'trialing', voiceAgentLiveAt: null }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice_blocked_not_live' }),
    );
  });

  it('treats unknown subscription_status as no_billing', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'something_unexpected' }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('no_billing');
  });

  it('audit failure does not block (gate still returns block result)', async () => {
    const failingAudit = {
      create: vi.fn(async () => {
        throw new Error('audit DB down');
      }),
    } as unknown as AuditRepository;
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: null }),
      auditRepo: failingAudit,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
  });
});
