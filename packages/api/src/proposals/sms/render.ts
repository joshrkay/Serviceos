/**
 * P2-034 — render a proposal into an SMS approval request.
 *
 * Pure. Works for EVERY proposal type: the proposal's `summary` (already a
 * human-readable sentence rendered at draft time) is the backbone, and the
 * renderer appends the 1–2 highest-signal payload facts it can extract
 * deterministically — money (integer-cents fields only, never derived
 * floats) and the customer name. Times are deliberately NOT extracted from
 * the payload here: rendering them correctly requires the tenant timezone,
 * and the summary already carries any time the drafter considered relevant.
 *
 * Target: the human-readable part (summary + facts + reply instructions)
 * fits in 320 characters (two GSM-7 segments); the one-tap link rides on
 * top. The signed token URL alone is ~250 chars, so budgeting it against
 * the same 320 would starve the summary to nothing — an extra segment is
 * the right trade for a message the owner can actually read. The reply
 * instructions and link are never truncated; the summary gives way first.
 */
import type { ProposalType } from '../proposal';

export const PROPOSAL_SMS_MAX_CHARS = 320;

const REPLY_INSTRUCTIONS = 'Reply Y to approve, N to reject, EDIT to change.';

export interface RenderProposalSmsInput {
  proposalType: ProposalType;
  summary: string;
  payload: Record<string, unknown>;
}

export interface RenderProposalSmsOptions {
  /** Public one-tap approve URL (already token-signed). */
  approveUrl?: string;
  /**
   * True when this is a re-render after an SMS edit — prefixes the body so
   * the owner knows it's the updated version awaiting re-approval.
   */
  reapproval?: boolean;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Payload keys that carry the proposal's headline amount, in priority order. */
const MONEY_KEYS = ['totalCents', 'totalAmountCents', 'amountCents'] as const;

function extractAmountCents(payload: Record<string, unknown>): number | null {
  for (const key of MONEY_KEYS) {
    const v = payload[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  }
  // Fall back to summing line items when they carry integer cents — the
  // P22 catalog-priced drafts always do.
  const lineItems = payload.lineItems;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    let total = 0;
    for (const li of lineItems) {
      if (typeof li !== 'object' || li === null) return null;
      const item = li as Record<string, unknown>;
      const unit = item.unitPriceCents;
      const qty = typeof item.quantity === 'number' ? item.quantity : 1;
      if (typeof unit !== 'number' || !Number.isInteger(unit)) return null;
      total += unit * qty;
    }
    return total;
  }
  return null;
}

function extractCustomerName(payload: Record<string, unknown>): string | null {
  const v = payload.customerName;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function renderProposalSms(
  input: RenderProposalSmsInput,
  options: RenderProposalSmsOptions = {},
): string {
  const facts: string[] = [];
  const summary = input.summary.trim();

  const customer = extractCustomerName(input.payload);
  if (customer && !summary.toLowerCase().includes(customer.toLowerCase())) {
    facts.push(customer);
  }
  const amountCents = extractAmountCents(input.payload);
  if (amountCents !== null) {
    const formatted = formatCents(amountCents);
    if (!summary.includes(formatted)) facts.push(formatted);
  }

  const prefix = options.reapproval ? 'Updated: ' : '';
  const factsPart = facts.length > 0 ? ` (${facts.join(', ')})` : '';
  const linkPart = options.approveUrl ? ` Or tap (30 min): ${options.approveUrl}` : '';

  // The summary absorbs all truncation; instructions are sacred. The link
  // is appended outside the budget (see module note).
  const summaryBudget = Math.max(
    PROPOSAL_SMS_MAX_CHARS -
      prefix.length -
      factsPart.length -
      1 - // space before instructions
      REPLY_INSTRUCTIONS.length,
    20,
  );
  return `${prefix}${truncate(summary, summaryBudget)}${factsPart} ${REPLY_INSTRUCTIONS}${linkPart}`;
}
