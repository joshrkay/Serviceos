/**
 * A2 — the end-of-call summary row is written through PgCallSummaryRepository,
 * inside a tenant transaction under the RLS runtime role, never as a raw
 * `pool.query` on the privileged connection principal.
 *
 * `summarizeSession` used to INSERT into call_summaries (ENABLE + FORCE RLS,
 * `USING (tenant_id = current_setting('app.current_tenant_id')::UUID)`) with a
 * bare `pool.query`: no applyTenantContext, so the write ran as the privileged
 * principal with no tenant GUC, outside the database backstop - and under an
 * RLS-subject principal the same statement fails closed.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true: the repository's own statements are
 * logged to prove BEGIN / the tenant GUC + rls_app_runtime role (one statement)
 * wrap the INSERT, the real columns are pinned through summarizeSession, and
 * raw probes through `rls_app_runtime` (asTenant, the canonical leak suite's
 * pattern) prove tenant B cannot read tenant A's row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, RLS_APP_ROLE, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { PgCallSummaryRepository } from '../../src/ai/skills/pg-call-summary';
import { summarizeSession } from '../../src/ai/skills/summarize-session';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

/** A connection that behaves like the production app: rls_app_runtime, tenant GUC LOCAL. Always rolls back. */
async function asTenant<T>(pool: Pool, tenantId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** The harness pool with every statement on every checked-out client logged. */
function loggingPool(realPool: Pool, log: string[]): Pool {
  const instrumented = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await realPool.connect();
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
        log.push((typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text)).trim());
        return realQuery(...args);
      };
    }
    return client;
  };
  return { connect } as unknown as Pool;
}

const stubGateway = {
  complete: async (): Promise<LLMResponse> => ({
    content: JSON.stringify({ summary: 'Caller booked an AC tune-up for Friday.' }),
    model: 'stub-model',
    provider: 'stub',
    tokenUsage: { input: 10, output: 5, total: 15 },
    latencyMs: 1,
  }),
} as unknown as LLMGateway;

describe('A2 — call_summaries is written under the tenant RLS context and isolated per tenant', () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let rowA: string;

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    pool = await getSharedTestDb();
    ({ tenantId: tenantA } = await createTestTenant(pool));
    ({ tenantId: tenantB } = await createTestTenant(pool));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM call_summaries WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
    await closeSharedTestDb();
  });

  it("summarizeSession persists the row through the repository inside tenant A's own RLS transaction (pins real columns)", async () => {
    const log: string[] = [];
    const callSummaryRepo = new PgCallSummaryRepository(loggingPool(pool, log));
    const proposalIds = [crypto.randomUUID(), crypto.randomUUID()];

    const result = await summarizeSession({
      tenantId: tenantA,
      sessionId: crypto.randomUUID(),
      transcript: ['agent: How can I help?', 'caller: My AC needs a tune-up.', 'agent: Booked for Friday.'],
      proposalIds,
      intentDetected: 'schedule_appointment',
      durationMs: 75_000,
      gateway: stubGateway,
      callSummaryRepo,
      inboundCallerSession: true,
    });
    expect(result.qualityScore).toBeCloseTo(0.75, 5);

    // The INSERT ran inside BEGIN / tenant GUC + rls_app_runtime role (one statement) / COMMIT.
    const insert = log.findIndex((s) => s.startsWith('INSERT INTO call_summaries'));
    expect(insert).toBeGreaterThan(-1);
    expect(log.slice(0, insert)).toEqual(['BEGIN', TENANT_CONTEXT_WITH_ROLE_SQL]);
    expect(log[insert + 1]).toBe('COMMIT');

    const { rows } = await pool.query(
      `SELECT tenant_id, call_id, summary, detected_intent, proposal_ids, quality_score::float AS quality_score
         FROM call_summaries WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(rows).toEqual([
      {
        tenant_id: tenantA,
        call_id: null,
        summary: 'Caller booked an AC tune-up for Friday.',
        detected_intent: 'schedule_appointment',
        proposal_ids: proposalIds,
        quality_score: 0.75,
      },
    ]);
  });

  it("tenant B's RLS context cannot read tenant A's summary; tenant A's can", async () => {
    const created = await new PgCallSummaryRepository(pool).create(tenantA, {
      callId: null,
      summary: 'Tenant A only.',
      detectedIntent: null,
      proposalIds: [],
      qualityScore: null,
    });
    rowA = created.id;

    const seenByB = await asTenant(pool, tenantB, async (client) => {
      const res = await client.query('SELECT id FROM call_summaries WHERE id = $1 OR tenant_id = $2', [rowA, tenantA]);
      return res.rows;
    });
    expect(seenByB).toEqual([]);

    const seenByA = await asTenant(pool, tenantA, async (client) => {
      const res = await client.query<{ id: string }>('SELECT id FROM call_summaries WHERE id = $1', [rowA]);
      return res.rows.map((r) => r.id);
    });
    expect(seenByA).toEqual([rowA]);
  });

  it("tenant B's RLS context cannot write a row into tenant A (the policy's USING doubles as WITH CHECK)", async () => {
    await expect(
      asTenant(pool, tenantB, (client) =>
        client.query(`INSERT INTO call_summaries (tenant_id, summary) VALUES ($1, 'forged')`, [tenantA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the old raw INSERT shape fails closed under the RLS role with no tenant context', async () => {
    await expect(
      asTenant(pool, null, async (client) => {
        await client.query('RESET app.current_tenant_id');
        return client.query(
          `INSERT INTO call_summaries (tenant_id, call_id, summary, detected_intent, proposal_ids, quality_score)
           VALUES ($1, NULL, 'raw', NULL, '{}', NULL)`,
          [tenantA],
        );
      }),
    ).rejects.toThrow(/unrecognized configuration parameter|invalid input syntax for type uuid/);
  });
});
