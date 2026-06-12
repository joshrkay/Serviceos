/**
 * Rivet P2 F-1 — createProposal supervisor hook + SupervisorPolicyService.
 *
 * Layers covered:
 *   1. Absent-hook regression pin: with no configure call, createProposal
 *      behaves exactly as before (same statuses, SAME payload reference —
 *      byte-identical path).
 *   2. Verdict application per supervisor-mode (mode-aware thresholds
 *      from Phase 12 stay in charge of the BASELINE; the supervisor can
 *      only downgrade it).
 *   3. Service mechanics: snapshot fail-open on cold cache, per-tenant
 *      flag gate, counter increments (UTC window truncation), audit
 *      emission, failure isolation of every side channel.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createProposal,
  type CreateProposalInput,
} from '../../../src/proposals/proposal';
import {
  configureSupervisorCreationHook,
} from '../../../src/proposals/supervisor/hook';
import {
  SUPERVISOR_BLOCKED_EVENT,
  SUPERVISOR_FORCED_REVIEW_EVENT,
  SupervisorPolicyService,
  recordExecutedProposalSpend,
} from '../../../src/proposals/supervisor/service';
import { InMemorySupervisorPolicyRepository } from '../../../src/proposals/supervisor/policies-repo';
import {
  AUTO_APPROVALS_COUNTER_KEY,
  DAILY_SPEND_COUNTER_KEY,
  InMemoryTenantBudgetCounterRepository,
  utcDayWindowStart,
  utcHourWindowStart,
} from '../../../src/proposals/supervisor/budget-counters-repo';
import { SUPERVISOR_MARKER_PATH } from '../../../src/proposals/supervisor/marker';
import type { SupervisorRules } from '../../../src/proposals/supervisor/policy';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-06-11T17:45:00.000Z');

afterEach(() => {
  configureSupervisorCreationHook(null);
});

/** Let fire-and-forget side channels (counters, audit) settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function baseInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    tenantId: TENANT,
    proposalType: 'create_customer',
    payload: { name: 'Ada Lovelace' },
    summary: 'Create customer Ada Lovelace',
    createdBy: 'agent-1',
    ...overrides,
  };
}

/** Inputs that auto-approve on the legacy path (autonomous capture, high conf). */
function autoApprovableInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return baseInput({ sourceTrustTier: 'autonomous', confidenceScore: 0.97, ...overrides });
}

interface ServiceSetup {
  service: SupervisorPolicyService;
  policies: InMemorySupervisorPolicyRepository;
  counters: InMemoryTenantBudgetCounterRepository;
  audit: InMemoryAuditRepository;
}

async function installService(
  rules: SupervisorRules | null,
  opts: {
    isEnabledForTenant?: (tenantId: string) => Promise<boolean>;
    prime?: boolean;
    now?: () => Date;
  } = {},
): Promise<ServiceSetup> {
  const policies = new InMemorySupervisorPolicyRepository();
  const counters = new InMemoryTenantBudgetCounterRepository();
  const audit = new InMemoryAuditRepository();
  if (rules) {
    const v = await policies.createVersion(TENANT, rules, 'test');
    await policies.activate(TENANT, v.version);
  }
  const service = new SupervisorPolicyService({
    policies,
    counters,
    auditRepo: audit,
    logger: { warn: () => undefined },
    now: opts.now ?? (() => NOW),
    ...(opts.isEnabledForTenant ? { isEnabledForTenant: opts.isEnabledForTenant } : {}),
  });
  if (opts.prime !== false) await service.prime(TENANT);
  configureSupervisorCreationHook(service);
  return { service, policies, counters, audit };
}

describe('absent hook — regression pin (byte-identical legacy path)', () => {
  it('autonomous capture + high confidence auto-approves, payload reference untouched', () => {
    const input = autoApprovableInput();
    const proposal = createProposal(input);
    expect(proposal.status).toBe('approved');
    expect(proposal.approvedAt).toBeInstanceOf(Date);
    // SAME reference — no clone, no marker, nothing supervisor-shaped.
    expect(proposal.payload).toBe(input.payload);
    expect(proposal.payload._meta).toBeUndefined();
  });

  it('default callers still land in draft with the original payload reference', () => {
    const input = baseInput();
    const proposal = createProposal(input);
    expect(proposal.status).toBe('draft');
    expect(proposal.payload).toBe(input.payload);
  });

  it('money class never auto-approves (legacy invariant intact)', () => {
    const proposal = createProposal(
      autoApprovableInput({ proposalType: 'issue_invoice', payload: { invoiceId: 'i-1' } }),
    );
    expect(proposal.status).toBe('draft');
  });
});

