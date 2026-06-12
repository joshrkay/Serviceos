/**
 * P2-034 — Render proposals as owner-facing SMS bodies.
 */
import type { Proposal } from '../proposal';
import {
  deriveMarkersFromProposal,
  formatMarkersForSms,
} from '../markers/render';

const GSM_SINGLE_SEGMENT = 160;
const TARGET_MAX = 320;

function formatMoney(cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function pickHighlightFields(proposal: Proposal): string[] {
  const p = proposal.payload ?? {};
  const parts: string[] = [];

  const total =
    formatMoney(p.totalCents) ??
    formatMoney(p.total_cents) ??
    formatMoney(p.amountCents);
  if (total) parts.push(total);

  const customer =
    (typeof p.customerName === 'string' && p.customerName) ||
    (typeof p.customer_name === 'string' && p.customer_name);
  if (customer) parts.push(customer);

  const when =
    (typeof p.scheduledStart === 'string' && p.scheduledStart) ||
    (typeof p.appointmentTime === 'string' && p.appointmentTime);
  if (when) parts.push(when);

  return parts.slice(0, 3);
}

export interface RenderProposalSmsResult {
  body: string;
  segmentCount: number;
}

export function renderProposalSms(proposal: Proposal): RenderProposalSmsResult {
  const markers = deriveMarkersFromProposal(proposal);
  const markerTail = formatMarkersForSms(markers);
  const highlights = pickHighlightFields(proposal);
  const highlightText = highlights.length > 0 ? ` (${highlights.join(' · ')})` : '';

  const core = `${proposal.summary}${highlightText}. Reply APPROVE, EDIT, or REJECT.`;
  let body = markerTail ? `${core}\n${markerTail}` : core;

  if (body.length > TARGET_MAX) {
    const budget = TARGET_MAX - (markerTail ? markerTail.length + 1 : 0) - 28;
    const trimmedSummary =
      proposal.summary.length > budget
        ? `${proposal.summary.slice(0, Math.max(20, budget - 1))}…`
        : proposal.summary;
    body = markerTail
      ? `${trimmedSummary}${highlightText}. APPROVE/EDIT/REJECT.\n${markerTail}`
      : `${trimmedSummary}${highlightText}. Reply APPROVE, EDIT, or REJECT.`;
  }

  const segmentCount = Math.max(1, Math.ceil(body.length / GSM_SINGLE_SEGMENT));
  return { body, segmentCount };
}
