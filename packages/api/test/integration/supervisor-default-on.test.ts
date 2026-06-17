/**
 * Postgres integration — Unit U3: supervisor agent default-ON with
 * per-tenant opt-out (decision D-004).
 *
 * Real-harness pin (Docker-gated; runs in PR CI). Mocked DBs are never the
 * only proof a query works — this exercises the WHOLE default-on path
 * against real tables: tenant_feature_flags (opt-out flag), supervisor_policies
 * (no active version ⇒ platform-default caps), tenant_budget_counters, and
 * the real PgProposalRepository the annotator sweep writes through.
 *
 * Two tenants, two assertions each:
 *   - UNPROVISIONED tenant (no opt-out flag row, no active policy version):
 *       (a) the advisory annotator sweep annotates a real ready_for_review
 *           proposal via the repo update path — status untouched; and
 *       (b) the SupervisorPolicyService enforces the PLATFORM-DEFAULT caps
 *           (a money proposal over the $50k per-proposal cap is blocked to
 *           'draft', downgrade-only — never auto-approved).
 *   - OPTED-OUT tenant (SUPERVISOR_DISABLED_FLAG=true): gets NEITHER — the
 *       inverted boot gate yields enabled=false, so the sweep skips it and
 *       the creation hook is permissive (parity with pre-supervisor behavior).
 *
 * The LLM gateway is mocked (canned JSON) — annotation content is not a DB
 * concern; everything else is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { PgSupervisorPolicyRepository } from '../../src/proposals/supervisor/policies-repo';
import { PgTenantBudgetCounterRepository } from '../../src/proposals/supervisor/budget-counters-repo';
import { SupervisorPolicyService } from '../../src/proposals/supervisor/service';
import { SUPERVISOR_DISABLED_FLAG } from '../../src/proposals/supervisor/hook';
import { runSupervisorAnnotationSweep } from '../../src/workers/supervisor-review-worker';
import { hasSupervisorAnnotation } from '../../src/proposals/supervisor/marker';
import {
  createProposal,
  type CreateProposalInput,
  type Proposal,
} from '../../src/proposals/proposal';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const GOOD_JSON = JSON.stringify({
  riskSummary: 'High-value invoice flagged for the reviewer.',
  flags: ['high_amount'],
});

function okResponse(content: string): LLMResponse {
  return {
    content,
    model: 'test-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * The exact inverted opt-out gate app.ts wires at boot, over the REAL
 * PgTenantFeatureFlagRepository: the platform flag is default-FALSE, so
 * `enabled = !disabled`. An unprovisioned tenant (no flag row) reads false
 * ⇒ enabled; a tenant with SUPERVISOR_DISABLED_FLAG=true reads true ⇒ off.
 */
function bootInvertedGate(
  flags: PgTenantFeatureFlagRepository,
): (tenantId: string) => Promise<boolean> {
  return async (tenantId: string) =>
    !(await flags.isEnabledForTenant(tenantId, SUPERVISOR_DISABLED_FLAG));
}

async function seedReadyProposal(
  repo: PgProposalRepository,
  tenantId: string,
  userId: string,
): Promise<Proposal> {
  const input: CreateProposalInput = {
    tenantId,
    proposalType: 'issue_invoice',
    payload: { totalCents: 125_000 },
    summary: 'Issue invoice for $1,250.00',
    confidenceScore: 0.8,
    createdBy: userId,
  };
  const built = createProposal(input);
  const ready: Proposal = { ...built, status: 'ready_for_review' };
  return repo.create(ready);
}

