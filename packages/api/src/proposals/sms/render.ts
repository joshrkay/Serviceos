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
 *
 * RV-074 (F-4) — three-tier confidence rendering:
 *   HIGH (or absent _meta) → unchanged from today (byte-identical).
 *   MEDIUM → rendered value(s) with medium-or-lower fieldConfidence get a
 *     `(?)` suffix; when any marker exists a trailing "Check: <reason>"
 *     line is appended (within budget); approveUrl included as normal.
 *   LOW / VERY_LOW → body becomes "needs review in app" form; the Reply Y
 *     prompt and approveUrl are OMITTED — no approve affordance.
 */
import type { ProposalType } from '../proposal';
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from '../../ai/guardrails/confidence';
import { AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS } from '../auto-approve';

export const PROPOSAL_SMS_MAX_CHARS = 320;

const REPLY_INSTRUCTIONS = 'Reply Y to approve, N to reject, EDIT to change.';
// RV-074 review fix: the low-confidence send anchors the reply transport
// (review_required_rendered), so "reply N to reject" is correctly targeted
// at THIS proposal. Approval stays in-app only.
const REVIEW_IN_APP_INSTRUCTIONS =
  'Needs review in app before approval — reply N to reject.';

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

// ─────────────────────────────────────────────────────────────────────────────
// RV-074 (F-4) — _meta extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedMeta {
  overallConfidence: ConfidenceLevel | undefined;
  fieldConfidence: Record<string, ConfidenceLevel> | undefined;
  firstMarkerReason: string | undefined;
}

/** Safe extraction of payload._meta — tolerates any shape; absent/malformed → all undefined. */
function extractMeta(payload: Record<string, unknown>): ExtractedMeta {
  const meta = payload._meta;
  if (meta === null || typeof meta !== 'object') {
    return { overallConfidence: undefined, fieldConfidence: undefined, firstMarkerReason: undefined };
  }
  const m = meta as Record<string, unknown>;

  // overallConfidence
  const overall = typeof m.overallConfidence === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(m.overallConfidence)
    ? (m.overallConfidence as ConfidenceLevel)
    : undefined;

  // fieldConfidence
  let fieldConfidence: Record<string, ConfidenceLevel> | undefined;
  if (m.fieldConfidence !== null && typeof m.fieldConfidence === 'object' && !Array.isArray(m.fieldConfidence)) {
    const fc: Record<string, ConfidenceLevel> = {};
    for (const [k, v] of Object.entries(m.fieldConfidence as Record<string, unknown>)) {
      if (typeof v === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(v)) fc[k] = v as ConfidenceLevel;
    }
    if (Object.keys(fc).length > 0) fieldConfidence = fc;
  }

  // first marker reason
  let firstMarkerReason: string | undefined;
  if (Array.isArray(m.markers) && m.markers.length > 0) {
    const first = m.markers[0];
    if (first !== null && typeof first === 'object') {
      const reason = (first as Record<string, unknown>).reason;
      if (typeof reason === 'string' && reason.trim()) firstMarkerReason = reason.trim();
    }
  }

  return { overallConfidence: overall, fieldConfidence, firstMarkerReason };
}

/** True when a confidence level is blocking (low / very_low). */
function isBlocking(level: ConfidenceLevel | undefined): boolean {
  return level !== undefined && (AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS as readonly string[]).includes(level);
}

/** True when a field confidence entry is medium-or-lower. */
function isMediumOrLower(level: ConfidenceLevel): boolean {
  return level === 'medium' || level === 'low' || level === 'very_low';
}

// ─────────────────────────────────────────────────────────────────────────────
// Path → rendered-fragment mapping for fieldConfidence (?)  markers.
//
// Paths emitted by catalog-resolver and estimate/invoice tasks that the SMS
// renderer already prints as facts.  Unmapped paths contribute to the
// trailing `Check:` line only (handled below).
//
// Supported:
//   lineItems[N].unitPrice / lineItems[N].unitPriceCents  → money fact
//   totalCents / totalAmountCents / amountCents           → money fact
//   customerName                                          → customer name fact
// ─────────────────────────────────────────────────────────────────────────────

