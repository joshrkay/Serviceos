/**
 * Rivet P2 F-1 — Supervisor Agent v1, pure policy engine.
 *
 * Exhaustive table-driven coverage of `evaluateSupervisorPolicy` plus a
 * STRUCTURAL monotonicity assertion on `capInitialStatus`: for every
 * (verdict × baseline status) pair the engine can only DOWNGRADE
 * permissiveness — it can never turn a 'draft' into 'ready_for_review'
 * or anything into 'approved'. Money/irreversible classes therefore can
 * never receive an 'allow' upgrade by construction.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPERVISOR_RULES,
  PLATFORM_DEFAULT_SUPERVISOR_RULES,
  capInitialStatus,
  evaluateSupervisorPolicy,
  type InitialProposalStatus,
  type SupervisorActionClass,
  type SupervisorPolicyInput,
  type SupervisorRules,
  type SupervisorVerdict,
} from '../../../src/proposals/supervisor/policy';

function input(overrides: Partial<SupervisorPolicyInput> = {}): SupervisorPolicyInput {
  return {
    proposalType: 'create_customer',
    actionClass: 'capture',
    amountCents: null,
    counters: { dailySpendCents: 0, autoApprovalsThisHour: 0 },
    ...overrides,
  };
}

describe('evaluateSupervisorPolicy — permissive defaults', () => {
  it('DEFAULT_SUPERVISOR_RULES has every cap unset (permissive parity)', () => {
    expect(DEFAULT_SUPERVISOR_RULES).toEqual({});
  });

  const parityCases: Array<[string, SupervisorPolicyInput]> = [
    ['capture, no amount', input()],
    ['money, large amount', input({ proposalType: 'issue_invoice', actionClass: 'money', amountCents: 10_000_000 })],
    ['irreversible', input({ proposalType: 'cancel_appointment', actionClass: 'irreversible' })],
    ['comms', input({ proposalType: 'send_invoice', actionClass: 'comms', amountCents: 50_000 })],
    [
      'huge counters',
      input({ counters: { dailySpendCents: Number.MAX_SAFE_INTEGER, autoApprovalsThisHour: 9_999 } }),
    ],
  ];

  it.each(parityCases)('default rules always allow: %s', (_name, i) => {
    const result = evaluateSupervisorPolicy(i, DEFAULT_SUPERVISOR_RULES);
    expect(result).toEqual({ verdict: 'allow', reasons: [] });
  });
});

describe('PLATFORM_DEFAULT_SUPERVISOR_RULES — Unit U3 default-on backstop', () => {
  it('declares exactly the three generous integer-cent backstop caps', () => {
    // Pin the platform-default values so any change is forced through this
    // suite (the comment in policy.ts documents the rationale per value).
    expect(PLATFORM_DEFAULT_SUPERVISOR_RULES).toEqual({
      perProposalCapCents: 50_000_00,
      dailySpendCapCents: 250_000_00,
      maxAutoApprovalsPerHour: 200,
    });
    // No type-level blocks by platform default.
    expect(PLATFORM_DEFAULT_SUPERVISOR_RULES.blockedProposalTypes).toBeUndefined();
  });

  it('everyday money proposals well under the caps are left untouched (no disruption)', () => {
    // A normal field-service invoice ($1,250) with modest counters allows.
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'issue_invoice',
        actionClass: 'money',
        amountCents: 125_000,
        counters: { dailySpendCents: 50_000_00, autoApprovalsThisHour: 10 },
      }),
      PLATFORM_DEFAULT_SUPERVISOR_RULES,
    );
    expect(result).toEqual({ verdict: 'allow', reasons: [] });
  });

  it('a single money proposal over the $50k per-proposal cap is BLOCKED', () => {
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'issue_invoice',
        actionClass: 'money',
        amountCents: 50_000_00 + 1,
      }),
      PLATFORM_DEFAULT_SUPERVISOR_RULES,
    );
    expect(result.verdict).toBe('block');
    expect(result.reasons[0]).toMatch(/per-proposal cap/);
  });

  it('projected daily spend over the $250k cap FORCES REVIEW (never blocked outright)', () => {
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'issue_invoice',
        actionClass: 'money',
        amountCents: 1_00,
        counters: { dailySpendCents: 250_000_00, autoApprovalsThisHour: 0 },
      }),
      PLATFORM_DEFAULT_SUPERVISOR_RULES,
    );
    expect(result.verdict).toBe('force_review');
    expect(result.reasons[0]).toMatch(/daily spend cap/);
  });

  it('at/over the 200/hour auto-approval budget FORCES REVIEW (class-agnostic)', () => {
    const result = evaluateSupervisorPolicy(
      input({ counters: { dailySpendCents: 0, autoApprovalsThisHour: 200 } }),
      PLATFORM_DEFAULT_SUPERVISOR_RULES,
    );
    expect(result.verdict).toBe('force_review');
    expect(result.reasons[0]).toMatch(/auto-approvals/);
  });

  it('caps never UPGRADE: the strongest verdict the default can yield is block→draft (downgrade-only)', () => {
    // Per-proposal cap (block) co-occurring with daily-spend + hourly (review):
    // block wins, and capInitialStatus drives any baseline down to 'draft'.
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'issue_invoice',
        actionClass: 'money',
        amountCents: 50_000_00 + 1,
        counters: { dailySpendCents: 250_000_00, autoApprovalsThisHour: 200 },
      }),
      PLATFORM_DEFAULT_SUPERVISOR_RULES,
    );
    expect(result.verdict).toBe('block');
    // The only effect on status is monotone-downgrade — there is no upgrade path.
    expect(capInitialStatus(result.verdict, 'approved')).toBe('draft');
    expect(capInitialStatus(result.verdict, 'draft')).toBe('draft');
  });
});

describe('evaluateSupervisorPolicy — blockedProposalTypes', () => {
  const rules: SupervisorRules = { blockedProposalTypes: ['issue_invoice', 'record_payment'] };

  it('blocks a listed proposal type with a reason', () => {
    const result = evaluateSupervisorPolicy(
      input({ proposalType: 'issue_invoice', actionClass: 'money' }),
      rules,
    );
    expect(result.verdict).toBe('block');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/issue_invoice/);
  });

  it('allows an unlisted proposal type', () => {
    const result = evaluateSupervisorPolicy(input({ proposalType: 'create_job' }), rules);
    expect(result).toEqual({ verdict: 'allow', reasons: [] });
  });

  it('empty blocklist is permissive', () => {
    const result = evaluateSupervisorPolicy(
      input({ proposalType: 'issue_invoice', actionClass: 'money' }),
      { blockedProposalTypes: [] },
    );
    expect(result.verdict).toBe('allow');
  });
});

describe('evaluateSupervisorPolicy — perProposalCapCents', () => {
  const rules: SupervisorRules = { perProposalCapCents: 50_000 };

  // actionClass alignment: cap only fires for money-class proposals.
  const table: Array<[string, number | null, SupervisorActionClass, SupervisorVerdict]> = [
    ['money: amount under cap', 49_999, 'money', 'allow'],
    ['money: amount exactly at cap', 50_000, 'money', 'allow'],
    ['money: amount over cap', 50_001, 'money', 'block'],
    ['money: no amount on payload — cap cannot apply', null, 'money', 'allow'],
    ['money: zero amount', 0, 'money', 'allow'],
    // Non-money classes must never be blocked by the money cap even with an amount.
    ['capture: large amount ignored', 50_001, 'capture', 'allow'],
    ['comms: large amount ignored', 99_999, 'comms', 'allow'],
    ['irreversible: large amount ignored', 100_000, 'irreversible', 'allow'],
  ];

  it.each(table)('%s → %s', (_name, amountCents, actionClass, verdict) => {
    const result = evaluateSupervisorPolicy(input({ amountCents, actionClass }), rules);
    expect(result.verdict).toBe(verdict);
    if (verdict === 'block') {
      expect(result.reasons[0]).toMatch(/per-proposal cap/);
    }
  });
});

describe('evaluateSupervisorPolicy — dailySpendCapCents', () => {
  const rules: SupervisorRules = { dailySpendCapCents: 100_000 };

  // actionClass alignment: cap only fires for money-class proposals.
  const table: Array<[string, number, number | null, SupervisorActionClass, SupervisorVerdict]> = [
    // [name, dailySpendCents already counted, amountCents, actionClass, expected]
    ['money: projected spend under cap', 40_000, 50_000, 'money', 'allow'],
    ['money: projected spend exactly at cap', 50_000, 50_000, 'money', 'allow'],
    ['money: projected spend over cap', 60_000, 50_000, 'money', 'force_review'],
    ['money: counter alone already over cap, amountless proposal', 100_001, null, 'money', 'force_review'],
    ['money: counter alone at cap, amountless proposal', 100_000, null, 'money', 'allow'],
    ['money: no amount and counter below cap', 0, null, 'money', 'allow'],
    // Non-money classes must never trigger the daily spend cap projection.
    ['capture: large spend counter ignored', 100_001, 50_000, 'capture', 'allow'],
    ['comms: large spend counter ignored', 100_001, 50_000, 'comms', 'allow'],
    ['irreversible: large spend counter ignored', 100_001, null, 'irreversible', 'allow'],
  ];

  it.each(table)('%s → %s', (_name, dailySpendCents, amountCents, actionClass, verdict) => {
    const result = evaluateSupervisorPolicy(
      input({ amountCents, actionClass, counters: { dailySpendCents, autoApprovalsThisHour: 0 } }),
      rules,
    );
    expect(result.verdict).toBe(verdict);
    if (verdict === 'force_review') {
      expect(result.reasons[0]).toMatch(/daily spend cap/);
    }
  });
});

describe('evaluateSupervisorPolicy — maxAutoApprovalsPerHour', () => {
  const rules: SupervisorRules = { maxAutoApprovalsPerHour: 5 };

  const table: Array<[string, number, SupervisorVerdict]> = [
    ['under the hourly budget', 4, 'allow'],
    ['budget exhausted exactly', 5, 'force_review'],
    ['budget exceeded', 6, 'force_review'],
    ['zero so far', 0, 'allow'],
  ];

  it.each(table)('%s → %s', (_name, autoApprovalsThisHour, verdict) => {
    const result = evaluateSupervisorPolicy(
      input({ counters: { dailySpendCents: 0, autoApprovalsThisHour } }),
      rules,
    );
    expect(result.verdict).toBe(verdict);
    if (verdict === 'force_review') {
      expect(result.reasons[0]).toMatch(/auto-approvals/);
    }
  });

  it('a zero budget always forces review', () => {
    const result = evaluateSupervisorPolicy(input(), { maxAutoApprovalsPerHour: 0 });
    expect(result.verdict).toBe('force_review');
  });
});

describe('evaluateSupervisorPolicy — combined rules', () => {
  it('block outranks force_review and reasons accumulate from every tripped rule (money class)', () => {
    const rules: SupervisorRules = {
      blockedProposalTypes: ['issue_invoice'],
      perProposalCapCents: 10_000,
      dailySpendCapCents: 5_000,
      maxAutoApprovalsPerHour: 0,
    };
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'issue_invoice',
        actionClass: 'money', // required for money caps to apply
        amountCents: 20_000,
        counters: { dailySpendCents: 6_000, autoApprovalsThisHour: 3 },
      }),
      rules,
    );
    expect(result.verdict).toBe('block');
    // blockedProposalTypes + perProposalCapCents (block) + dailySpendCap + hourly (review)
    expect(result.reasons.length).toBe(4);
  });

  it('non-money class skips money caps (blockedProposalTypes and hourly still apply)', () => {
    const rules: SupervisorRules = {
      blockedProposalTypes: ['send_invoice'],
      perProposalCapCents: 10_000,
      dailySpendCapCents: 5_000,
      maxAutoApprovalsPerHour: 0,
    };
    // capture class: money caps must not trip even with matching amounts/counters.
    const result = evaluateSupervisorPolicy(
      input({
        proposalType: 'send_invoice',
        actionClass: 'capture',
        amountCents: 20_000,
        counters: { dailySpendCents: 6_000, autoApprovalsThisHour: 3 },
      }),
      rules,
    );
    expect(result.verdict).toBe('block');
    // only blockedProposalTypes + maxAutoApprovalsPerHour — two reasons, no money cap reasons
    expect(result.reasons.length).toBe(2);
    expect(result.reasons.some((r) => r.includes('send_invoice'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('auto-approvals'))).toBe(true);
  });

  it('force_review reasons accumulate when several review rules trip (money class)', () => {
    const rules: SupervisorRules = { dailySpendCapCents: 100, maxAutoApprovalsPerHour: 1 };
    const result = evaluateSupervisorPolicy(
      input({
        actionClass: 'money',
        amountCents: 500,
        counters: { dailySpendCents: 0, autoApprovalsThisHour: 1 },
      }),
      rules,
    );
    expect(result.verdict).toBe('force_review');
    expect(result.reasons.length).toBe(2);
  });

  it('force_review: non-money class only trips maxAutoApprovalsPerHour, not dailySpendCap', () => {
    const rules: SupervisorRules = { dailySpendCapCents: 100, maxAutoApprovalsPerHour: 1 };
    const result = evaluateSupervisorPolicy(
      input({
        actionClass: 'capture',
        amountCents: 500,
        counters: { dailySpendCents: 0, autoApprovalsThisHour: 1 },
      }),
      rules,
    );
    expect(result.verdict).toBe('force_review');
    // Only maxAutoApprovalsPerHour — the dailySpendCap is money-only.
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toMatch(/auto-approvals/);
  });
});

describe('capInitialStatus — structural downgrade-only guarantee', () => {
  const RANK: Record<InitialProposalStatus, number> = {
    draft: 0,
    ready_for_review: 1,
    approved: 2,
  };
  const verdicts: SupervisorVerdict[] = ['allow', 'force_review', 'block'];
  const baselines: InitialProposalStatus[] = ['draft', 'ready_for_review', 'approved'];

  it('never increases permissiveness for ANY (verdict × baseline) pair', () => {
    for (const verdict of verdicts) {
      for (const baseline of baselines) {
        const result = capInitialStatus(verdict, baseline);
        expect(RANK[result]).toBeLessThanOrEqual(RANK[baseline]);
      }
    }
  });

  it('allow leaves every baseline unchanged', () => {
    for (const baseline of baselines) {
      expect(capInitialStatus('allow', baseline)).toBe(baseline);
    }
  });

  it("force_review caps 'approved' to 'ready_for_review' and never touches 'draft'", () => {
    expect(capInitialStatus('force_review', 'approved')).toBe('ready_for_review');
    expect(capInitialStatus('force_review', 'ready_for_review')).toBe('ready_for_review');
    expect(capInitialStatus('force_review', 'draft')).toBe('draft');
  });

  it("block always lands in 'draft'", () => {
    for (const baseline of baselines) {
      expect(capInitialStatus('block', baseline)).toBe('draft');
    }
  });

  it("the verdict vocabulary has no 'approve'/upgrade member (structural)", () => {
    // The SupervisorVerdict union is exactly these three values; an
    // upgrade verdict cannot be expressed. This pins the vocabulary so a
    // future addition is forced to revisit this suite.
    const exhaustive: Record<SupervisorVerdict, true> = {
      allow: true,
      force_review: true,
      block: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual(['allow', 'block', 'force_review']);
  });
});
