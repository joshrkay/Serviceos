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
  pastDueGraceUntil?: Date | null;
  ownerPhone?: string | null;
  businessPhone?: string | null;
}): Pool {
  const liveAt = opts.voiceAgentLiveAt === undefined ? new Date() : opts.voiceAgentLiveAt;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return {
          rows: [
            {
              subscription_status: opts.subscriptionStatus,
              past_due_grace_until: opts.pastDueGraceUntil ?? null,
            },
          ],
        };
      }
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: liveAt }] };
      }
      if (sql.includes('owner_phone')) {
        return {
          rows: [
            { owner_phone: opts.ownerPhone ?? null, business_phone: opts.businessPhone ?? null },
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

  // #1605 — the owner's own caller-ID must pass the not_live gate as a test
  // session; every other caller still goes to voicemail until go-live.
  it('#1605: lets the owner\'s own cell through while not_live', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1', from: '+14805550100' });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('#1605: lets the tenant\'s own business number through while not_live', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        businessPhone: '+15125550999',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1', from: '+15125550999' });
    expect(result.allowed).toBe(true);
  });

  it('#1605: still blocks a stranger\'s number while not_live', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1', from: '+19995550111' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
  });

  it('#1605: still blocks when no caller-ID is given at all', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'trialing',
        voiceAgentLiveAt: null,
        ownerPhone: '+14805550100',
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_live');
  });

  it('treats unknown subscription_status as no_billing', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'something_unexpected' }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.reason).toBe('no_billing');
  });

  it('answers past_due calls while the 7-day grace is active', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'past_due',
        pastDueGraceUntil: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(true);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('blocks past_due to voicemail once the grace has lapsed', async () => {
    const gate = createVoiceGate({
      pool: mockPool({
        subscriptionStatus: 'past_due',
        pastDueGraceUntil: new Date(Date.now() - 60 * 1000),
      }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_billing');
  });

  it('blocks past_due to voicemail when no grace was ever stamped', async () => {
    const gate = createVoiceGate({
      pool: mockPool({ subscriptionStatus: 'past_due' }),
      auditRepo,
    });
    const result = await gate({ tenantId: 't1', callSid: 'CA1' });
    expect(result.allowed).toBe(false);
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
