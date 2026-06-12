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


export const APPROVE_TOKENS = PROPOSAL_APPROVE_KEYWORDS;
export const REJECT_TOKENS = PROPOSAL_REJECT_KEYWORDS;
export const EDIT_TOKENS = PROPOSAL_EDIT_KEYWORDS;

export type ParsedProposalSmsReply =
  | { intent: 'approve'; remainder: string }
  | { intent: 'reject'; remainder: string }
  | { intent: 'edit'; remainder: string }
  | { intent: 'unrecognized'; remainder: string };

function normalizeReplyBody(body: string): string {
  return body.trim().replace(/^["'“”‘’]+|["'“”‘’.,!?;:]+$/g, '').trim();
}

export function parseProposalSmsReply(body: string): ParsedProposalSmsReply {
  const normalized = normalizeReplyBody(body);
  if (!normalized) return { intent: 'unrecognized', remainder: '' };
  const [rawFirst = '', ...rest] = normalized.split(/\s+/);
  const first = rawFirst.toLowerCase().replace(/[^a-z]/g, '');
  const remainder = rest.join(' ').trim();
  if ((APPROVE_TOKENS as readonly string[]).includes(first)) {
    return { intent: 'approve', remainder };
  }
  if ((REJECT_TOKENS as readonly string[]).includes(first)) {
    return { intent: 'reject', remainder };
  }
  if ((EDIT_TOKENS as readonly string[]).includes(first)) {
    return { intent: 'edit', remainder };
  }
  return { intent: 'unrecognized', remainder: normalized };
}
