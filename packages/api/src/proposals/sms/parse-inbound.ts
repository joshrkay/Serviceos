/**
 * P2-034 — Parse inbound owner SMS approval tokens.
 */
import {
  PROPOSAL_APPROVE_KEYWORDS,
  PROPOSAL_EDIT_KEYWORDS,
  PROPOSAL_REJECT_KEYWORDS,
} from '@ai-service-os/shared';

export type InboundProposalSmsAction = 'approve' | 'reject' | 'edit' | 'unknown';

export interface ParsedInboundProposalSms {
  action: InboundProposalSmsAction;
  token: string;
  remainder: string;
}

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, '');
}

export function parseInboundProposalSms(body: string): ParsedInboundProposalSms {
  const trimmed = body.trim();
  const [first, ...rest] = trimmed.split(/\s+/);
  const token = normalizeToken(first ?? '');

  if ((PROPOSAL_APPROVE_KEYWORDS as readonly string[]).includes(token)) {
    return { action: 'approve', token, remainder: rest.join(' ').trim() };
  }
  if ((PROPOSAL_REJECT_KEYWORDS as readonly string[]).includes(token)) {
    return { action: 'reject', token, remainder: rest.join(' ').trim() };
  }
  if ((PROPOSAL_EDIT_KEYWORDS as readonly string[]).includes(token)) {
    return { action: 'edit', token, remainder: rest.join(' ').trim() };
  }

  return { action: 'unknown', token, remainder: trimmed };
}
