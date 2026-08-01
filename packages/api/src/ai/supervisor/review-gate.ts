/**
 * N-004 (P2-037) — the pre-dispatch supervisor review gate seam.
 *
 * Like the createProposal supervisor hook (proposals/supervisor/hook.ts), the
 * gate is installed process-wide from app.ts and consulted at the outbound
 * dispatch chokepoint (voice-action-router, immediately before
 * routeUnsupervisedProposal — the AMEND P2-007 "before SMS dispatch" seam).
 * Unconfigured (every test/dev path that doesn't opt in) the gate is null and
 * dispatch is byte-identical to before.
 *
 * The gate OWNS all of its side effects (run the four checks, log ai_runs +
 * supervisor_reviews, attach N-002 markers, fire the escalation alert, and —
 * in enforce mode on a customer-harm critical — force the proposal to draft).
 * It returns only `{ hold }`: the caller skips dispatch when true. The gate is
 * fail-open — timeout/error return `{ hold: false }` so the money loop is never
 * blocked.
 */
import type { Proposal } from '../../proposals/proposal';

export interface SupervisorReviewGateInput {
  proposal: Proposal;
}

export interface SupervisorReviewGateResult {
  /** True only in enforce mode on a customer-harm critical — caller skips dispatch. */
  hold: boolean;
  /**
   * The proposal AFTER the gate's own writes (N-002 supervisor markers and, on
   * a hold, the forced-draft status). The gate persists these via proposalRepo,
   * but the caller holds an in-memory `outcome.proposal` that predates them — so
   * a rendered SMS built from the stale copy would omit the freshly-attached
   * supervisor warning. Callers that render/route the proposal MUST use this
   * value when present. Absent on no-op / fail-open paths (nothing changed).
   */
  proposal?: Proposal;
}

export interface SupervisorReviewGate {
  review(input: SupervisorReviewGateInput): Promise<SupervisorReviewGateResult>;
}

let activeGate: SupervisorReviewGate | null = null;

/**
 * Install (or with null, remove) the process-wide supervisor review gate.
 * Called once from app.ts at boot; tests that exercise the gate MUST reset it
 * to null in afterEach so unrelated suites keep the pinned legacy behavior.
 */
export function configureSupervisorReviewGate(gate: SupervisorReviewGate | null): void {
  activeGate = gate;
}

export function getSupervisorReviewGate(): SupervisorReviewGate | null {
  return activeGate;
}