const LINE_ITEM_UNIT_PRICE_RE = /^lineItems\[\d+\]\.(unitPrice|unitPriceCents)$/;
const LINE_ITEM_ANY_RE = /^lineItems\[/;

/**
 * Given the fieldConfidence map and the rendered facts, return which fact
 * strings should carry a `(?)` suffix.  Returns `{ flaggedMoney, flaggedCustomer }`
 * boolean flags — true when the corresponding fact should be suffixed.
 *
 * Rules:
 *  - Any key matching `lineItems[N].unitPrice|unitPriceCents` at medium-or-lower
 *    → the money fact is flagged (the fact is the formatted total/sum).
 *  - Any key matching `totalCents|totalAmountCents|amountCents` at medium-or-lower
 *    → the money fact is flagged.
 *  - `customerName` at medium-or-lower → the customer fact is flagged.
 */
function computeFlaggedFacts(
  fieldConfidence: Record<string, ConfidenceLevel> | undefined,
  payload: Record<string, unknown>,
  moneyFact: string | null,
  customerFact: string | null,
): { flaggedMoney: boolean; flaggedCustomer: boolean } {
  if (!fieldConfidence) return { flaggedMoney: false, flaggedCustomer: false };

  let flaggedMoney = false;
  let flaggedCustomer = false;

  for (const [path, level] of Object.entries(fieldConfidence)) {
    if (!isMediumOrLower(level)) continue;
    if (
      MONEY_KEYS.includes(path as typeof MONEY_KEYS[number]) ||
      (LINE_ITEM_UNIT_PRICE_RE.test(path)) ||
      // If any lineItem path is flagged and we rendered money from line items
      (LINE_ITEM_ANY_RE.test(path) && moneyFact !== null && extractAmountCents(payload) !== null)
    ) {
      flaggedMoney = !!moneyFact;
    }
    if (path === 'customerName') {
      flaggedCustomer = !!customerFact;
    }
  }

  return { flaggedMoney, flaggedCustomer };
}

export function renderProposalSms(
  input: RenderProposalSmsInput,
  options: RenderProposalSmsOptions = {},
): string {
  const { overallConfidence, fieldConfidence, firstMarkerReason } = extractMeta(input.payload);
  const summary = input.summary.trim();
  const prefix = options.reapproval ? 'Updated: ' : '';

  // ── LOW / VERY_LOW: never-approvable form — no Reply Y, no one-tap link ──
  if (isBlocking(overallConfidence)) {
    // Same truncation contract as the normal form: the instructions are
    // sacred ("reply N to reject" must survive), the summary gives way.
    const summaryBudget = Math.max(
      PROPOSAL_SMS_MAX_CHARS -
        prefix.length -
        1 - // space before instructions
        REVIEW_IN_APP_INSTRUCTIONS.length,
      20,
    );
    return `${prefix}${truncate(summary, summaryBudget)} ${REVIEW_IN_APP_INSTRUCTIONS}`;
  }

  // ── HIGH (or absent _meta): existing behavior, byte-identical ──
  // ── MEDIUM: same structure but (?) on flagged facts + optional Check: line ──

  const facts: string[] = [];
  const customer = extractCustomerName(input.payload);
  if (customer && !summary.toLowerCase().includes(customer.toLowerCase())) {
    facts.push(customer);
  }
  const amountCents = extractAmountCents(input.payload);
  const moneyFact = amountCents !== null ? formatCents(amountCents) : null;
  if (moneyFact !== null && !summary.includes(moneyFact)) {
    facts.push(moneyFact);
  }

  // MEDIUM: apply (?) markers to rendered facts
  if (overallConfidence === 'medium' && fieldConfidence) {
    const customerFact = (customer && !summary.toLowerCase().includes(customer.toLowerCase()))
      ? customer
      : null;
    const { flaggedMoney, flaggedCustomer } = computeFlaggedFacts(
      fieldConfidence,
      input.payload,
      moneyFact,
      customerFact,
    );

    // Rewrite facts with (?) suffixes in-place
    for (let i = 0; i < facts.length; i++) {
      if (flaggedMoney && moneyFact !== null && facts[i] === moneyFact) {
        facts[i] = `${moneyFact}(?)`;
      } else if (flaggedCustomer && customer && facts[i] === customer) {
        facts[i] = `${customer}(?)`;
      }
    }
  }

  const factsPart = facts.length > 0 ? ` (${facts.join(', ')})` : '';
  const linkPart = options.approveUrl ? ` Or tap (30 min): ${options.approveUrl}` : '';

  // MEDIUM: append Check: line when a marker exists (within budget)
  let checkLine = '';
  if (overallConfidence === 'medium' && firstMarkerReason) {
    checkLine = `\nCheck: ${firstMarkerReason}`;
  }

  // The summary absorbs all truncation; instructions are sacred. The link
  // is appended outside the budget (see module note).
  const summaryBudget = Math.max(
    PROPOSAL_SMS_MAX_CHARS -
      prefix.length -
      factsPart.length -
      checkLine.length -
      1 - // space before instructions
      REPLY_INSTRUCTIONS.length,
    20,
  );
  return `${prefix}${truncate(summary, summaryBudget)}${factsPart} ${REPLY_INSTRUCTIONS}${checkLine}${linkPart}`;
}
