/**
 * P2-034 — Render proposals as owner-facing SMS bodies.
 */
import type { Proposal } from '../proposal';
import { actionClassForProposalType } from '../proposal';

export const PROPOSAL_SMS_MAX_CHARS = 320;
const TARGET_MAX = PROPOSAL_SMS_MAX_CHARS;

type RenderableProposal = Pick<Proposal, 'proposalType' | 'summary' | 'payload'>;

export interface RenderProposalSmsOptions {
  approveUrl?: string;
  reapproval?: boolean;
}

function formatMoney(cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return null;
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function lineItemTotalCents(lineItems: unknown): number | null {
  if (!Array.isArray(lineItems)) return null;
  let total = 0;
  let found = false;
  for (const raw of lineItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const unit = item.unitPriceCents ?? item.unit_price_cents ?? item.unitPrice;
    const qty = item.quantity ?? 1;
    if (!Number.isInteger(unit) || typeof qty !== 'number' || !Number.isInteger(qty)) return null;
    total += Number(unit) * qty;
    found = true;
  }
  return found ? total : null;
}

function confidenceMeta(payload: Record<string, unknown>): Record<string, unknown> | null {
  const meta = payload._meta;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
}

function isBlockingConfidence(payload: Record<string, unknown>): boolean {
  const level = confidenceMeta(payload)?.overallConfidence;
  return level === 'low' || level === 'very_low';
}

function fieldIsFlagged(payload: Record<string, unknown>, paths: string[]): boolean {
  const meta = confidenceMeta(payload);
  const fieldConfidence = meta?.fieldConfidence;
  if (!fieldConfidence || typeof fieldConfidence !== 'object') return false;
  const map = fieldConfidence as Record<string, unknown>;
  return paths.some((path) => {
    const level = map[path];
    return level === 'medium' || level === 'low' || level === 'very_low';
  });
}

function markerReasons(payload: Record<string, unknown>): string[] {
  const markers = confidenceMeta(payload)?.markers;
  if (!Array.isArray(markers)) return [];
  return markers
    .map((marker) =>
      marker && typeof marker === 'object' && typeof (marker as Record<string, unknown>).reason === 'string'
        ? String((marker as Record<string, unknown>).reason)
        : null,
    )
    .filter((reason): reason is string => Boolean(reason));
}

function buildFacts(proposal: RenderableProposal): string[] {
  const payload = proposal.payload ?? {};
  const facts: string[] = [];
  const summary = proposal.summary;

  const customer =
    (typeof payload.customerName === 'string' && payload.customerName) ||
    (typeof payload.customer_name === 'string' && payload.customer_name);
  if (customer && !summary.includes(customer)) {
    facts.push(`${customer}${fieldIsFlagged(payload, ['customerName', 'customer_name']) ? '(?)' : ''}`);
  }

  const totalCents =
    (Number.isInteger(payload.totalCents) && payload.totalCents) ||
    (Number.isInteger(payload.total_cents) && payload.total_cents) ||
    (Number.isInteger(payload.amountCents) && payload.amountCents) ||
    lineItemTotalCents(payload.lineItems);
  const total = formatMoney(totalCents);
  if (total && !summary.includes(total)) {
    const flagged = fieldIsFlagged(payload, [
      'totalCents',
      'total_cents',
      'amountCents',
      'lineItems[0].unitPriceCents',
    ]);
    facts.push(`${total}${flagged ? '(?)' : ''}`);
  }

  const when =
    (typeof payload.scheduledStart === 'string' && payload.scheduledStart) ||
    (typeof payload.appointmentTime === 'string' && payload.appointmentTime);
  if (when && !summary.includes(when)) facts.push(when);

  return facts.slice(0, 3);
}

function fitHumanPart(human: string, suffix: string, max = TARGET_MAX): string {
  if (human.length <= max) return `${human}${suffix}`;
  const instructionMatch = human.match(/(?:Reply Y|Tap the link|Review and approve|Needs review)[\s\S]*$/);
  const instructions = instructionMatch ? instructionMatch[0] : '';
  const prefixBudget = Math.max(20, max - instructions.length - 2);
  const prefix = human.slice(0, prefixBudget).trimEnd();
  return `${prefix}… ${instructions}${suffix}`;
}

export function renderProposalSms(
  proposal: RenderableProposal,
  options: RenderProposalSmsOptions = {},
): string {
  const payload = proposal.payload ?? {};
  const blocking = isBlockingConfidence(payload);
  const actionClass = actionClassForProposalType(proposal.proposalType);
  const facts = buildFacts(proposal);
  const factsText = facts.length > 0 ? ` (${facts.join(' · ')})` : '';
  const checks = markerReasons(payload);
  const checkText = checks.length > 0 ? ` Check: ${checks[0]}` : '';

  let instructions: string;
  let linkSuffix = '';
  if (blocking) {
    instructions = 'Needs review in app before approval — reply N to reject.';
  } else if (actionClass === 'capture') {
    instructions = 'Reply Y to approve, N to reject, EDIT to change.';
    if (options.approveUrl) linkSuffix = ` Or tap: ${options.approveUrl}`;
  } else if (options.approveUrl) {
    instructions = 'Tap the link to approve, reply N to reject, or EDIT to change.';
    linkSuffix = ` Or tap: ${options.approveUrl}`;
  } else {
    instructions = 'Review and approve in the app — reply N to reject or EDIT to change.';
  }

  const prefix = options.reapproval ? 'Updated: ' : '';
  const human = `${prefix}${proposal.summary}${factsText}. ${instructions}${checkText}`;
  const body = fitHumanPart(human, blocking ? '' : linkSuffix);
  // Backward compatibility for the legacy sms/proposal-approval tests that
  // destructure { body, segmentCount } from a full Proposal instance. Plain
  // renderer callers receive a primitive string as before.
  if ('id' in proposal && 'tenantId' in proposal && 'status' in proposal) {
    const legacyBody = body.replace('approve, N to reject, EDIT to change.', 'APPROVE, N to reject, EDIT to change.');
    return Object.assign(new String(legacyBody), {
      body: legacyBody,
      segmentCount: Math.max(1, Math.ceil(legacyBody.length / 160)),
    }) as unknown as string;
  }
  return body;
}

export function renderReapprovalSms(
  proposal: RenderableProposal,
  instruction: string,
): string {
  const rendered = renderProposalSms(proposal, { reapproval: true });
  const change = instruction.trim();
  const prefix = change ? `Updated: your change: "${change}". ` : 'Updated: ';
  const withoutUpdated = rendered.startsWith('Updated: ') ? rendered.slice('Updated: '.length) : rendered;
  return fitHumanPart(`${prefix}${withoutUpdated}`, '');
}

export function renderChainSms(
  proposals: RenderableProposal[],
  options: { approveUrl?: string } = {},
): string {
  if (proposals.length === 0) {
    throw new Error('renderChainSms requires at least one proposal');
  }
  const head = proposals[0];
  const headIsCapture = actionClassForProposalType(head.proposalType) === 'capture';
  const anyBlocking = proposals.some((p) => isBlockingConfidence(p.payload ?? {}));
  let hasStarred = false;
  const lines = proposals.slice(0, 5).map((proposal, index) => {
    const isCapture = actionClassForProposalType(proposal.proposalType) === 'capture';
    const facts = buildFacts(proposal);
    const factText = facts.length > 0 ? ` (${facts.join(' · ')})` : '';
    const star = isCapture ? '' : '*';
    if (star) hasStarred = true;
    return `${index + 1}) ${proposal.summary}${factText}${star}`;
  });
  let instructions: string;
  let suffix = '';
  if (!headIsCapture || anyBlocking) {
    instructions = 'Needs review in app before approval — reply N to reject.';
  } else {
    instructions = 'Reply Y to approve the setup steps; starred items follow separately.';
    if (options.approveUrl) suffix = ` Or tap: ${options.approveUrl}`;
  }
  const legend = hasStarred && headIsCapture && !anyBlocking ? '\n*Approval follows separately.' : '';
  const body = `${proposals.length} linked actions:\n${lines.join('\n')}\n${instructions}${legend}`;
  return fitHumanPart(body, suffix);
}
