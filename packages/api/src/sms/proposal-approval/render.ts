/**
 * P2-034 — SMS one-tap proposal approval: pure rendering + parsing.
 *
 * Lets a 1-5 person shop owner approve or decline a proposal by replying
 * to a text — no app, no login, glove-friendly. The owner never has to
 * open a screen for the common "one thing is waiting" case.
 *
 * This module is PURE (no I/O): it composes the outbound approval-request
 * SMS, the inbound reply confirmation, and parses the owner's reply into
 * an action. The handler (handler.ts) owns identity, persistence, and the
 * proposal-lifecycle calls.
 */
import { randomInt } from 'crypto';
import type { Proposal } from '../../proposals/proposal';

export type ApprovalAction = 'approve' | 'reject';

/**
 * First-token keywords the inbound dispatcher routes to this handler.
 * APPROVE/REJECT are the canonical verbs; YES/NO (+ OK/Y/N) are the
 * natural one-word replies an owner actually types. Kept deliberately
 * small so we don't squat common words other handlers may want.
 */
export const APPROVE_KEYWORDS = ['approve', 'yes', 'ok', 'y'] as const;
export const REJECT_KEYWORDS = ['reject', 'no', 'decline', 'n'] as const;
export const PROPOSAL_APPROVAL_KEYWORDS: readonly string[] = [
  ...APPROVE_KEYWORDS,
  ...REJECT_KEYWORDS,
];

const APPROVE_SET = new Set<string>(APPROVE_KEYWORDS);
const REJECT_SET = new Set<string>(REJECT_KEYWORDS);

/**
 * Crockford-style alphabet minus look-alikes (no 0/O/1/I/L) so a code
 * read off a phone screen and typed back never gets transcribed wrong.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** Generate a fresh short approval code (e.g. "A7KQ"). */
export function generateApprovalCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Normalize an owner-typed code for comparison: uppercase, strip
 * whitespace, and map the look-alikes we excluded from the alphabet back
 * onto their intended characters (O→0 is NOT in the alphabet, so map the
 * other way: O→Q? No — we simply fold the ambiguous inputs to nothing
 * risky). We map O→0... but 0 isn't valid, so instead fold I/L→J-adjacent?
 * Simpler and safe: uppercase + map the three classic confusions a human
 * is likely to type for our alphabet members: O→0 is impossible (0 absent),
 * so map O→"" would corrupt length. Instead map look-alikes to the closest
 * VALID member: O→Q, I→J, L→J, 1→J, 0→Q. This is forgiving without ever
 * producing an out-of-alphabet char.
 */
export function normalizeApprovalCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[OQ]/g, 'Q')
    .replace(/[IL1J]/g, 'J')
    .replace(/0/g, 'Q')
    .replace(/[^A-Z0-9]/g, '');
}

/** Read the approval code we stamped on a proposal when we texted it. */
export function smsApprovalCodeOf(proposal: Proposal): string | undefined {
  const ctx = proposal.sourceContext as Record<string, unknown> | undefined;
  const marker = ctx?.smsApproval as { code?: unknown } | undefined;
  return typeof marker?.code === 'string' ? marker.code : undefined;
}

export interface ParsedApprovalReply {
  action: ApprovalAction;
  /** Normalized code the owner included, if any ("APPROVE A7KQ"). */
  code?: string;
}

/**
 * Parse an inbound reply body into an action + optional code. The first
 * token is the keyword (already matched by the dispatcher); the second,
 * when present, is the proposal code. Returns null if the first token is
 * not an approval keyword (defensive — the dispatcher already filtered).
 */
