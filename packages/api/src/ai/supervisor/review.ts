/**
 * P2-037 — Second-pass supervisor review (rule-based v1).
 *
 * Runs before proposals reach the owner SMS queue. Never mutates payload;
 * attaches flags to sourceContext.supervisorReview and maps high-severity
 * flags into P2-035 marker inputs via sourceContext.brandVoiceDrift etc.
 */
import type { Proposal, ProposalType } from '../../proposals/proposal';
import type { SupervisorFlag, SupervisorReview } from '@ai-service-os/shared';

const SUPERVISED_TYPES: ReadonlySet<ProposalType> = new Set([
  'draft_estimate',
  'create_appointment',
  'create_booking',
]);

export interface SupervisorReviewResult {
  proposal: Proposal;
  review: SupervisorReview;
  heldForCritical: boolean;
}

function extractTotalCents(payload: Record<string, unknown>): number | null {
  const raw =
    payload.totalCents ?? payload.total_cents ?? payload.amountCents;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

export function runSupervisorReview(proposal: Proposal, now: Date = new Date()): SupervisorReviewResult {
  if (!SUPERVISED_TYPES.has(proposal.proposalType)) {
    return {
      proposal,
      review: { flags: [], reviewedAt: now.toISOString() },
      heldForCritical: false,
    };
  }

  const flags: SupervisorFlag[] = [];
  const payload = proposal.payload ?? {};
  const sourceContext = proposal.sourceContext ?? {};

  if (
    proposal.confidenceScore !== undefined &&
    proposal.confidenceScore < 0.8 &&
    (proposal.proposalType === 'create_booking' || proposal.proposalType === 'create_appointment')
  ) {
    flags.push({
      type: 'missed_urgency',
      severity: 'high',
      explanation: 'Booking urgency may not match caller signals',
    });
  }

  const total = extractTotalCents(payload);
  if (total !== null && total > 500_000) {
    flags.push({
      type: 'pricing_anomaly',
      severity: 'medium',
      explanation: 'Total exceeds typical job size — double-check pricing',
    });
  }

  if (sourceContext.brandVoiceDrift === true) {
    flags.push({
      type: 'brand_voice_drift',
      severity: 'low',
      explanation: 'Draft copy may not match brand voice',
    });
  }

  const review: SupervisorReview = {
    flags,
    reviewedAt: now.toISOString(),
  };

  const heldForCritical = flags.some((f) => f.severity === 'high');
  const next: Proposal = {
    ...proposal,
    sourceContext: {
      ...sourceContext,
      supervisorReview: review,
      ...(flags.some((f) => f.type === 'brand_voice_drift')
        ? { brandVoiceDrift: true }
        : {}),
    },
    ...(heldForCritical && proposal.status === 'approved'
      ? { status: 'ready_for_review' as const }
      : {}),
  };

  return { proposal: next, review, heldForCritical };
}
