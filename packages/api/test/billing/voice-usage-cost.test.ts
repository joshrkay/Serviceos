import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { PgVoiceUsageCostRepository } from '../../src/billing/voice-usage-cost';

const TENANT = '11111111-1111-4111-8111-111111111111';

function repository(query: ReturnType<typeof vi.fn>) {
  const repo = new PgVoiceUsageCostRepository({} as never);
  (repo as unknown as { withTenant: unknown }).withTenant = async (
    tenantId: string,
    callback: (client: PoolClient) => Promise<unknown>,
  ) => {
    expect(tenantId).toBe(TENANT);
    return callback({ query } as unknown as PoolClient);
  };
  return repo;
}

describe('PgVoiceUsageCostRepository', () => {
  it('records an idempotent provider-cost row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const occurredAt = new Date('2026-09-01T00:00:00Z');

    await repository(query).record({
      id: 'cost-1',
      tenantId: TENANT,
      sessionId: 'session-1',
      sourceId: 'request-1',
      provider: 'llm',
      usageSeconds: 42,
      providerCostMicroCents: 1234,
      occurredAt,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      'cost-1', TENANT, 'session-1', 'request-1', 'llm', 42, 1234, occurredAt,
    ]);
  });

  it('maps a period summary and defaults an empty result to zero', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-10-01T00:00:00Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        usage_seconds: '90',
        provider_cost_micro_cents: '4567',
        providers: ['twilio', 'llm'],
        incomplete_session_count: '1',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const repo = repository(query);

    await expect(repo.summarizePeriod(TENANT, start, end)).resolves.toEqual({
      usageSeconds: 90,
      providerCostMicroCents: 4567,
      providers: ['twilio', 'llm'],
      incompleteSessionCount: 1,
    });
    await expect(repo.summarizePeriod(TENANT, start, end)).resolves.toEqual({
      usageSeconds: 0,
      providerCostMicroCents: 0,
      providers: [],
      incompleteSessionCount: 0,
    });
  });

  it('queues and maps due Twilio reconciliation rows', async () => {
    const occurredAt = new Date('2026-09-02T03:04:05Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'recon-existing' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'recon-existing', tenant_id: TENANT, session_id: 'session-1',
        call_sid: 'CA123', account_sid: 'AC123', usage_seconds: '61',
        media_streams_used: true, occurred_at: occurredAt.toISOString(), attempts: '2',
      }] });
    const repo = repository(query);
    const input = {
      id: 'recon-new', tenantId: TENANT, sessionId: 'session-1', callSid: 'CA123',
      accountSid: 'AC123', usageSeconds: 61, mediaStreamsUsed: true, occurredAt,
    };

    await expect(repo.queueTwilioReconciliation(input)).resolves.toBe('recon-existing');
    await expect(repo.findDueTwilio(TENANT, occurredAt, 5)).resolves.toEqual([
      { ...input, id: 'recon-existing', attempts: 2 },
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([TENANT, occurredAt, 5]);
  });

  it('completes and defers reconciliation, truncating persisted errors', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repo = repository(query);
    const nextAttemptAt = new Date('2026-09-03T00:00:00Z');

    await repo.completeTwilio(TENANT, 'recon-1');
    await repo.deferTwilio(TENANT, 'recon-1', 'x'.repeat(600), nextAttemptAt);

    expect(query.mock.calls[0]?.[1]).toEqual([TENANT, 'recon-1']);
    expect(query.mock.calls[1]?.[1]).toEqual([TENANT, 'recon-1', 'x'.repeat(500), nextAttemptAt]);
  });
});
