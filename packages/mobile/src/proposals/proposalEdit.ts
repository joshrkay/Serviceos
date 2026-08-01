// Pure (RN-free) edit-before-approve model (U2 / F4): which payload fields
// are editable, how they render into inputs, and how typed input builds the
// `PUT /api/proposals/:id` `{ edits }` body. Money is integer cents end to
// end — inputs render/parse via string math, never float multiplication.
// Line items are handled separately (catalog-grounded add via LineItemSheet;
// free-text price entry is deliberately NOT offered — CLAUDE.md catalog rule).
import { centsToInputValue, parseMoneyToCents } from '../lib/format';
import { humanizeKey, isCentsKey } from './proposalReview';

export type EditableKind = 'text' | 'cents' | 'number';

export interface EditableField {
  key: string;
  label: string;
  kind: EditableKind;
  /** Initial input text (cents render as bare dollars, e.g. "123.45"). */
  value: string;
}

/**
 * Top-level scalar payload fields an operator can edit. Mirrors reviewRows'
 * flattening: nested objects/arrays and null/undefined are skipped (lineItems
 * has its own grounded editor), and booleans are skipped too — a mis-toggled
 * flag is a wrong-answer risk with no voice-correction upside.
 */
export function editableScalarFields(
  payload: Record<string, unknown> | undefined,
): EditableField[] {
  if (!payload) return [];
  const fields: EditableField[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && isCentsKey(key)) {
      fields.push({ key, label: humanizeKey(key), kind: 'cents', value: centsToInputValue(value) });
    } else if (typeof value === 'number') {
      fields.push({ key, label: humanizeKey(key), kind: 'number', value: String(value) });
    } else {
      fields.push({ key, label: humanizeKey(key), kind: 'text', value: String(value) });
    }
  }
  return fields;
}

export interface BuiltEdits {
  /** Only the keys whose parsed value differs from the original payload. */
  edits: Record<string, unknown>;
  /** Labels of fields whose input could not be parsed (blocks saving). */
  invalid: string[];
}

/**
 * Turn the draft input texts back into a `{ edits }` object. Unchanged fields
 * are omitted (the server shallow-merges, and a no-op PUT would still audit);
 * unparseable cents/number inputs land in `invalid` instead of being sent.
 */
export function buildEdits(
  payload: Record<string, unknown> | undefined,
  drafts: Record<string, string>,
): BuiltEdits {
  const edits: Record<string, unknown> = {};
  const invalid: string[] = [];
  const fields = editableScalarFields(payload);
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined || draft === field.value) continue;
    if (field.kind === 'cents') {
      const cents = parseMoneyToCents(draft);
      if (cents === null) {
        invalid.push(field.label);
        continue;
      }
      if (cents !== payload?.[field.key]) edits[field.key] = cents;
    } else if (field.kind === 'number') {
      const n = Number(draft.trim());
      if (draft.trim() === '' || Number.isNaN(n)) {
        invalid.push(field.label);
        continue;
      }
      if (n !== payload?.[field.key]) edits[field.key] = n;
    } else {
      const s = draft.trim();
      if (s !== payload?.[field.key]) edits[field.key] = s;
    }
  }
  return { edits, invalid };
}

export interface EditableLineItem {
  catalogItemId?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}

/**
 * The payload's line items when they match the editable shape, else null
 * (no line-item editor is offered). Shape-checked field-by-field — a payload
 * from an older draft may carry partial rows.
 */
export function payloadLineItems(
  payload: Record<string, unknown> | undefined,
): EditableLineItem[] | null {
  const raw = payload?.lineItems;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: EditableLineItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.description !== 'string') return null;
    if (typeof e.quantity !== 'number' || typeof e.unitPriceCents !== 'number') return null;
    items.push({
      ...(typeof e.catalogItemId === 'string' ? { catalogItemId: e.catalogItemId } : {}),
      description: e.description,
      quantity: e.quantity,
      unitPriceCents: e.unitPriceCents,
    });
  }
  return items;
}
