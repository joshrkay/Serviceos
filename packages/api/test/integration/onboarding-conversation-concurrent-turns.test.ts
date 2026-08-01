/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Review finding #4 — two browser tabs read the SAME persisted onboarding
 * `sessionId` out of localStorage and can POST a turn concurrently.
 * `PgOnboardingSessionRepository.update` (db/onboarding-session-repository.ts)
 * does an unconditional `UPDATE ... WHERE id = $1 AND tenant_id = $2` with NO
 * version/CAS column, and nothing upstream serialized two `turn()` calls for
 * the same session — a genuine read-then-write race: both requests read the
 * SAME pre-turn row, both independently advance the FSM from it, and the
 * second `update()` silently clobbers the first's transcript + extractions.
 * On the TERMINAL turn it is worse: both calls run `emitProposalBatches` and
 * persist two full, independently-random-ID'd proposal batches.
 *
 * This test drives the REAL race against real Postgres — two
 * `OnboardingConversationOrchestrator` instances (simulating two tabs / two
 * server-side request handlers), sharing the SAME `PgOnboardingSessionRepository`
 * and the SAME tenant + sessionId, firing `turn()` concurrently — and proves
 * the fix (a session-scoped Postgres advisory lock, `deps.pool`) actually
 * serializes them: no lost transcript/turnCount on a mid-conversation race,
 * and exactly ONE proposal batch on the terminal-turn race.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  PgOnboardingSessionRepository,
  type OnboardingSession,
  type OnboardingSessionRepository,
} from '../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { OnboardingConversationOrchestrator } from '../../src/ai/orchestration/onboarding-conversation';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

/**
 * Forces the read-side interleaving the mid-conversation race depends on,
 * instead of hoping Node's scheduler happens to produce it (it didn't,
 * reliably, in the original version of this test — see the test's own
 * comment below).
 *
 * Wraps a real `findById` with a bounded rendezvous: the Nth concurrent
 * caller to reach this exact point releases every waiting caller
 * (including itself) to proceed together, so if two `turn()` calls are NOT
 * serialized upstream, both are guaranteed to read the identical pre-turn
 * row before either has written anything — the precise interleaving that
 * makes the lost-update bug deterministic instead of a matter of luck.
 *
 * If the calls ARE serialized upstream (the fix: `withSessionLock` holds a
 * Postgres advisory lock for the whole turn), the second caller's
 * `findById` is never invoked until the first turn's lock releases, so no
 * second arrival ever shows up here — the first caller's wait simply times
 * out after `windowMs` and it proceeds alone, exactly as an unraced turn
 * would. No hang either way; the fixed path just pays one bounded, short
 * wait per test run.
 */
class RendezvousOnceSessionRepo implements OnboardingSessionRepository {
  private arrived = 0;
  private release!: () => void;
  private readonly gate: Promise<void>;

  constructor(
    private readonly inner: OnboardingSessionRepository,
    private readonly expectedArrivals: number,
    windowMs: number,
  ) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    setTimeout(() => this.release(), windowMs);
  }

  create(tenantId: string): Promise<OnboardingSession> {
    return this.inner.create(tenantId);
  }

  update(
    tenantId: string,
    id: string,
    updates: Parameters<OnboardingSessionRepository['update']>[2],
  ): Promise<OnboardingSession | null> {
    return this.inner.update(tenantId, id, updates);
  }

  async findById(tenantId: string, id: string): Promise<OnboardingSession | null> {
    this.arrived += 1;
    if (this.arrived >= this.expectedArrivals) {
      this.release();
    }
    await this.gate;
    return this.inner.findById(tenantId, id);
  }
}

function scriptedGateway(scripts: Record<string, unknown>): LLMGateway {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const payload = scripts[req.taskType];
      if (payload === undefined) {
        throw new Error(`No script for taskType=${req.taskType}`);
      }
      return {
        content: JSON.stringify(payload),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

const SCRIPTS = {
  extract_business_profile: {
    business_name: 'Concurrent Turns HVAC',
    city: 'Mesa',
    state: 'AZ',
    verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'hvac' }],
    service_descriptions: ['repair'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'hvac', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
    ],
    confidence_score: 0.9,
  },
  extract_team: { members: [], confidence_score: 0.9 },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
  extract_tools: { tools: [], confidence_score: 0.9 },
};

