/**
 * Operator mode (Phase 12). Mirrors the same type defined in
 * `middleware/auth.ts` and `packages/shared/src/types.ts`. We re-declare
 * locally to keep this module a pure leaf — proposals depending on
 * middleware would invert the layering.
 */
export type Mode = 'supervisor' | 'tech' | 'both';

/**
 * Default per-mode auto-approve thresholds for proposals (Phase 12).
 *
 * The numbers correspond to the supervisor's *current_mode* on the
 * voice_session that produced the proposal. Higher = stricter.
 *
 * Tunable per tenant via `tenant_settings.auto_approve_threshold` (a
 * JSONB map keyed by mode); see `resolveAutoApproveThreshold`. The
 * defaults below are the locked launch values from
 * docs/superpowers/plans/2026-05-03-ship-this-week-analysis.md
 * (Appendix C, "Decisions locked").
 */
export const DEFAULT_AUTO_APPROVE_THRESHOLDS: Record<Mode, number> = {
  supervisor: 0.9,
  both: 0.92,
  tech: 0.95,
};

/**
 * Pre-Phase-12 default. Used when no `supervisorMode` is supplied —
 * i.e. callers that don't yet thread mode through (legacy paths,
 * backfills). Keeps the existing 0.9 behavior unchanged.
 */
export const LEGACY_AUTO_APPROVE_THRESHOLD = 0.9;

export interface ResolveThresholdInput {
  /**
   * The current_mode of the user-on-record for the originating session.
   * Read from `voice_sessions.supervisor_mode_at_start`. Optional so
   * legacy callers (no mode threaded yet) keep the pre-Phase-12 0.9
   * default.
   */
  supervisorMode?: Mode;

  /**
   * Tenant-wide presence: is *any* user currently in 'supervisor' or
   * 'both' mode? When false, the tenant is "unsupervised" and no
   * auto-approval is allowed regardless of confidence.
   *
   * Optional with a default of `true` so callers that don't know
   * (legacy paths) preserve existing behavior. Production callers
   * should always pass a real value via `isSupervisorPresent`.
   */
  supervisorPresent?: boolean;

  /**
   * Optional per-tenant override map from `tenant_settings.auto_approve_threshold`.
   * Shape: `{ supervisor?: number; tech?: number; both?: number }`. Any
   * missing mode falls through to `DEFAULT_AUTO_APPROVE_THRESHOLDS`.
   */
  tenantOverride?: Partial<Record<Mode, number>>;
}

/**
 * Resolve the confidence threshold a proposal must clear to auto-approve.
 *
 * Returns `null` when auto-approval is *categorically blocked* — i.e.
 * the tenant has no supervisor present. Callers must read `null` as
 * "do not auto-approve regardless of confidence" and route the
 * proposal through the unsupervised path (queue + SMS owner per
 * `tenant_settings.unsupervised_proposal_routing`).
 *
 * Resolution order (when `supervisorPresent !== false`):
 *   1. tenantOverride[mode]   (per-tenant, per-mode override)
 *   2. DEFAULT_AUTO_APPROVE_THRESHOLDS[mode]   (locked product default)
 *   3. LEGACY_AUTO_APPROVE_THRESHOLD          (mode unknown)
 */
export function resolveAutoApproveThreshold(
  input: ResolveThresholdInput = {},
): number | null {
  // The unsupervised guard is the hard rule — overrides every other
  // resolution. A confidence of 1.0 in an unsupervised tenant still
  // does not auto-approve. The proposal queues for review.
  if (input.supervisorPresent === false) {
    return null;
  }

  if (input.supervisorMode === undefined) {
    return LEGACY_AUTO_APPROVE_THRESHOLD;
  }

  const override = input.tenantOverride?.[input.supervisorMode];
  if (typeof override === 'number') {
    return override;
  }

  return DEFAULT_AUTO_APPROVE_THRESHOLDS[input.supervisorMode];
}

/**
 * True if `confidenceScore` is high enough to auto-approve given the
 * resolved `threshold`. Returns false when threshold is `null` (the
 * unsupervised case).
 *
 * Inequality: `confidenceScore >= threshold` (inclusive). Tested at
 * the boundary in `auto-approve.test.ts`.
 */
export function shouldAutoApprove(
  confidenceScore: number | undefined,
  threshold: number | null,
): boolean {
  if (threshold === null) return false;
  if (typeof confidenceScore !== 'number') return false;
  return confidenceScore >= threshold;
}
