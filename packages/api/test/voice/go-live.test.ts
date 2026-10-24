import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  loadVoiceAgentLiveAt,
  enableVoiceAgentLive,
  pauseVoiceAgentLive,
  subscriptionAllowsVoice,
  maybeAutoGoLiveOnInboundEnd,
} from '../../src/voice/go-live';
import type { AuditRepository } from '../../src/audit/audit';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { fakeTenantPool, type FakeResponder } from '../helpers/fake-tenant-pool';

/** The tenant_settings statements run under applyTenantContext, which requires a uuid. */
const T1 = '00000000-0000-4000-8000-00000000901e';

function mockPool(handler: (sql: string) => unknown): Pool {
  return { query: vi.fn(async (sql: string) => handler(sql)) } as unknown as Pool;
}

/** A pool whose clients answer `query` (a vi.fn over every statement, transaction control included). */
function tenantPool(query: ReturnType<typeof vi.fn>) {
  return fakeTenantPool(query as unknown as FakeResponder);
}

describe('go-live helpers', () => {
  it('loadVoiceAgentLiveAt reads on the tenant-scoped client it is handed, and returns null when unset', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('voice_agent_live_at') ? { rows: [{ voice_agent_live_at: null }] } : { rows: [] },
    );
    expect(await loadVoiceAgentLiveAt({ query } as unknown as PoolClient, T1)).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE tenant_id = $1'), [T1]);
  });

  it('subscriptionAllowsVoice is true for trialing', async () => {
    const pool = mockPool((sql) => {
      if (sql.includes('subscription_status')) return { rows: [{ subscription_status: 'trialing' }] };
      return { rows: [] };
    });
    expect(await subscriptionAllowsVoice(pool, T1)).toBe(true);
  });

  it('enableVoiceAgentLive sets voice_agent_live_at via a check-and-set UPDATE', async () => {
    const audit = { create: vi.fn(async () => undefined) };
    const liveAt = new Date('2026-05-20T12:00:00Z');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SET voice_agent_live_at = NOW()')) {
        return { rows: [{ voice_agent_live_at: liveAt }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const { pool } = tenantPool(query);
    const result = await enableVoiceAgentLive(
      { pool, auditRepo: audit as never },
      { tenantId: T1, actorId: 'u1', source: 'manual' },
    );
    expect(result.voiceAgentLive).toBe(true);
    expect(result.voiceAgentLiveAt).toBe(liveAt.toISOString());
    const updateSql = query.mock.calls.find((c) =>
      String(c[0]).includes('SET voice_agent_live_at = NOW()'),
    )?.[0] as string;
    // Guards against overwriting an existing value on a lost-update race
    // (same WHERE-guarded check-and-set pattern as activation.ts).
    expect(updateSql).toMatch(/WHERE tenant_id = \$1 AND voice_agent_live_at IS NULL/);
    expect(audit.create).toHaveBeenCalledOnce();
  });

  // Code-review finding (#1605 follow-up) — enableVoiceAgentLive's UPDATE was
  // COALESCE-idempotent on the STORED value (never overwrites an existing
  // voice_agent_live_at) but unconditionally emitted a `tenant.voice_agent_live`
  // audit row regardless of whether a transition actually happened. #1605
  // makes the auto path (maybeAutoGoLiveOnInboundEnd) reachable for the first
  // time, so a manual "Turn on AI answering" click racing (or following) the
  // auto-flip now produces two conflicting audit rows for one real transition.
  it('does not emit a duplicate audit event when the tenant is already live', async () => {
    const audit = { create: vi.fn(async () => undefined) };
    const { pool } = tenantPool(
      vi.fn(async (sql: string) => {
        // Already live: the WHERE-guarded UPDATE matches zero rows.
        if (sql.includes('SET voice_agent_live_at = NOW()')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('voice_agent_live_at')) {
          return { rows: [{ voice_agent_live_at: new Date('2026-05-20T12:00:00Z') }] };
        }
        return { rows: [] };
      }),
    );
    const result = await enableVoiceAgentLive(
      { pool, auditRepo: audit as never },
      { tenantId: T1, actorId: 'u1', source: 'manual' },
    );
    expect(result.voiceAgentLive).toBe(true);
    expect(audit.create).not.toHaveBeenCalled();
  });
});

/**
 * Raw-pg audit 2026-10-23 §4 P1.5 — the go-live writes run under the tenant's
 * context: inside POST /go-live and /pause the request client (so the stamp
 * commits or rolls back with its audit row), otherwise one short tenant
 * transaction that is committed before the audit write.
 */
