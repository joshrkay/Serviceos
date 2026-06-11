import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  loadVoiceAgentLiveAt,
  enableVoiceAgentLive,
  subscriptionAllowsVoice,
} from '../../src/voice/go-live';

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
