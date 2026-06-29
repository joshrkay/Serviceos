import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import { DelayNoticeDeliveryState } from '../../src/notifications/delay-notifications';

type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rowsByCallIndex: Array<Record<string, unknown>[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      // U2b-2: skip the SET LOCAL transaction framing (BEGIN/COMMIT/ROLLBACK/
      // RESET/SET ROLE) so positional row arrays + calls[0]=context/calls[1]=
      // business assertions are unchanged. Tenant is now a set_config param.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b)/i.test(sql)) {
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult;
      }
      calls.push({ sql, params: params ?? [] });
      const rows = rowsByCallIndex[calls.length - 1] ?? [];
      return {
        rows,
        rowCount: rows.length,
        command: '',
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn(() => {
      releaseCount += 1;
    }) as unknown as PoolClient['release'],
  };

  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };

  return {
    pool: pool as Pool,
    calls,
    getReleaseCount: () => releaseCount,
  };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function makeState(overrides: Partial<DelayNoticeDeliveryState> = {}): DelayNoticeDeliveryState {
  return {
    idempotencyKey: 'appt-1:1',
    tenantId: TENANT_A,
    appointmentId: 'appt-1',
    delayVersion: 1,
    status: 'queued',
    channel: 'sms',
    attempts: 0,
    maxAttempts: 3,
    triggerContext: { thresholdMinutes: 15 },
    updatedAt: new Date('2026-04-28T10:00:00.000Z'),
    ...overrides,
  };
}

function rowFor(s: DelayNoticeDeliveryState): Record<string, unknown> {
  return {
    idempotency_key: s.idempotencyKey,
    tenant_id: s.tenantId,
    appointment_id: s.appointmentId,
    delay_version: s.delayVersion,
    status: s.status,
    channel: s.channel,
    attempts: s.attempts,
    max_attempts: s.maxAttempts,
    last_error: s.lastError ?? null,
    provider_message_id: s.providerMessageId ?? null,
    trigger_context: s.triggerContext ?? null,
    updated_at: s.updatedAt.toISOString(),
  };
}

