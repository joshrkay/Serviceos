// Pure (RN-free) helpers for the proposal review + 5-second-undo screen:
// formatting the payload into review rows and the undo-window countdown math.
// Kept pure so it unit-tests without a renderer.
import { formatMoneyCents } from '../lib/format';

/** The 5s human-approval undo window — mirrors the API's UNDO_WINDOW_MS. */
export const UNDO_WINDOW_MS = 5000;

const TYPE_LABEL: Record<string, string> = {
  draft_invoice: 'Invoice',
  issue_invoice: 'Issue invoice',
  send_invoice: 'Send invoice',
  record_payment: 'Payment',
  draft_estimate: 'Estimate',
  send_estimate: 'Send estimate',
  send_estimate_nudge: 'Estimate nudge',
  send_payment_reminder: 'Payment reminder',
  apply_late_fee: 'Late fee',
  create_appointment: 'Appointment',
  reschedule_appointment: 'Reschedule',
  create_customer: 'Customer',
  voice_clarification: 'Clarify',
};

/** Friendly label for a proposal type (falls back to the de-underscored type). */
export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

export interface ReviewProposal {
  id: string;
  proposalType: string;
  status: string;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  payload?: Record<string, unknown>;
  sourceContext?: Record<string, unknown>;
  approvedAt?: string | null;
}

export interface EntityCandidate {
  id: string;
  label: string;
  hint?: string;
  score?: number;
}

export interface CatalogCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
}

export interface AmbiguousCatalogLine {
  lineIndex: number;
  description: string;
  candidates: CatalogCandidate[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/** P8 entity disambiguation candidates on a voice_clarification payload. */
export function entityCandidatesFromPayload(
  payload: Record<string, unknown> | undefined,
): EntityCandidate[] {
  const raw = payload?.entityCandidates;
  if (!Array.isArray(raw)) return [];
  const out: EntityCandidate[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const label = typeof item.label === 'string' ? item.label : '';
    if (!id || !label) continue;
    out.push({
      id,
      label,
      hint: typeof item.hint === 'string' ? item.hint : undefined,
      score: typeof item.score === 'number' ? item.score : undefined,
    });
  }
  return out;
}

/** Ambiguous catalog lines that need a one-tap resolve-line pick. */
export function ambiguousCatalogLines(
  payload: Record<string, unknown> | undefined,
  sourceContext: Record<string, unknown> | undefined,
): AmbiguousCatalogLine[] {
  const lineItems = payload?.lineItems;
  if (!Array.isArray(lineItems)) return [];
  const catalogResolution = isRecord(sourceContext?.catalogResolution)
    ? (sourceContext.catalogResolution as Record<string, CatalogCandidate[]>)
    : {};
  const lines: AmbiguousCatalogLine[] = [];
  for (let idx = 0; idx < lineItems.length; idx++) {
    const li = lineItems[idx];
    if (!isRecord(li)) continue;
    if (li.pricingSource !== 'ambiguous') continue;
    const candidates = catalogResolution[String(idx)];
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const description =
      typeof li.description === 'string' && li.description.length > 0
        ? li.description
        : `Line ${idx + 1}`;
    lines.push({ lineIndex: idx, description, candidates });
  }
  return lines;
}

export interface ReviewRow {
  label: string;
  value: string;
}

/** camelCase / snake_case → "Title Case". */
export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Money is stored in integer cents; render it as dollars, never float math. */
export { formatMoneyCents as formatCents } from '../lib/format';

/** True for integer-cents payload keys (amountCents, unitPriceCents, …). */
export function isCentsKey(key: string): boolean {
  return /cents$/i.test(key);
}

function formatValue(key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' && isCentsKey(key)) return formatMoneyCents(value);
  return String(value);
}

/**
 * Flatten a proposal payload's top-level scalar fields into labelled rows for
 * the review card. Nested objects/arrays and null/undefined are skipped (the
 * summary text already carries the gist); *Cents fields render as dollars.
 */
export function reviewRows(payload: Record<string, unknown> | undefined): ReviewRow[] {
  if (!payload) return [];
  const rows: ReviewRow[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    rows.push({ label: humanizeKey(key), value: formatValue(key, value as string | number | boolean) });
  }
  return rows;
}

/**
 * Whole seconds left in the undo window for an approved proposal, given the
 * server's `approvedAt`. Uses the server timestamp (not a local start) so the
 * countdown tracks the server-enforced window across the approve round-trip.
 * Returns 0 when there's no approval or the window has closed.
 */
export function undoSecondsLeft(
  approvedAt: string | null | undefined,
  now: number,
  windowMs: number = UNDO_WINDOW_MS,
): number {
  if (!approvedAt) return 0;
  const end = new Date(approvedAt).getTime() + windowMs;
  if (Number.isNaN(end)) return 0;
  const left = end - now;
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}
