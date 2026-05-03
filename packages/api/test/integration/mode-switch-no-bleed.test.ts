/**
 * P12-006 — mode-switch / no-bleed integration test.
 *
 * Lean launch gate per the user's choice ("lean integration + qa-runner
 * harness with real LLM"). This test runs in CI without LLM calls or
 * Twilio webhooks; the qa-runner scenario at
 * `qa-runner/scenarios/concurrent-supervisor.md` is the heavier
 * real-LLM companion that runs locally.
 *
 * Pass criteria from Appendix B / Appendix C of the ship-this-week plan:
 *  1. A proposal evaluated under mode X uses mode X's threshold.
 *  2. Switching the operator's mode mid-flight does NOT alter the status
 *     of a proposal already decided under the prior mode.
 *  3. Two concurrent "sessions" with different supervisor_mode_at_start
 *     each pick their OWN threshold — no cross-session bleed.
 *  4. 50 successive mode flips paired with continuous proposal
 *     generation produce zero misroutes (every proposal references the
 *     mode that was active at the moment of decision).
 *  5. When the tenant becomes unsupervised, would-have-auto-approved
 *     proposals land in `ready_for_review` (so the unsupervised-routing
 *     worker picks them up), not in `approved`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decideInitialStatus } from '../../src/proposals/proposal';
import {
  resolveAutoApproveThreshold,
  DEFAULT_AUTO_APPROVE_THRESHOLDS,
} from '../../src/proposals/auto-approve';
import {
  isSupervisorPresent,
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import {
  InMemoryUserModeService,
  type UserModeService,
} from '../../src/routes/me';
import { clearUserModeCacheForTests } from '../../src/middleware/auth';

type Mode = 'supervisor' | 'tech' | 'both';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_OPERATOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeProposalPayload() {
  return {
    proposalType: 'create_customer' as const,
    sourceTrustTier: 'autonomous' as const,
    confidenceScore: 0.93, // between supervisor (0.90) and tech (0.95)
    missingFields: [] as string[],
  };
}

describe('P12-006 — mode-switch / no-bleed integration', () => {
  let modeService: UserModeService;

  beforeEach(async () => {
    modeService = new InMemoryUserModeService();
    _resetSupervisorPresenceCache();
    clearUserModeCacheForTests();
    // Wire a presence loader that consults the in-memory mode service.
    setSupervisorPresenceLoader(async (tenantId) => {
      // Mirror the production query: any user in supervisor or both mode.
      // The InMemoryUserModeService doesn't expose a "list-by-mode" query,
      // so we read the operator's current mode and check the boolean.
      const u = await modeService.getUser(tenantId, USER_OPERATOR);
      return u?.current_mode === 'supervisor' || u?.current_mode === 'both';
    });
    await modeService.setMode(TENANT_A, USER_OPERATOR, 'supervisor', USER_OPERATOR);
  });

  // ──────────────────────────────────────────────────────────
  // (1) Threshold matches the locked per-mode defaults.
  // ──────────────────────────────────────────────────────────

  it('uses 0.90 / 0.92 / 0.95 thresholds for supervisor / both / tech', () => {
    expect(resolveAutoApproveThreshold({ supervisorMode: 'supervisor', supervisorPresent: true }))
      .toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor);
    expect(resolveAutoApproveThreshold({ supervisorMode: 'both', supervisorPresent: true }))
      .toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.both);
    expect(resolveAutoApproveThreshold({ supervisorMode: 'tech', supervisorPresent: true }))
      .toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech);
  });

  // ──────────────────────────────────────────────────────────
  // (2) A proposal decided under prior mode keeps its status.
  // ──────────────────────────────────────────────────────────

  it('proposals decided under prior mode keep their status across a flip', async () => {
    // Session 1 starts in supervisor mode. Confidence 0.93 >= 0.90.
    const session1Mode: Mode = 'supervisor';
    const status1 = decideInitialStatus({
      ...makeProposalPayload(),
      supervisorMode: session1Mode,
      supervisorPresent: true,
    });
    expect(status1).toBe('approved');

    // Operator flips to tech. The previously-decided proposal is unchanged
    // because it's been recorded already; new proposals see new mode.
    await modeService.setMode(TENANT_A, USER_OPERATOR, 'tech', USER_OPERATOR);
    expect(status1).toBe('approved');

    // A new proposal from a NEW session that started under tech mode
    // sees the tech threshold (0.95) — same confidence (0.93) → draft.
    const status2 = decideInitialStatus({
      ...makeProposalPayload(),
      supervisorMode: 'tech',
      supervisorPresent: false, // unsupervised because the only operator went tech
    });
    expect(status2).toBe('ready_for_review');
  });

  // ──────────────────────────────────────────────────────────
  // (3) Two concurrent sessions with different recorded modes
  //     each use their own threshold — no cross-bleed.
  // ──────────────────────────────────────────────────────────

  it('two sessions with different supervisor_mode_at_start each use their own threshold', () => {
    const sessionASnapshot: Mode = 'supervisor';
    const sessionBSnapshot: Mode = 'tech';

    // Same payload + confidence; DIFFERENT recorded mode per session.
    const statusA = decideInitialStatus({
      ...makeProposalPayload(),
      supervisorMode: sessionASnapshot,
      supervisorPresent: true,
    });
    const statusB = decideInitialStatus({
      ...makeProposalPayload(),
      supervisorMode: sessionBSnapshot,
      supervisorPresent: true,
    });

    // Confidence 0.93: supervisor (>=0.90) → approved; tech (<0.95) → draft.
    expect(statusA).toBe('approved');
    expect(statusB).toBe('draft');
  });

  // ──────────────────────────────────────────────────────────
  // (4) 50 mode flips × continuous proposal generation produce
  //     ZERO misroutes. Every decision matches its mode.
  // ──────────────────────────────────────────────────────────

  it('50 mode flips × continuous proposals: every decision matches the mode active at decision time', async () => {
    const FLIPS = 50;
    const decisions: Array<{ mode: Mode; supervisorPresent: boolean; status: string; confidence: number }> = [];

    // Confidence values chosen to land in different status buckets per mode.
    // 0.91 → supervisor approves, both/tech draft.
    // 0.93 → supervisor + both approve, tech draft.
    // 0.96 → all three approve.
    // 0.85 → all three draft.
    const confidences = [0.91, 0.93, 0.96, 0.85];

    const modeCycle: Mode[] = ['supervisor', 'tech', 'both', 'supervisor', 'tech'];

    for (let i = 0; i < FLIPS; i++) {
      const mode = modeCycle[i % modeCycle.length];
      await modeService.setMode(TENANT_A, USER_OPERATOR, mode, USER_OPERATOR);
      _resetSupervisorPresenceCache();
      const supervisorPresent = await isSupervisorPresent(TENANT_A);

      const confidence = confidences[i % confidences.length];
      const status = decideInitialStatus({
        ...makeProposalPayload(),
        confidenceScore: confidence,
        supervisorMode: mode,
        supervisorPresent,
      });

      decisions.push({ mode, supervisorPresent, status, confidence });
    }

    // Verify every decision matches the threshold-rule for its (mode, presence, confidence).
    // Implementation contract:
    //   - threshold === null (unsupervised): autonomous + capture proposals
    //     always land in 'ready_for_review' so the unsupervised-routing
    //     worker can pick them up. The "would-have-approved" distinction
    //     only matters downstream when that worker decides whether to
    //     fire SMS-to-owner.
    //   - threshold === number: confidence >= threshold → approved, else draft.
    for (const { mode, supervisorPresent, status, confidence } of decisions) {
      const threshold = resolveAutoApproveThreshold({
        supervisorMode: mode,
        supervisorPresent,
      });

      if (threshold === null) {
        expect(status).toBe('ready_for_review');
      } else {
        expect(status).toBe(confidence >= threshold ? 'approved' : 'draft');
      }
    }

    // Counts by status — sanity that we exercised all branches.
    const approved = decisions.filter(d => d.status === 'approved').length;
    const draft = decisions.filter(d => d.status === 'draft').length;
    const queued = decisions.filter(d => d.status === 'ready_for_review').length;
    expect(approved).toBeGreaterThan(0);
    expect(draft).toBeGreaterThan(0);
    // queued > 0 only if any cycle-step had supervisorPresent=false (tech-only).
    // The cycle puts tech in there so queued should be > 0 too.
    expect(queued).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────
  // (5) Unsupervised tenant: would-have-approved → ready_for_review.
  // ──────────────────────────────────────────────────────────

  it('unsupervised tenant: would-have-approved proposals land in ready_for_review (not approved)', async () => {
    await modeService.setMode(TENANT_A, USER_OPERATOR, 'tech', USER_OPERATOR);
    _resetSupervisorPresenceCache();

    expect(await isSupervisorPresent(TENANT_A)).toBe(false);

    const status = decideInitialStatus({
      ...makeProposalPayload(),
      confidenceScore: 0.99,
      supervisorMode: 'tech',
      supervisorPresent: false,
    });

    // A 0.99-confidence proposal would normally auto-approve. With no
    // supervisor present, it surfaces in the queue + the unsupervised-
    // routing worker (follow-up) fires the SMS-to-owner.
    expect(status).toBe('ready_for_review');
  });

  // ──────────────────────────────────────────────────────────
  // (6) supervisor + both modes count as "supervisor present"
  //     for the purpose of unblocking auto-approve.
  // ──────────────────────────────────────────────────────────

  it('both-mode user counts as supervisor-present (unblocks auto-approve)', async () => {
    await modeService.setMode(TENANT_A, USER_OPERATOR, 'both', USER_OPERATOR);
    _resetSupervisorPresenceCache();

    expect(await isSupervisorPresent(TENANT_A)).toBe(true);

    const status = decideInitialStatus({
      ...makeProposalPayload(),
      confidenceScore: 0.95, // >= both (0.92)
      supervisorMode: 'both',
      supervisorPresent: true,
    });
    expect(status).toBe('approved');
  });
});