describe('P0-022 — PgDelayNoticeStateRepository', () => {
  describe('PgDelayNoticeState.upsert', () => {
    it('PgDelayNoticeState upsert inserts new state with parameterized values and tenant context', async () => {
      const state = makeState();
      const { pool, calls, getReleaseCount } = makeMockPool([
        undefined, // SET app.current_tenant_id
        [rowFor(state)], // INSERT ... ON CONFLICT ... RETURNING *
      ]);

      const repo = new PgDelayNoticeStateRepository(pool);
      const result = await repo.upsert(state);

      // First call sets tenant context.
      expect(calls[0].sql).toContain('app.current_tenant_id');
      expect(calls[0].params).toContain(TENANT_A);

      // Second call is the upsert.
      expect(calls[1].sql).toContain('INSERT INTO delay_notice_state');
      expect(calls[1].sql).toContain('ON CONFLICT (idempotency_key) DO UPDATE');
      expect(calls[1].sql).not.toContain(TENANT_A);

      expect(calls[1].params).toEqual([
        state.idempotencyKey,
        state.tenantId,
        state.appointmentId,
        state.delayVersion,
        state.status,
        state.channel,
        state.attempts,
        state.maxAttempts,
        null, // lastError
        null, // providerMessageId
        JSON.stringify(state.triggerContext),
        state.updatedAt,
      ]);

      expect(getReleaseCount()).toBe(1);

      expect(result.idempotencyKey).toBe(state.idempotencyKey);
      expect(result.status).toBe('queued');
      expect(result.triggerContext).toEqual({ thresholdMinutes: 15 });
    });

    it('PgDelayNoticeState upsert overwrites an existing row (retry / status transition)', async () => {
      // Simulate the "we just sent another notice" case: a prior queued row now
      // becomes "sent" with attempts=1 and a providerMessageId.
      const sent = makeState({
        status: 'sent',
        attempts: 1,
        providerMessageId: 'twilio-abc-123',
        triggerContext: undefined,
      });
      const { pool, calls } = makeMockPool([undefined, [rowFor(sent)]]);
      const repo = new PgDelayNoticeStateRepository(pool);

      const result = await repo.upsert(sent);

      // Optional fields collapse to NULL when undefined.
      expect(calls[1].params[8]).toBeNull(); // lastError
      expect(calls[1].params[9]).toBe('twilio-abc-123'); // providerMessageId
      expect(calls[1].params[10]).toBeNull(); // triggerContext

      // The ON CONFLICT clause copies EXCLUDED.* across so the new status wins.
      expect(calls[1].sql).toContain('status = EXCLUDED.status');
      expect(calls[1].sql).toContain('attempts = EXCLUDED.attempts');
      expect(calls[1].sql).toContain('provider_message_id = EXCLUDED.provider_message_id');

      expect(result.status).toBe('sent');
      expect(result.attempts).toBe(1);
      expect(result.providerMessageId).toBe('twilio-abc-123');
    });

    it('PgDelayNoticeState upsert releases the connection even when the query throws', async () => {
      const failingClient: Partial<PoolClient> = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 } as unknown as QueryResult)
          .mockRejectedValueOnce(new Error('pg down')),
        release: vi.fn(),
      };
      const pool: Partial<Pool> = {
        connect: vi.fn(async () => failingClient as PoolClient) as unknown as Pool['connect'],
      };

      const repo = new PgDelayNoticeStateRepository(pool as Pool);
      await expect(repo.upsert(makeState())).rejects.toThrow('pg down');
      expect(failingClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PgDelayNoticeState.findByKey', () => {
    it('PgDelayNoticeState findByKey looks up a row by idempotency_key (parameterized)', async () => {
      const state = makeState();
      // Note: findByKey uses withClient, NOT withTenant, because the InMemory
      // interface is locked and does not expose a tenantId. So there is no
      // SET app.current_tenant_id call before the SELECT.
      const { pool, calls } = makeMockPool([[rowFor(state)]]);
      const repo = new PgDelayNoticeStateRepository(pool);

      const result = await repo.findByKey(state.idempotencyKey);

      expect(calls[0].sql).toContain('SELECT * FROM delay_notice_state');
      expect(calls[0].sql).toMatch(/WHERE\s+idempotency_key\s*=\s*\$1/);
      expect(calls[0].params).toEqual([state.idempotencyKey]);

      expect(result).not.toBeNull();
      expect(result?.idempotencyKey).toBe(state.idempotencyKey);
      expect(result?.tenantId).toBe(TENANT_A);
      expect(result?.status).toBe('queued');
    });

    it('PgDelayNoticeState findByKey returns null when no row matches', async () => {
      const { pool } = makeMockPool([[]]);
      const repo = new PgDelayNoticeStateRepository(pool);
      const result = await repo.findByKey('missing-key');
      expect(result).toBeNull();
    });

    it('PgDelayNoticeState findByKey releases the connection even when the query throws', async () => {
      const failingClient: Partial<PoolClient> = {
        query: vi.fn().mockRejectedValueOnce(new Error('pg down')),
        release: vi.fn(),
      };
      const pool: Partial<Pool> = {
        connect: vi.fn(async () => failingClient as PoolClient) as unknown as Pool['connect'],
      };

      const repo = new PgDelayNoticeStateRepository(pool as Pool);
      await expect(repo.findByKey('any-key')).rejects.toThrow('pg down');
      expect(failingClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PgDelayNoticeState tenant isolation invariants', () => {
    it('PgDelayNoticeState upsert sets tenant context before its real query', async () => {
      const state = makeState();
      const { pool, calls } = makeMockPool([undefined, [rowFor(state)]]);
      await new PgDelayNoticeStateRepository(pool).upsert(state);
      expect(calls[0].sql).toContain('app.current_tenant_id');
    });

    it('PgDelayNoticeState upsert never interpolates tenantId into business SQL', async () => {
      const state = makeState();
      const { pool, calls } = makeMockPool([undefined, [rowFor(state)]]);
      const repo = new PgDelayNoticeStateRepository(pool);

      await repo.upsert(state);
      const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
      expect(businessQueries.length).toBeGreaterThan(0);
      for (const c of businessQueries) {
        expect(c.sql).not.toContain(TENANT_A);
      }
    });
  });
});
