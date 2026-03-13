// AI Safety: Low confidence NEVER triggers auto-execution. All proposals require human approval.

import { Proposal, CreateProposalInput } from '../../proposals/proposal';
import { ConfidenceMetadata, getConfidenceLevel, ConfidenceLevel } from './confidence';

export interface ConfidencePolicy {
  highThreshold: number;
  mediumThreshold: number;
  lowThreshold: number;
}

export type ConfidenceAction =
  | { action: 'ready_for_review' }
  | { action: 'ready_for_review_with_warnings'; warnings: string[] }
  | { action: 'request_clarification'; questions: string[] }
  | { action: 'safe_failure'; reason: string; partialProposal?: Partial<CreateProposalInput> };

export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  highThreshold: 0.8,
  mediumThreshold: 0.5,
  lowThreshold: 0.3,
};

export function evaluateConfidence(
  score: number,
  factors: string[],
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY
): ConfidenceAction {
  if (score >= policy.highThreshold) {
    return { action: 'ready_for_review' };
  }

  if (score >= policy.mediumThreshold) {
    const warnings = factors.map(
      (factor) => `Factor '${factor}' may need verification (confidence: ${(score * 100).toFixed(0)}%)`
    );
    return { action: 'ready_for_review_with_warnings', warnings };
  }

  if (score >= policy.lowThreshold) {
    const questions = factors.map(
      (factor) => `Please clarify: ${factor} (confidence too low at ${(score * 100).toFixed(0)}%)`
    );
    return { action: 'request_clarification', questions };
  }

  return {
    action: 'safe_failure',
    reason: `Confidence score ${(score * 100).toFixed(0)}% is below the minimum threshold of ${(policy.lowThreshold * 100).toFixed(0)}%. Cannot proceed safely.`,
  };
}

export function applyConfidencePolicy(
  proposal: Proposal,
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY
): { proposal: Proposal; action: ConfidenceAction } {
  const score = proposal.confidenceScore ?? 0;
  const factors = proposal.confidenceFactors ?? [];

  const action = evaluateConfidence(score, factors, policy);

  // AI Safety: NEVER auto-execute regardless of confidence level.
  // High/medium confidence proposals can move to ready_for_review for human approval.
  // Low/very_low confidence proposals stay in draft.
  let updatedProposal: Proposal;

  if (action.action === 'ready_for_review' || action.action === 'ready_for_review_with_warnings') {
    updatedProposal = {
      ...proposal,
      status: proposal.status === 'draft' ? 'ready_for_review' : proposal.status,
      updatedAt: new Date(),
    };
  } else {
    // Low or very low confidence: keep proposal in draft
    updatedProposal = {
      ...proposal,
      updatedAt: new Date(),
    };
  }

  return { proposal: updatedProposal, action };
}