describe('Postgres integration — supervisor default-ON + per-tenant opt-out (Unit U3)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let flags: PgTenantFeatureFlagRepository;
  let supervisor: SupervisorPolicyService;
  let unprovisioned: { tenantId: string; userId: string };
  let optedOut: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    flags = new PgTenantFeatureFlagRepository(pool, new InMemoryFeatureFlagRepository());

    unprovisioned = await createTestTenant(pool);
    optedOut = await createTestTenant(pool);

    // Only the opted-out tenant gets the flag row; the other is left
    // unprovisioned to prove default-ON requires NO setup.
    await flags.setTenantFlag(optedOut.tenantId, SUPERVISOR_DISABLED_FLAG, true);

    supervisor = new SupervisorPolicyService({
      policies: new PgSupervisorPolicyRepository(pool),
      counters: new PgTenantBudgetCounterRepository(pool),
      isEnabledForTenant: bootInvertedGate(flags),
      logger: { warn: vi.fn() },
    });
  });

  // ── UNPROVISIONED tenant: default-ON ─────────────────────────────────────

  it('unprovisioned tenant: annotator sweep ANNOTATES a real ready_for_review proposal (status untouched)', async () => {
    const proposal = await seedReadyProposal(proposalRepo, unprovisioned.tenantId, unprovisioned.userId);
    const complete = vi.fn(async (_req: LLMRequest) => okResponse(GOOD_JSON));

    const result = await runSupervisorAnnotationSweep({
      listTenantIds: async () => [unprovisioned.tenantId],
      proposalRepo,
      gateway: { complete },
      isEnabledForTenant: bootInvertedGate(flags),
      logger: silentLogger,
    });

    expect(result.tenantsSwept).toBe(1);
    expect(result.annotated).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);

    const stored = await proposalRepo.findById(unprovisioned.tenantId, proposal.id);
    expect(stored!.status).toBe('ready_for_review'); // NEVER a status change
    expect(hasSupervisorAnnotation(stored!.payload)).toBe(true);
  });

  it('unprovisioned tenant: PLATFORM-DEFAULT cap BLOCKS an over-$50k money proposal (downgrade-only)', async () => {
    // No active supervisor_policies version → service falls back to the
    // PLATFORM_DEFAULT_SUPERVISOR_RULES ($50k per-proposal cap). Prime the
    // snapshot synchronously so evaluate() sees the loaded rules.
    await supervisor.prime(unprovisioned.tenantId);
    const decision = supervisor.evaluate({
      tenantId: unprovisioned.tenantId,
      proposalType: 'issue_invoice',
      actionClass: 'money',
      amountCents: 50_000_00 + 1,
    });
    expect(decision).not.toBeNull();
    expect(decision!.verdict).toBe('block'); // downgrade-only; never an upgrade
    expect(decision!.reasons.join(' ')).toMatch(/per-proposal cap/);

    // A normal-sized money proposal under the cap is left alone (no disruption).
    const ok = supervisor.evaluate({
      tenantId: unprovisioned.tenantId,
      proposalType: 'issue_invoice',
      actionClass: 'money',
      amountCents: 125_000,
    });
    expect(ok!.verdict).toBe('allow');
  });

  // ── OPTED-OUT tenant: gets NEITHER ───────────────────────────────────────

  it('opted-out tenant: annotator sweep SKIPS it (no gateway spend, no annotation)', async () => {
    const proposal = await seedReadyProposal(proposalRepo, optedOut.tenantId, optedOut.userId);
    const complete = vi.fn(async (_req: LLMRequest) => okResponse(GOOD_JSON));

    const result = await runSupervisorAnnotationSweep({
      listTenantIds: async () => [optedOut.tenantId],
      proposalRepo,
      gateway: { complete },
      isEnabledForTenant: bootInvertedGate(flags),
      logger: silentLogger,
    });

    expect(result.tenantsSwept).toBe(0); // skipped by the inverted opt-out gate
    expect(result.annotated).toBe(0);
    expect(complete).not.toHaveBeenCalled();

    const stored = await proposalRepo.findById(optedOut.tenantId, proposal.id);
    expect(hasSupervisorAnnotation(stored!.payload)).toBe(false);
  });

  it('opted-out tenant: supervisor policy is INERT (no cap enforcement — permissive parity)', async () => {
    await supervisor.prime(optedOut.tenantId); // primes enabled=false from the flag
    const decision = supervisor.evaluate({
      tenantId: optedOut.tenantId,
      proposalType: 'issue_invoice',
      actionClass: 'money',
      amountCents: 50_000_00 + 1, // would block for an enabled tenant
    });
    // enabled=false short-circuits to null (permissive) — the cap does not fire.
    expect(decision).toBeNull();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });
});
