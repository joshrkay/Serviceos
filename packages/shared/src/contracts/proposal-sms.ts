/**
 * P2-034 — SMS approval transport keywords and event shapes.
 */
export const PROPOSAL_APPROVE_KEYWORDS = [
  'approve',
  'y',
  'yes',
  'ok',
] as const;

export const PROPOSAL_REJECT_KEYWORDS = ['reject', 'n', 'no'] as const;

export const PROPOSAL_EDIT_KEYWORDS = ['edit'] as const;

export type ProposalApproveKeyword = (typeof PROPOSAL_APPROVE_KEYWORDS)[number];
export type ProposalRejectKeyword = (typeof PROPOSAL_REJECT_KEYWORDS)[number];
export type ProposalEditKeyword = (typeof PROPOSAL_EDIT_KEYWORDS)[number];

export const ALL_PROPOSAL_SMS_KEYWORDS = [
  ...PROPOSAL_APPROVE_KEYWORDS,
  ...PROPOSAL_REJECT_KEYWORDS,
  ...PROPOSAL_EDIT_KEYWORDS,
] as const;

export type ProposalSmsDirection = 'outbound' | 'inbound';

export interface ProposalSmsEventRecord {
  id: string;
  tenantId: string;
  proposalId: string;
  direction: ProposalSmsDirection;
  messageSid: string;
  ownerE164: string;
  bodyPreview: string;
  createdAt: Date;
}