describe('Postgres integration — concurrent onboarding conversation turns (review finding #4)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let sessionRepo: PgOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    sessionRepo = new PgOnboardingSessionRepository(pool);
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  function orchestrator(): OnboardingConversationOrchestrator {
    // Two "tabs" each get their OWN orchestrator instance (as two server
    // request handlers would), sharing the same real-Postgres session repo
    // and the same `pool` so the advisory lock is genuinely shared.
    return new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(SCRIPTS),
      sessionRepo,
      proposalRepo,
      auditRepo,
      pool,
    });
  }

  it('two concurrent MID-conversation turns for the same session do not lose data (turnCount advances by 2, both utterances survive) — rendezvous-FORCED interleaving, mutation-proven', async () => {
    // Mutation-tested (worktree, not this tree): reverting the `turn()`
    // lock branch to `if (false && ...)` makes this test fail
    // deterministically — `turnCount` stuck at 1 and only one of the two
    // user texts present — because `RendezvousOnceSessionRepo` below GUARANTEES
    // both `findById` calls observe the identical pre-turn row before
    // either write happens, rather than relying on Node's scheduler to
    // interleave two near-instant in-memory-gateway calls closely enough
    // (an earlier version of this test used plain `Promise.all` with no
    // forced rendezvous and did NOT reliably fail under that same
    // mutation — this replaces that unproven version).
    const opened = await orchestrator().turn({ tenantId: tenant.tenantId, userId: tenant.userId });
    const sessionId = opened.sessionId;

    const rendezvousRepo = new RendezvousOnceSessionRepo(sessionRepo, 2, 150);
    function racingOrchestrator(): OnboardingConversationOrchestrator {
      return new OnboardingConversationOrchestrator({
        gateway: scriptedGateway(SCRIPTS),
        sessionRepo: rendezvousRepo,
        proposalRepo,
        auditRepo,
        pool,
      });
    }

    // Two "tabs" both answer the opening business-profile question at the
    // same instant. Without the lock, both read turnCount=0 / empty
    // transcript, both compute turnCount=1, and the second UPDATE clobbers
    // the first's transcript turn entirely.
    const [r1, r2] = await Promise.all([
      racingOrchestrator().turn({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        userMessage: 'Tab A: we run Concurrent Turns HVAC in Mesa AZ',
      }),
      racingOrchestrator().turn({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        userMessage: 'Tab B: we run Concurrent Turns HVAC in Mesa AZ',
      }),
    ]);

    expect(r1.sessionId).toBe(sessionId);
    expect(r2.sessionId).toBe(sessionId);

    // Read through the REAL (unwrapped) repo — the rendezvous wrapper only
    // needs to sit in front of the two racing calls above.
    const finalSession = await sessionRepo.findById(tenant.tenantId, sessionId);
    expect(finalSession).toBeTruthy();
    // Both turns genuinely advanced the FSM — turnCount reflects BOTH, not
    // one clobbering the other back down to 1.
    expect(finalSession!.turnCount).toBe(2);
    // Both user utterances are present in the transcript — proof neither
    // request's write silently discarded the other's.
    const userTexts = finalSession!.transcriptTurns.filter((t) => t.role === 'user').map((t) => t.text);
    expect(userTexts).toContain('Tab A: we run Concurrent Turns HVAC in Mesa AZ');
    expect(userTexts).toContain('Tab B: we run Concurrent Turns HVAC in Mesa AZ');
    expect(userTexts).toHaveLength(2);
  });

  it('two concurrent TERMINAL turns for the same session produce exactly ONE proposal batch, not two', async () => {
    const orch = orchestrator();
    const opened = await orch.turn({ tenantId: tenant.tenantId, userId: tenant.userId });
    const sessionId = opened.sessionId;

    // Drive to the "review" state sequentially (this part isn't the race
    // under test — the race is the FINAL confirming turn below).
    let last = opened;
    for (let i = 0; i < 12 && last.state !== 'review' && !last.completed; i++) {
      last = await orch.turn({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        userMessage: `Turn ${i}`,
      });
    }
    expect(last.state).toBe('review');
    expect(last.completed).toBe(false);

    // Two "tabs" both confirm at the same instant — the exact terminal-turn
    // race from the finding: without the lock both would run
    // emitProposalBatches and each persist its own full, independently
    // random-ID'd batch of onboarding_* proposals.
    const [c1, c2] = await Promise.all([
      orchestrator().turn({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        userMessage: 'looks good',
      }),
      orchestrator().turn({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        userMessage: 'looks good',
      }),
    ]);

    expect(c1.completed).toBe(true);
    expect(c2.completed).toBe(true);
    expect(c1.proposalIds.length).toBeGreaterThan(0);
    // The decisive assertion: both callers see the SAME batch (the loser
    // hit the terminal short-circuit and returned the winner's already-
    // persisted batch) rather than two DIFFERENT sets of proposal ids.
    expect([...c2.proposalIds].sort()).toEqual([...c1.proposalIds].sort());

    const finalSession = await sessionRepo.findById(tenant.tenantId, sessionId);
    expect(finalSession!.proposalBatchIds.length).toBe(c1.proposalIds.length);

    // Real Postgres row, not a memory snapshot — proves no duplicate batch
    // was appended to proposal_batch_ids server-side either.
    const { rows } = await pool.query(
      `SELECT proposal_batch_ids FROM onboarding_session WHERE id = $1`,
      [sessionId],
    );
    expect(rows[0].proposal_batch_ids).toHaveLength(c1.proposalIds.length);

    // And the proposal repo itself only holds ONE set of onboarding_* rows
    // for this session — not two.
    const allProposals = await proposalRepo.findByTenant(tenant.tenantId);
    const forThisSession = allProposals.filter(
      (p) => (p.sourceContext as Record<string, unknown> | undefined)?.conversationId === sessionId,
    );
    expect(forThisSession.length).toBe(c1.proposalIds.length);
  });
});
