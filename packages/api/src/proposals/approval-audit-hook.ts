/**
 * Governed Autonomy (docs/decisions.md D-014) — the auto-approval audit seam.
 *
 * When `createProposal` resolves a proposal to `'approved'` at decide time
 * (the fenced auto-approve path: capture-class + autonomous trust +
 * supervisor present + confidence >= mode threshold + catalog-grounded),
 * no human ever taps "approve". The reworded invariant (CLAUDE.md, D-014)
 * promises that *every* approval — human or policy — is audited. This hook
 * emits that audit event for the policy path so the trail matches the
 * wording instead of contradicting it.
 *
 * Injection mirrors `supervisor/hook.ts`: `createProposal` is a SYNCHRONOUS
 * pure builder with ~30 persistence call sites, so threading an `auditRepo`
 * through every caller is not viable. Instead app.ts installs one
 * process-wide auditor at boot via `configureProposalApprovalAuditor`, and
 * `createProposal` consults `getProposalApprovalAuditor()` on every
 * invocation. Unconfigured (every test/dev path that doesn't opt in) the
 * auditor is null and createProposal behaves byte-identically to before.
 *
 * The contract is fire-and-forget: `recordAutoApproval` returns a promise
 * the builder does not await, and the production implementation swallows
 * its own errors — a down audit store must never break proposal creation.
 * It is separate from the supervisor hook on purpose: auto-approval can
 * happen even when the supervisor is disabled or its snapshot is cold
 * (where `supervisorHook.onAutoApproved` does NOT fire), so the audit must
 * key off the resolved status, not the supervisor verdict.
 */
import type { AuditRepository } from '../audit/audit';
import { logProposalEvent } from './audit';
import { UNDO_WINDOW_MS } from './lifecycle';
import type { Proposal } from './proposal';
import type { Mode } from './auto-approve';

/**
 * Stable actor id for policy (machine) approvals. Querying the audit log
 * for `actor_id = AUTO_APPROVE_ACTOR_ID` (or `actor_role = 'system'`)
 * separates governed auto-approvals from human one-tap approvals.
 */
export const AUTO_APPROVE_ACTOR_ID = 'auto-approve-policy';

/** Provenance for an auto-approval, captured from the decide-time inputs. */
export interface AutoApprovalProvenance {
  /** Supervisor current_mode at generation time, if threaded. */
  supervisorMode?: Mode;
  /** Resolved mode threshold the confidence cleared (null = unsupervised). */
  threshold: number | null;
  /** The source trust tier that made the proposal auto-approve-eligible. */
  sourceTrustTier?: string;
}

export interface ProposalApprovalAuditor {
  /**
   * A proposal was auto-approved at decide time. Implementations must be
   * fire-and-forget internally (never throw, never block proposal creation).
   * NOTE: the proposal is built but not yet persisted at this point — the
   * audit row references its id, which the caller persists immediately
   * after in every production path (same contract as supervisor `onDecision`).
   */
  recordAutoApproval(
    proposal: Proposal,
    provenance: AutoApprovalProvenance,
  ): Promise<void>;
}

let activeAuditor: ProposalApprovalAuditor | null = null;

/**
 * Install (or with null, remove) the process-wide approval auditor.
 * Called once from app.ts at boot; tests that exercise it MUST reset to
 * null in afterEach so unrelated suites keep the pinned legacy behavior.
 */
export function configureProposalApprovalAuditor(
  auditor: ProposalApprovalAuditor | null,
): void {
  activeAuditor = auditor;
}

export function getProposalApprovalAuditor(): ProposalApprovalAuditor | null {
  return activeAuditor;
}

/** Defensive read of `payload._meta.overallConfidence` (mirrors auto-approve.ts). */
function readOverallConfidence(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const meta = (payload as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const overall = (meta as Record<string, unknown>).overallConfidence;
  return typeof overall === 'string' ? overall : undefined;
}

/**
 * Production auditor: emits a `proposal.approved` audit event attributing
 * the policy actor + provenance via the shared `logProposalEvent`. Errors
 * are swallowed (fire-and-forget) so a degraded audit store cannot break
 * proposal creation.
 */
export function createProposalApprovalAuditor(
  auditRepo: AuditRepository,
): ProposalApprovalAuditor {
  return {
    async recordAutoApproval(proposal, provenance) {
      try {
        await logProposalEvent(
          auditRepo,
          proposal,
          'proposal.approved',
          { id: AUTO_APPROVE_ACTOR_ID, role: 'system' },
          {
            auto: true,
            supervisorMode: provenance.supervisorMode ?? null,
            autoApproveThreshold: provenance.threshold,
            confidenceScore: proposal.confidenceScore ?? null,
            overallConfidence: readOverallConfidence(proposal.payload) ?? null,
            sourceTrustTier: provenance.sourceTrustTier ?? null,
            undoWindowMs: UNDO_WINDOW_MS,
          },
        );
      } catch {
        // Fire-and-forget: a down audit store must never break creation.
      }
    },
  };
}
