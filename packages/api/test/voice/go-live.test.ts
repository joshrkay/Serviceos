import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  loadVoiceAgentLiveAt,
  enableVoiceAgentLive,
  subscriptionAllowsVoice,
  maybeAutoGoLiveOnInboundEnd,
} from '../../src/voice/go-live';
import type { AuditRepository } from '../../src/audit/audit';

function mockPool(handler: (sql: string) => unknown): Pool {
  return { query: vi.fn(async (sql: string) => handler(sql)) } as unknown as Pool;
}

describe('go-live helpers', () => {
  it('loadVoiceAgentLiveAt returns null when unset', async () => {
    const pool = mockPool((sql) => {
      if (sql.includes('voice_agent_live_at')) return { rows: [{ voice_agent_live_at: null }] };
      return { rows: [] };
    });
    expect(await loadVoiceAgentLiveAt(pool, 't1')).toBeNull();
  });

  it('subscriptionAllowsVoice is true for trialing', async () => {
    const pool = mockPool((sql) => {
      if (sql.includes('subscription_status')) return { rows: [{ subscription_status: 'trialing' }] };
      return { rows: [] };
    });
    expect(await subscriptionAllowsVoice(pool, 't1')).toBe(true);
  });

  it('enableVoiceAgentLive uses COALESCE for idempotent set', async () => {
    const audit = { create: vi.fn(async () => undefined) };
    const pool = mockPool((sql) => {
      if (sql.includes('COALESCE')) return { rows: [] };
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: new Date('2026-05-20T12:00:00Z') }] };
      }
      return { rows: [] };
    });
    const result = await enableVoiceAgentLive(
      { pool, auditRepo: audit as never },
      { tenantId: 't1', actorId: 'u1', source: 'manual' },
    );
    expect(result.voiceAgentLive).toBe(true);
    const updateSql = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('COALESCE'),
    )?.[0] as string;
    expect(updateSql).toMatch(/COALESCE\(voice_agent_live_at/);
  });
});

/**
 * #1605 — `maybeAutoGoLiveOnInboundEnd` was previously unreachable (every
 * inbound call was blocked before it ever ended, while not_live) and had
 * no test coverage at all. It's the hook that flips a tenant live the
 * moment the owner's own test call (now let through the gate) ends — these
 * pin its exact gating + idempotency + failure-soft contract.
 */
describe('maybeAutoGoLiveOnInboundEnd', () => {
  function mockAudit(): AuditRepository {
    return { create: vi.fn(async () => undefined) } as unknown as AuditRepository;
  }

  /** Stateful pool: `live` flips true once the COALESCE UPDATE runs, so a
   * subsequent voice_agent_live_at read (inside enableVoiceAgentLive) sees
   * the just-written value — same as a real Postgres round-trip. */
  function statefulPool(opts: { subscriptionStatus: string | null; initiallyLive: boolean }) {
    let live = opts.initiallyLive;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('subscription_status')) {
        return { rows: [{ subscription_status: opts.subscriptionStatus }] };
      }
      if (sql.includes('COALESCE')) {
        live = true;
        return { rows: [] };
      }
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: live ? new Date('2026-10-04T12:00:00Z') : null }] };
      }
      return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it('no-ops for a non-voice_inbound channel (never touches the DB)', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId: 't1', channel: 'chat' });
    expect(query).not.toHaveBeenCalled();
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('no-ops when the subscription does not allow voice', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'canceled', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: 't1', channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('COALESCE'))).toBe(false);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('no-ops when the tenant is already live (idempotent)', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: true });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: 't1', channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('COALESCE'))).toBe(false);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('flips the tenant live with source=auto_test_call when voice-allowed and not yet live', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: 't1', channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('COALESCE'))).toBe(true);
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tenant.voice_agent_live',
        metadata: { source: 'auto_test_call' },
      }),
    );
  });

  it('is failure-soft: a DB error during the flip does not throw', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('subscription_status')) return { rows: [{ subscription_status: 'trialing' }] };
        if (sql.includes('voice_agent_live_at')) return { rows: [{ voice_agent_live_at: null }] };
        if (sql.includes('COALESCE')) throw new Error('db down');
        return { rows: [] };
      }),
    } as unknown as Pool;
    const auditRepo = mockAudit();
    await expect(
      maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId: 't1', channel: 'voice_inbound' }),
    ).resolves.toBeUndefined();
  });
});
