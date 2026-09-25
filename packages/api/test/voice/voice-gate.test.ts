import { describe, it, expect, beforeEach, vi } from 'vitest';
// Usage caps (trial minutes/concurrency, paid overage cap) read the AI-minute
// ledger and are covered against real Postgres in
// test/integration/voice-gate-usage.test.ts.
import { createVoiceGate } from '../../src/voice/voice-gate';
import type { Pool } from 'pg';
import type { AuditRepository } from '../../src/audit/audit';

function mockPool(opts: {
  subscriptionStatus: string | null;
  voiceAgentLiveAt?: Date | null;
  e1ReviewedScript?: string | null;
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
      if (sql.includes('e1_reviewed_script')) {
        return {
          rows: [{
            e1_reviewed_script:
              opts.e1ReviewedScript === undefined
                ? 'Reviewed safety script'
                : opts.e1ReviewedScript,
          }],
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

  it('blocks before AI routing when the tenant has no reviewed E1 safety script', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'active', e1ReviewedScript: null }),
      auditRepo,
    });

    const result = await gate({ tenantId: 't1', callSid: 'CA-E1' });

    expect(result).toEqual({ allowed: false, reason: 'e1_script_unreviewed' });
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice_blocked_e1_script_unreviewed' }),
    );
  });

  it('treats a whitespace-only E1 script as unreviewed', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'active', e1ReviewedScript: '   ' }),
      auditRepo,
    });

    expect(await gate({ tenantId: 't1', callSid: 'CA-E1-SPACE' })).toEqual({
      allowed: false,
      reason: 'e1_script_unreviewed',
    });
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
