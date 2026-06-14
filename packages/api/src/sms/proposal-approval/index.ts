/**
 * P2-034 — SMS one-tap proposal approval. Barrel export.
 */
export {
  PROPOSAL_APPROVAL_KEYWORDS,
  APPROVE_KEYWORDS,
  REJECT_KEYWORDS,
  parseApprovalReply,
  generateApprovalCode,
  normalizeApprovalCode,
  smsApprovalCodeOf,
  proposalShortLine,
  lineItemsTotalCents,
  renderApprovalRequestSms,
  renderApprovalReplySms,
} from './render';
export type { ApprovalAction, ParsedApprovalReply, ReplyOutcome } from './render';
export {
  handleProposalApprovalSms,
  ProposalApprovalKeywordHandler,
  buildProposalApprovalKeywordHandler,
} from './handler';
export type { ProposalApprovalHandlerDeps } from './handler';
export { sendProposalApprovalRequest } from './compose';
export type {
  SendApprovalRequestDeps,
  SendApprovalRequestInput,
  SendApprovalRequestResult,
} from './compose';