export function parseApprovalReply(body: string): ParsedApprovalReply | null {
  const tokens = body.trim().split(/\s+/);
  const keyword = (tokens[0] ?? '').toLowerCase();
  const action: ApprovalAction | null = APPROVE_SET.has(keyword)
    ? 'approve'
    : REJECT_SET.has(keyword)
      ? 'reject'
      : null;
  if (!action) return null;

  const rawCode = tokens[1];
  const code = rawCode ? normalizeApprovalCode(rawCode) : undefined;
  return { action, ...(code ? { code } : {}) };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const TYPE_LABELS: Partial<Record<Proposal['proposalType'], string>> = {
  draft_invoice: 'Invoice',
  draft_estimate: 'Estimate',
  issue_invoice: 'Send invoice',
  send_invoice: 'Send invoice',
  send_estimate: 'Send estimate',
  record_payment: 'Payment',
  reschedule_appointment: 'Reschedule',
  cancel_appointment: 'Cancel appointment',
  create_appointment: 'New appointment',
  emergency_dispatch: 'Emergency dispatch',
};

/**
 * Sum line-item totals (cents) when every line carries a usable price.
 * Invoice lines use `unitPriceCents`; estimate lines use `unitPrice`
 * (also integer cents — see proposals/contracts). Returns undefined when
 * the payload has no priceable lines, so the caller falls back to the
 * proposal summary rather than printing "$0.00".
 */
export function lineItemsTotalCents(proposal: Proposal): number | undefined {
  const lines = (proposal.payload as { lineItems?: unknown }).lineItems;
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  let total = 0;
  for (const raw of lines) {
    const li = raw as Record<string, unknown>;
    const qty = Number(li.quantity ?? 1) || 1;
    const cents = Number(li.unitPriceCents ?? li.unitPrice);
    if (!Number.isFinite(cents)) return undefined;
    total += Math.round(cents * qty);
  }
  return total;
}

/** One short, human line describing what the owner is approving. */
export function proposalShortLine(proposal: Proposal): string {
  const label = TYPE_LABELS[proposal.proposalType];
  const total = lineItemsTotalCents(proposal);
  if (label && total !== undefined) {
    return `${label} — ${formatCents(total)}`;
  }
  if (label) return `${label}: ${proposal.summary}`;
  return proposal.summary;
}

const SMS_MAX_CHARS = 320;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Outbound: the approval-request text the owner receives. Stays under
 * one-ish SMS segment budget; the reply instruction is always intact (we
 * clip the description, never the actionable part).
 */
export function renderApprovalRequestSms(proposal: Proposal, code: string): string {
  const instruction = `Reply YES ${code} to approve or NO ${code} to decline.`;
  const room = SMS_MAX_CHARS - instruction.length - 1;
  return `${clip(proposalShortLine(proposal), Math.max(0, room))}\n${instruction}`;
}

export type ReplyOutcome =
  | 'approved'
  | 'rejected'
  | 'needs_code'
  | 'nothing_pending'
  | 'not_found'
  | 'needs_details';

/** Inbound: the confirmation we text back after acting on a reply. */
export function renderApprovalReplySms(
  outcome: ReplyOutcome,
  ctx: { proposal?: Proposal; pendingCount?: number } = {},
): string {
  switch (outcome) {
    case 'approved':
      return clip(
        `✓ Approved${ctx.proposal ? ` — ${proposalShortLine(ctx.proposal)}` : ''}.`,
        SMS_MAX_CHARS,
      );
    case 'rejected':
      return clip(
        `✓ Declined${ctx.proposal ? ` — ${proposalShortLine(ctx.proposal)}` : ''}. Nothing will go out.`,
        SMS_MAX_CHARS,
      );
    case 'needs_code':
      return `You have ${ctx.pendingCount ?? 'a few'} items waiting. Reply APPROVE <code> or REJECT <code> — the code is in each request.`;
    case 'nothing_pending':
      return "You're all caught up — nothing is waiting for your approval right now.";
    case 'not_found':
      return "Hmm, I don't see that one waiting — it may already be handled.";
    case 'needs_details':
      return 'That one needs a couple details filled in first. Open the app to finish it.';
  }
}