describe('go-live writes — tenant context', () => {
  const stamp = new Date('2026-10-24T12:00:00Z');
  const answer = (sql: string) =>
    sql.includes('SET voice_agent_live_at = NOW()')
      ? { rows: [{ voice_agent_live_at: stamp }], rowCount: 1 }
      : sql.includes('SELECT voice_agent_live_at')
        ? { rows: [{ voice_agent_live_at: stamp }] }
        : { rows: [], rowCount: 1 };

  it('enable: the check-and-set (and its re-read) run in one tenant transaction, committed before the audit row', async () => {
    const fake = fakeTenantPool((sql) => (sql.includes('SET voice_agent_live_at = NOW()') ? { rows: [], rowCount: 0 } : answer(sql)));
    let openAtAudit = -1;
    const audit = { create: vi.fn(async () => { openAtAudit = fake.open(); }) };

    await enableVoiceAgentLive({ pool: fake.pool, auditRepo: audit as never }, { tenantId: T1, actorId: 'u1', source: 'manual' });

    expect(fake.checkouts()).toBe(1);
    expect(fake.statements.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'SELECT', 'COMMIT']);
    expect(fake.statements[1]).toMatchObject({ values: [T1] });
    expect(audit.create).not.toHaveBeenCalled();

    const fresh = fakeTenantPool(answer);
    const audit2 = { create: vi.fn(async () => { openAtAudit = fresh.open(); }) };
    await enableVoiceAgentLive({ pool: fresh.pool, auditRepo: audit2 as never }, { tenantId: T1, actorId: 'u1', source: 'manual' });
    expect(audit2.create).toHaveBeenCalledOnce();
    expect(openAtAudit).toBe(0);
  });

  it('pause: the UPDATE runs in one tenant transaction, committed before the audit row', async () => {
    const fake = fakeTenantPool(answer);
    let openAtAudit = -1;
    const audit = { create: vi.fn(async () => { openAtAudit = fake.open(); }) };

    await pauseVoiceAgentLive({ pool: fake.pool, auditRepo: audit as never }, { tenantId: T1, actorId: 'u1' });

    expect(fake.checkouts()).toBe(1);
    expect(fake.statements.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(fake.work()).toEqual([
      expect.objectContaining({ sql: expect.stringContaining('SET voice_agent_live_at = NULL'), values: [T1] }),
    ]);
    expect(openAtAudit).toBe(0);
  });

  it("inside a request scoped to the tenant, enable and pause run on the request's client and take no checkout", async () => {
    const fake = fakeTenantPool(answer);
    const requestQuery = vi.fn(async (sql: string) => answer(sql));
    const client = { query: requestQuery } as unknown as PoolClient;
    const audit = { create: vi.fn(async () => undefined) };

    await tenantContextStore.run({ client, tenantId: T1 }, async () => {
      await enableVoiceAgentLive({ pool: fake.pool, auditRepo: audit as never }, { tenantId: T1, actorId: 'u1', source: 'manual' });
      await pauseVoiceAgentLive({ pool: fake.pool, auditRepo: audit as never }, { tenantId: T1, actorId: 'u1' });
    });

    expect(fake.checkouts()).toBe(0);
    expect(requestQuery.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0])).toEqual(['UPDATE', 'UPDATE']);
    expect(audit.create).toHaveBeenCalledTimes(2);
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

  const AUTO_FLIP_AT = new Date('2026-10-04T12:00:00Z');

  /** Stateful pool: `live` flips true once the check-and-set UPDATE runs
   * (and only runs at all when it was still NULL), so a subsequent
   * voice_agent_live_at read sees the just-written value — same as a real
   * Postgres round-trip. */
  function statefulPool(opts: { subscriptionStatus: string | null; initiallyLive: boolean }) {
    let live = opts.initiallyLive;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('subscription_status')) {
        return { rows: [{ subscription_status: opts.subscriptionStatus }] };
      }
      if (sql.includes('SET voice_agent_live_at = NOW()')) {
        if (live) return { rows: [], rowCount: 0 };
        live = true;
        return { rows: [{ voice_agent_live_at: AUTO_FLIP_AT }], rowCount: 1 };
      }
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: live ? AUTO_FLIP_AT : null }] };
      }
      return { rows: [] };
    });
    return { pool: tenantPool(query).pool, query };
  }

  it('no-ops for a non-voice_inbound channel (never touches the DB)', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId: T1, channel: 'chat' });
    expect(query).not.toHaveBeenCalled();
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('no-ops when the subscription does not allow voice', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'canceled', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: T1, channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('SET voice_agent_live_at = NOW()'))).toBe(false);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('no-ops when the tenant is already live (idempotent)', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: true });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: T1, channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('SET voice_agent_live_at = NOW()'))).toBe(false);
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('flips the tenant live with source=auto_test_call when voice-allowed and not yet live', async () => {
    const { pool, query } = statefulPool({ subscriptionStatus: 'trialing', initiallyLive: false });
    const auditRepo = mockAudit();
    await maybeAutoGoLiveOnInboundEnd(
      { pool, auditRepo },
      { tenantId: T1, channel: 'voice_inbound' },
    );
    expect(query.mock.calls.some((c) => String(c[0]).includes('SET voice_agent_live_at = NOW()'))).toBe(true);
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tenant.voice_agent_live',
        metadata: { source: 'auto_test_call' },
      }),
    );
  });

  it('is failure-soft: a DB error during the flip does not throw', async () => {
    const { pool } = tenantPool(
      vi.fn(async (sql: string) => {
        if (sql.includes('subscription_status')) return { rows: [{ subscription_status: 'trialing' }] };
        // The specific UPDATE marker MUST be checked before the generic
        // 'voice_agent_live_at' substring below — the UPDATE text contains
        // that substring too, so a generic-first check would swallow this
        // branch and the throw would never execute (code-review finding).
        if (sql.includes('SET voice_agent_live_at = NOW()')) throw new Error('db down');
        if (sql.includes('voice_agent_live_at')) return { rows: [{ voice_agent_live_at: null }] };
        return { rows: [] };
      }),
    );
    const auditRepo = mockAudit();
    await expect(
      maybeAutoGoLiveOnInboundEnd({ pool, auditRepo }, { tenantId: T1, channel: 'voice_inbound' }),
    ).resolves.toBeUndefined();
  });
});