describe("verdict 'allow' — unchanged path", () => {
  it('permissive active policy leaves the auto-approve path untouched (no marker)', async () => {
    await installService({});
    const input = autoApprovableInput();
    const proposal = createProposal(input);
    expect(proposal.status).toBe('approved');
    expect(proposal.payload).toBe(input.payload);
    expect(proposal.payload._meta).toBeUndefined();
  });

  it('auto-approval increments the hourly counter at the UTC hour window', async () => {
    const { counters } = await installService({});
    createProposal(autoApprovableInput());
    createProposal(autoApprovableInput());
    await settle();
    const hourStart = utcHourWindowStart(NOW);
    expect(await counters.read(TENANT, AUTO_APPROVALS_COUNTER_KEY, hourStart)).toBe(2);
    expect(hourStart.toISOString()).toBe('2026-06-11T17:00:00.000Z');
  });
});

describe("verdict 'force_review'", () => {
  it('caps a would-be auto-approval at ready_for_review with marker + audit', async () => {
    const { audit } = await installService({ maxAutoApprovalsPerHour: 0 });
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('ready_for_review');
    expect(proposal.approvedAt).toBeUndefined();
    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(meta.markers).toEqual([
      expect.objectContaining({
        path: SUPERVISOR_MARKER_PATH,
        reason: expect.stringMatching(/^supervisor: .*auto-approvals budget/),
      }),
    ]);
    await settle();
    const events = await audit.findByEntity(TENANT, 'proposal', proposal.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(SUPERVISOR_FORCED_REVIEW_EVENT);
    expect(events[0].metadata?.verdict).toBe('force_review');
  });

  it('never raises a draft baseline (downgrade-only)', async () => {
    await installService({ maxAutoApprovalsPerHour: 0 });
    const proposal = createProposal(baseInput()); // no trust tier → draft baseline
    expect(proposal.status).toBe('draft');
  });

  it('daily spend cap forces review of money proposals based on counters + amount', async () => {
    const { counters, service } = await installService({ dailySpendCapCents: 100_000 });
    await counters.increment(TENANT, DAILY_SPEND_COUNTER_KEY, utcDayWindowStart(NOW), 80_000);
    await service.prime(TENANT); // re-snapshot with the seeded counter
    const proposal = createProposal(
      baseInput({ proposalType: 'issue_invoice', payload: { totalCents: 30_000 } }),
    );
    // Money baseline is draft already; the verdict cannot raise it but the
    // marker + audit trail still explain the supervisor's involvement.
    expect(proposal.status).toBe('draft');
    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(JSON.stringify(meta.markers)).toMatch(/daily spend cap/);
  });

  it('respects mode-aware baselines: tech mode (0.95) leaves a 0.92 proposal in draft, supervisor mode caps approved → ready_for_review', async () => {
    await installService({ maxAutoApprovalsPerHour: 0 });
    const supervisorMode = createProposal(
      autoApprovableInput({ confidenceScore: 0.92, supervisorMode: 'supervisor' }),
    );
    expect(supervisorMode.status).toBe('ready_for_review'); // baseline approved, capped

    const techMode = createProposal(
      autoApprovableInput({ confidenceScore: 0.92, supervisorMode: 'tech' }),
    );
    expect(techMode.status).toBe('draft'); // baseline draft, untouched

    const bothMode = createProposal(
      autoApprovableInput({ confidenceScore: 0.92, supervisorMode: 'both' }),
    );
    expect(bothMode.status).toBe('ready_for_review'); // 0.92 >= 0.92 → approved, capped
  });

  it('unsupervised tenants (supervisorPresent=false) keep their ready_for_review routing', async () => {
    await installService({ maxAutoApprovalsPerHour: 0 });
    const proposal = createProposal(autoApprovableInput({ supervisorPresent: false }));
    expect(proposal.status).toBe('ready_for_review');
  });
});

describe("verdict 'block'", () => {
  it('lands in draft with marker + supervisor.blocked_auto_approve audit', async () => {
    const { audit } = await installService({ blockedProposalTypes: ['create_customer'] });
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('draft');
    expect(proposal.approvedAt).toBeUndefined();
    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(JSON.stringify(meta.markers)).toMatch(/supervisor: proposal type 'create_customer' is blocked/);
    await settle();
    const events = await audit.findByEntity(TENANT, 'proposal', proposal.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(SUPERVISOR_BLOCKED_EVENT);
  });

  it('per-proposal cap blocks via the shared payloadHeadlineCents extraction', async () => {
    await installService({ perProposalCapCents: 50_000 });
    const over = createProposal(
      autoApprovableInput({ payload: { name: 'big job', totalCents: 60_000 } }),
    );
    expect(over.status).toBe('draft');
    const under = createProposal(
      autoApprovableInput({ payload: { name: 'small job', totalCents: 40_000 } }),
    );
    expect(under.status).toBe('approved');
  });

  it('suppresses unsupervised ready_for_review routing too (block beats queue)', async () => {
    await installService({ blockedProposalTypes: ['create_customer'] });
    const proposal = createProposal(autoApprovableInput({ supervisorPresent: false }));
    expect(proposal.status).toBe('draft');
  });
});

describe('service mechanics', () => {
  it('cold cache fails OPEN (legacy behavior) and applies policy once the snapshot lands', async () => {
    await installService({ blockedProposalTypes: ['create_customer'] }, { prime: false });
    const cold = createProposal(autoApprovableInput());
    expect(cold.status).toBe('approved'); // fail-open until snapshot loads
    await settle(); // background refresh triggered by the cold evaluate
    const warm = createProposal(autoApprovableInput());
    expect(warm.status).toBe('draft');
  });

  it("per-tenant flag gate: 'supervisor_agent' off → supervisor inert even with blocking rules", async () => {
    await installService(
      { blockedProposalTypes: ['create_customer'] },
      { isEnabledForTenant: async () => false },
    );
    const input = autoApprovableInput();
    const proposal = createProposal(input);
    expect(proposal.status).toBe('approved');
    expect(proposal.payload).toBe(input.payload);
  });

  it('no active policy version → DEFAULT_SUPERVISOR_RULES (permissive parity)', async () => {
    await installService(null);
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('approved');
  });

  it('counter-repo failures never break proposal creation (failure-isolated increments)', async () => {
    const { counters } = await installService({});
    vi.spyOn(counters, 'increment').mockRejectedValue(new Error('db down'));
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('approved');
    await settle(); // the rejected increment must not become an unhandled rejection
  });

  it('audit-repo failures never break proposal creation', async () => {
    const { audit } = await installService({ blockedProposalTypes: ['create_customer'] });
    vi.spyOn(audit, 'create').mockRejectedValue(new Error('audit down'));
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('draft');
    await settle();
  });

  it('policy-repo failure during refresh fails open and logs', async () => {
    const policies = new InMemorySupervisorPolicyRepository();
    vi.spyOn(policies, 'getActive').mockRejectedValue(new Error('pg down'));
    const warn = vi.fn();
    const service = new SupervisorPolicyService({
      policies,
      counters: new InMemoryTenantBudgetCounterRepository(),
      logger: { warn },
      now: () => NOW,
    });
    await service.prime(TENANT);
    configureSupervisorCreationHook(service);
    const proposal = createProposal(autoApprovableInput());
    expect(proposal.status).toBe('approved');
    expect(warn).toHaveBeenCalledWith(
      'supervisor: snapshot refresh failed',
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});

describe('recordExecutedProposalSpend (executor onExecuted seam)', () => {
  it('increments the UTC-day spend counter for executed money proposals', async () => {
    const { service, counters } = await installService({});
    const proposalRepo = new InMemoryProposalRepository();
    const proposal = await proposalRepo.create(
      createProposal(
        baseInput({ proposalType: 'issue_invoice', payload: { totalAmountCents: 45_000 } }),
      ),
    );
    await recordExecutedProposalSpend({
      service,
      proposalRepo,
      tenantId: TENANT,
      proposalId: proposal.id,
    });
    expect(
      await counters.read(TENANT, DAILY_SPEND_COUNTER_KEY, utcDayWindowStart(NOW)),
    ).toBe(45_000);
  });

  it('skips non-money proposals and amountless payloads', async () => {
    const { service, counters } = await installService({});
    const proposalRepo = new InMemoryProposalRepository();
    const capture = await proposalRepo.create(createProposal(baseInput()));
    const amountless = await proposalRepo.create(
      createProposal(baseInput({ proposalType: 'issue_invoice', payload: { invoiceId: 'i' } })),
    );
    await recordExecutedProposalSpend({ service, proposalRepo, tenantId: TENANT, proposalId: capture.id });
    await recordExecutedProposalSpend({ service, proposalRepo, tenantId: TENANT, proposalId: amountless.id });
    expect(
      await counters.read(TENANT, DAILY_SPEND_COUNTER_KEY, utcDayWindowStart(NOW)),
    ).toBe(0);
  });

  it('never throws — repo failures are contained and logged', async () => {
    const { service } = await installService({});
    const warn = vi.fn();
    await expect(
      recordExecutedProposalSpend({
        service,
        proposalRepo: {
          findById: async () => {
            throw new Error('boom');
          },
        },
        tenantId: TENANT,
        proposalId: 'p-1',
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('feeds the in-process snapshot so the cap engages without a refresh', async () => {
    const { service } = await installService({ dailySpendCapCents: 40_000 });
    const proposalRepo = new InMemoryProposalRepository();
    const executed = await proposalRepo.create(
      createProposal(
        baseInput({ proposalType: 'issue_invoice', payload: { totalCents: 50_000 } }),
      ),
    );
    await recordExecutedProposalSpend({
      service,
      proposalRepo,
      tenantId: TENANT,
      proposalId: executed.id,
    });
    // Next money proposal sees 50_000 already spent > 40_000 cap → force_review.
    const next = createProposal(
      baseInput({ proposalType: 'issue_invoice', payload: { totalCents: 1_000 } }),
    );
    expect(JSON.stringify(next.payload._meta)).toMatch(/daily spend cap/);
  });
});
