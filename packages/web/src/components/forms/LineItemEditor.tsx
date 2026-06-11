import React, { useCallback, useMemo } from 'react';
import { formatCurrency as formatUSD } from '../../utils/currency';
import { CatalogPicker } from './CatalogPicker';
import { catalogItemToDraft } from './catalogToLineItem';

/**
 * Editable line item shape — what the editor renders/maintains internally.
 * `unitPriceDollars` is the user-facing string ("12.50"); we convert to
 * integer cents only at submit time via `toLineItemPayload`.
 */
export interface LineItemDraft {
  id: string;
  description: string;
  quantity: string;
  unitPriceDollars: string;
  taxable: boolean;
  category?: 'labor' | 'material' | 'equipment' | 'other';
  // Good-better-best authoring (estimates only). A non-empty `groupLabel`
  // makes the row one option in a mutually-exclusive tier group; an
  // optional row with no group is a standalone add-on.
  isOptional?: boolean;
  groupLabel?: string;
  isDefaultSelected?: boolean;
}

export interface LineItemPayload {
  id: string;
  description: string;
  category?: 'labor' | 'material' | 'equipment' | 'other';
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
}

export interface LineItemEditorProps {
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
  /** Enable good-better-best authoring controls (estimates only). */
  enableOptions?: boolean;
  /** Show an "Add from Price Book" picker that appends catalog items as rows. */
  enableCatalog?: boolean;
}

/** Generate a stable client id for a new row (no UUID dep). */
function makeId(): string {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export function emptyDraft(): LineItemDraft {
  return {
    id: makeId(),
    description: '',
    quantity: '1',
    unitPriceDollars: '0.00',
    taxable: true,
  };
}

/** Convert a single draft row to an integer-cents payload. */
export function toLineItemPayload(
  draft: LineItemDraft,
  sortOrder: number
): LineItemPayload {
  const qty = Number(draft.quantity);
  const dollars = Number(draft.unitPriceDollars);
  const safeQty = Number.isFinite(qty) && qty >= 0 ? qty : 0;
  const safeDollars = Number.isFinite(dollars) && dollars >= 0 ? dollars : 0;
  const unitPriceCents = Math.round(safeDollars * 100);
  const totalCents = Math.round(safeDollars * 100 * safeQty);
  const groupLabel = draft.groupLabel?.trim() || undefined;
  return {
    id: draft.id,
    description: draft.description.trim(),
    category: draft.category,
    quantity: safeQty,
    unitPriceCents,
    totalCents,
    sortOrder,
    taxable: draft.taxable,
    // A tier row is selectable by virtue of its group; a row flagged
    // optional with no group is a standalone add-on.
    groupKey: groupLabel,
    groupLabel,
    isOptional: draft.isOptional || groupLabel !== undefined ? true : undefined,
    isDefaultSelected: draft.isDefaultSelected ? true : undefined,
  };
}

/** Total of all rows in cents — for display. */
export function totalCents(items: LineItemDraft[]): number {
  return items.reduce((sum, item) => {
    const qty = Number(item.quantity);
    const dollars = Number(item.unitPriceDollars);
    if (!Number.isFinite(qty) || !Number.isFinite(dollars)) return sum;
    return sum + Math.round(dollars * 100 * (qty < 0 ? 0 : qty));
  }, 0);
}

const inputCls =
  'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

export function LineItemEditor({
  items,
  onChange,
  enableOptions = false,
  enableCatalog = false,
}: LineItemEditorProps) {
  const update = useCallback(
    (index: number, patch: Partial<LineItemDraft>) => {
      const next = items.slice();
      next[index] = { ...next[index], ...patch };
      onChange(next);
    },
    [items, onChange]
  );

  const remove = useCallback(
    (index: number) => {
      const next = items.slice();
      next.splice(index, 1);
      onChange(next);
    },
    [items, onChange]
  );

  const add = useCallback(() => {
    onChange([...items, emptyDraft()]);
  }, [items, onChange]);

  const grand = useMemo(() => totalCents(items), [items]);

  return (
    <div data-testid="line-item-editor" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-slate-700">Line items</h2>
        <div className="flex items-center gap-2">
          {enableCatalog && (
            <CatalogPicker
              onPick={(item) => {
                const draft = catalogItemToDraft(item);
                // On a fresh form `items` is a single blank draft; replace it
                // rather than appending, so the picked row isn't trailed by an
                // empty one that fails the "every row needs a description" check.
                const soleEmpty =
                  items.length === 1 && !items[0].description.trim();
                onChange(soleEmpty ? [draft] : [...items, draft]);
              }}
            />
          )}
          <button
            type="button"
            onClick={add}
            className="text-xs rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50"
          >
            + Add row
          </button>
        </div>
      </div>

      {items.length === 0 && (
        <p className="text-xs text-slate-500">No items yet.</p>
      )}

      {items.map((item, index) => {
        const qty = Number(item.quantity);
        const dollars = Number(item.unitPriceDollars);
        const lineTotalCents =
          Number.isFinite(qty) && Number.isFinite(dollars)
            ? Math.round(dollars * 100 * (qty < 0 ? 0 : qty))
            : 0;
        return (
          <div
            key={item.id}
            data-testid={`line-item-row-${index}`}
            className="grid grid-cols-12 gap-2 items-center"
          >
            <input
              aria-label={`description-${index}`}
              value={item.description}
              onChange={(e) => update(index, { description: e.target.value })}
              placeholder="Description"
              className={`${inputCls} col-span-5`}
            />
            <input
              aria-label={`quantity-${index}`}
              value={item.quantity}
              onChange={(e) => update(index, { quantity: e.target.value })}
              inputMode="decimal"
              placeholder="Qty"
              className={`${inputCls} col-span-2`}
            />
            <input
              aria-label={`unit-price-${index}`}
              value={item.unitPriceDollars}
              onChange={(e) =>
                update(index, { unitPriceDollars: e.target.value })
              }
              inputMode="decimal"
              placeholder="0.00"
              className={`${inputCls} col-span-2`}
            />
            <div
              data-testid={`line-item-total-${index}`}
              className="col-span-2 text-right text-sm text-slate-700"
            >
              {formatUSD(lineTotalCents)}
            </div>
            <button
              type="button"
              aria-label={`remove-line-${index}`}
              onClick={() => remove(index)}
              className="col-span-1 rounded-md border border-slate-200 text-xs py-1 hover:bg-slate-50"
            >
              ×
            </button>
            {enableOptions && (
              <div className="col-span-12 flex flex-wrap items-center gap-3 pl-1 pb-1">
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    aria-label={`optional-${index}`}
                    checked={item.isOptional ?? false}
                    onChange={(e) => update(index, { isOptional: e.target.checked })}
                  />
                  Optional add-on
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  Tier group
                  <input
                    aria-label={`group-${index}`}
                    value={item.groupLabel ?? ''}
                    onChange={(e) => update(index, { groupLabel: e.target.value })}
                    placeholder="e.g. Plan"
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs w-28"
                  />
                </label>
                {(item.isOptional || (item.groupLabel ?? '').trim()) && (
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      aria-label={`default-selected-${index}`}
                      checked={item.isDefaultSelected ?? false}
                      onChange={(e) => update(index, { isDefaultSelected: e.target.checked })}
                    />
                    Pre-selected
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex justify-end pt-2 border-t border-slate-100 mt-2">
        <div className="text-sm text-slate-700">
          Total:{' '}
          <span data-testid="line-items-total" className="font-medium">
            {formatUSD(grand)}
          </span>
        </div>
      </div>
    </div>
  );
}
