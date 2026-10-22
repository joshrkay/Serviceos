/**
 * TI-02 — the onboarding turn's concurrency guard holds nothing across the
 * extractor LLM calls, and is safe under PgBouncer transaction pooling.
 *
 * The guard it replaces took a SESSION-scoped `pg_advisory_lock` on a
 * main-pool connection and held it for the whole turn — up to six extractor
 * gateway calls — so every concurrent onboarding turn pinned a pooled
 * connection (inside the request transaction's own). And a session advisory
 * lock is not PgBouncer-safe: lock and unlock are separate transactions that
 * can land on different server backends, leaking the lock on one backend and
 * letting a second tab that lands there take it again.
 *
 * Now a turn computes from what it read with no connection held, then
 * commits its writes (audit rows, proposal batch, session update) in ONE
 * short tenant transaction behind a transaction-scoped lock, only if the
 * session is still the version it read. A turn that lost that race runs
 * again from the winner's state.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import express from 'express';
import request from 'supertest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import {
  InMemoryOnboardingSessionRepository,
  type OnboardingSessionRepository,
} from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { createOnboardingConversationRouter } from '../../../src/routes/onboarding-conversation';
import type { AuthenticatedRequest } from '../../../src/auth/clerk';

const TENANT = '7d1f6a8e-3b2c-4d5e-8f90-123456789abc';
const USER = 'user-ti02';

const PROFILE = {
  business_name: 'Commit Race HVAC',
  city: 'Mesa',
  state: 'AZ',
  verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'hvac' }],
  service_descriptions: ['repair'],
  confidence_score: 0.9,
};

/** A pool whose clients record every statement and how many are checked out. */
function recordingPool() {
  const statements: string[] = [];
  let checkedOut = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      checkedOut -= 1;
    }),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => {
      checkedOut += 1;
      return client;
    }),
  } as unknown as Pool;
  return { pool, statements, checkedOut: () => checkedOut };
}

function gateway(onCall: (req: LLMRequest) => void | Promise<void> = () => undefined): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      await onCall(req);
      return {
        content: JSON.stringify(PROFILE),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    }),
  } as unknown as LLMGateway;
}

describe('TI-02 — onboarding turn commit', () => {
  it('holds no pooled connection across the extractor call, and locks only inside its own short transaction', async () => {
    const db = recordingPool();
    const sessionRepo = new InMemoryOnboardingSessionRepository();
    const checkedOutAtLlmTime: number[] = [];
    const orch = new OnboardingConversationOrchestrator({
      gateway: gateway(() => {
        checkedOutAtLlmTime.push(db.checkedOut());
      }),
      sessionRepo,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool: db.pool,
    });
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });

    const r = await orch.turn({
      tenantId: TENANT,
      userId: USER,
      sessionId: opened.sessionId,
      userMessage: 'We run Commit Race HVAC in Mesa AZ',
    });

    expect(r.turnCount).toBe(1);
    expect(checkedOutAtLlmTime).toEqual([0]);
    expect(db.checkedOut()).toBe(0);
    // Transaction-scoped lock inside BEGIN … COMMIT: PgBouncer transaction
    // pooling keeps every statement of it on one server backend.
    const lockAt = db.statements.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(lockAt).toBeGreaterThan(db.statements.indexOf('BEGIN'));
    expect(db.statements.indexOf('COMMIT')).toBeGreaterThan(lockAt);
    // Never a session-scoped lock/unlock pair.
    expect(db.statements.some((s) => /pg_advisory_(un)?lock\(/.test(s))).toBe(false);
  });

  it('a turn whose session advanced while it was computing re-runs from the winner state (no lost update)', async () => {
    const db = recordingPool();
    const inner = new InMemoryOnboardingSessionRepository();
    const opened = await new OnboardingConversationOrchestrator({
      gateway: gateway(),
      sessionRepo: inner,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
    }).turn({ tenantId: TENANT, userId: USER });
    const sessionId = opened.sessionId;

    // Tab B commits its own turn while tab A is mid-extractor — exactly once.
    let raced = false;
    const orch = new OnboardingConversationOrchestrator({
      gateway: gateway(async () => {
        if (raced) return;
        raced = true;
        await new OnboardingConversationOrchestrator({
          gateway: gateway(),
          sessionRepo: inner,
          proposalRepo: new InMemoryProposalRepository(),
          auditRepo: new InMemoryAuditRepository(),
        }).turn({ tenantId: TENANT, userId: USER, sessionId, userMessage: 'Tab B: Commit Race HVAC, Mesa AZ' });
      }),
      sessionRepo: inner,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool: db.pool,
    });

    await orch.turn({ tenantId: TENANT, userId: USER, sessionId, userMessage: 'Tab A: Commit Race HVAC, Mesa AZ' });

    const final = await inner.findById(TENANT, sessionId);
    expect(final!.turnCount).toBe(2);
    const userTexts = final!.transcriptTurns.filter((t) => t.role === 'user').map((t) => t.text);
    expect(userTexts).toEqual(['Tab B: Commit Race HVAC, Mesa AZ', 'Tab A: Commit Race HVAC, Mesa AZ']);
    // The losing attempt rolled back; the retry committed.
    expect(db.statements.filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(db.statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('gives up with ONBOARDING_SESSION_CONFLICT when the session keeps advancing, and the route answers 409', async () => {
    const db = recordingPool();
    const inner = new InMemoryOnboardingSessionRepository();
    const seed = await inner.create(TENANT);
    // Every read inside the commit sees a newer turnCount than the turn read.
    let reads = 0;
    const alwaysAdvancing: OnboardingSessionRepository = {
      create: (t) => inner.create(t),
      update: (t, id, u) => inner.update(t, id, u),
      findById: async (t, id) => {
        const s = await inner.findById(t, id);
        reads += 1;
        return s ? { ...s, turnCount: s.turnCount + reads } : s;
      },
    };
    const orch = new OnboardingConversationOrchestrator({
      gateway: gateway(),
      sessionRepo: alwaysAdvancing,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool: db.pool,
    });

    await expect(
      orch.turn({ tenantId: TENANT, userId: USER, sessionId: seed.id, userMessage: 'hello' }),
    ).rejects.toThrow('ONBOARDING_SESSION_CONFLICT');
    // Nothing was written by any attempt.
    expect((await inner.findById(TENANT, seed.id))!.turnCount).toBe(0);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use('/api/onboarding/conversation', createOnboardingConversationRouter({ orchestrator: orch }));
    const res = await request(app)
      .post('/api/onboarding/conversation/turn')
      .send({ sessionId: seed.id, userMessage: 'hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ONBOARDING_SESSION_CONFLICT');
  });
});
