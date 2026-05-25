import { Proposal, ProposalType, actionClassForProposalType } from '../../proposals/proposal';

/**
 * Build the short readback script the TTS provider reads to the
 * operator when a proposal lands. Keep it under ~20 words — the
 * plumber is in a truck, they need the gist plus the confirm cue.
 *
 * The phrase "Say approve or cancel." is added ONLY for proposals
 * that are voice-approvable (capture class). Money / comms /
 * irreversible proposals get "Tap to approve on screen." so we
 * never train operators to expect voice approval for risky actions.
 */

/**
 * True iff a proposal is safe to approve by voice. Per CLAUDE.md
 * and Decision 3: money, comms, and irreversible actions always
 * require screen-tap.
 */
export function isVoiceApprovable(type: ProposalType): boolean {
  return actionClassForProposalType(type) === 'capture';
}

/**
 * Friendly per-type readback templates. Placeholders are filled
 * from proposal.summary, payload, and confidenceScore. Unsupported
 * types get a generic template — safe fallback rather than silent
 * degradation.
 */
function summaryFor(proposal: Proposal): string {
  // The proposal summary is typically the transcript or a concise
  // action description. Trim so the sentence stays natural.
  const head = proposal.summary.length > 80 ? `${proposal.summary.slice(0, 77)}…` : proposal.summary;
  return head;
}

function cueFor(proposal: Proposal): string {
  return isVoiceApprovable(proposal.proposalType)
    ? 'Say approve or cancel.'
    : 'Tap to approve on screen.';
}

export function buildReadbackScript(proposal: Proposal): string {
  switch (proposal.proposalType) {
    case 'draft_invoice':
      return `Drafted an invoice: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'update_invoice':
      return `Invoice update: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'draft_estimate':
      return `Drafted an estimate: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'update_estimate':
      return `Estimate update: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'create_appointment':
      return `Scheduled an appointment: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'reschedule_appointment':
      return `Rescheduling: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'cancel_appointment':
      // Irreversible — voice-approvable is already false, but make
      // the cue explicit so operators don't try.
      return `Cancellation requested: ${summaryFor(proposal)}. Tap to confirm on screen.`;
    case 'reassign_appointment':
      return `Reassignment: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'create_customer':
      return `New customer: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'update_customer':
      return `Customer update: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'create_job':
      return `New job: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'add_note':
      return `Adding a note: ${summaryFor(proposal)}. ${cueFor(proposal)}`;
    case 'send_invoice':
      // Comms — explicitly require screen-tap.
      return `Ready to send an invoice: ${summaryFor(proposal)}. Tap to confirm on screen.`;
    case 'send_estimate':
      // Comms — explicitly require screen-tap.
      return `Ready to send an estimate: ${summaryFor(proposal)}. Tap to confirm on screen.`;
    case 'record_payment':
      // Money — explicitly require screen-tap.
      return `Ready to record a payment: ${summaryFor(proposal)}. Tap to confirm on screen.`;
    case 'voice_clarification':
      return `Didn't catch that. ${summaryFor(proposal)} Try again when ready.`;
    default:
      return `${summaryFor(proposal)}. ${cueFor(proposal)}`;
  }
}

/**
 * Deterministic voice-approval classifier. Given a short transcript
 * of the operator's reply ("yes", "no, cancel", "approve it"),
 * decide whether it is an approval / rejection / retry / unknown.
 *
 * Intentionally NOT backed by an LLM: we want predictable,
 * audit-friendly behavior for a security-sensitive approval gate.
 * Ambiguous replies return 'unknown' and the client falls back to
 * screen-tap UX.
 */
export type VoiceApprovalDecision = 'approve' | 'cancel' | 'repeat' | 'edit' | 'unknown';

const APPROVE_PATTERNS: RegExp[] = [
  /\bapprove\b/i,
  /\byes\b/i,
  /\byeah\b/i,
  /\byep\b/i,
  /\bconfirm(ed)?\b/i,
  /\bgo ahead\b/i,
  /\bdo it\b/i,
  /\bsend it\b/i,
  /\bokay approve\b/i,
];

const CANCEL_PATTERNS: RegExp[] = [
  /\bcancel\b/i,
  /\bno\b/i,
  /\bnope\b/i,
  /\bstop\b/i,
  /\bdon'?t\b/i,
  /\bnever mind\b/i,
  /\bnevermind\b/i,
  /\breject\b/i,
];

const REPEAT_PATTERNS: RegExp[] = [
  /\brepeat\b/i,
  /\bsay that again\b/i,
  /\bagain\b/i,
];

const EDIT_PATTERNS: RegExp[] = [/\bedit\b/i, /\bchange\b/i, /\bfix\b/i];

export function classifyVoiceApproval(transcript: string): VoiceApprovalDecision {
  const t = transcript.trim();
  if (t.length === 0) return 'unknown';

  // Check cancel BEFORE approve — "no, approve" and "approve, cancel"
  // are both ambiguous but a negation word should dominate for safety.
  if (CANCEL_PATTERNS.some((re) => re.test(t))) return 'cancel';
  if (APPROVE_PATTERNS.some((re) => re.test(t))) return 'approve';
  if (EDIT_PATTERNS.some((re) => re.test(t))) return 'edit';
  if (REPEAT_PATTERNS.some((re) => re.test(t))) return 'repeat';

  return 'unknown';
}
