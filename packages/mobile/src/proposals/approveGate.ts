// Pure (RN-free) approve-gate logic for the proposal review screen: which
// approval treatment each proposal type gets. Capture stays one-tap; comms /
// money / irreversible — and any type this build does not recognize — require
// an explicit, action-naming confirm. This is the client mirror of the
// server's lane rules (workflows.md §3; CLAUDE.md "Never auto-execute"); the
// server independently enforces routing (decideInitialStatus) and the batch
// backstop, so the client can only ever be stricter, never looser.
import { actionClassForProposalType } from '@ai-service-os/shared';
import { typeLabel } from './proposalReview';

export type ConfirmLane = 'comms' | 'money' | 'irreversible' | 'unknown';

export type ApproveGate =
  | { kind: 'one_tap' }
  | {
      kind: 'confirm';
      lane: ConfirmLane;
      /** Sheet heading naming the action, e.g. "Send invoice — this messages your customer." */
      title: string;
      /** Confirm button label, e.g. "Send it". */
      confirmLabel: string;
      /** Irreversible lane gets destructive styling on the confirm button. */
      destructive: boolean;
    };

const LANE_COPY: Record<ConfirmLane, { suffix: string; confirmLabel: string; destructive: boolean }> = {
  comms: { suffix: 'this messages your customer.', confirmLabel: 'Send it', destructive: false },
  money: { suffix: 'this moves money.', confirmLabel: 'Confirm', destructive: false },
  irreversible: { suffix: "this can't be undone.", confirmLabel: 'Yes, do it', destructive: true },
  // Fail closed: a type this build has not classified gets a neutral explicit
  // confirm — never a one-tap (and shared's isCaptureProposalType already
  // keeps unknowns out of batch).
  unknown: { suffix: 'review carefully before approving.', confirmLabel: 'Approve', destructive: false },
};

/**
 * Gate for a proposal, classified from its CURRENT type — callers must pass
 * the live proposal, not a mount-time snapshot (a voice_clarification can
 * resolve in place into a re-drafted money/comms proposal on the same screen).
 */
export function approveGateFor(proposal: { proposalType: string }): ApproveGate {
  const cls = actionClassForProposalType(proposal.proposalType);
  if (cls === 'capture') return { kind: 'one_tap' };
  const lane: ConfirmLane = cls === 'unknown' ? 'unknown' : cls;
  const copy = LANE_COPY[lane];
  return {
    kind: 'confirm',
    lane,
    title: `${typeLabel(proposal.proposalType)} — ${copy.suffix}`,
    confirmLabel: copy.confirmLabel,
    destructive: copy.destructive,
  };
}
