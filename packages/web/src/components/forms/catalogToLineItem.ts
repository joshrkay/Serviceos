import type { LineItemDraft } from './LineItemEditor';

/**
 * Minimal shape of a Price Book (catalog) item as returned by
 * `GET /api/catalog/items`. Mirrors `PriceBookItem` in
 * `settings/PriceBookPage.tsx`; kept local so the line-item editor does not
 * depend on the settings page.
 */
export interface CatalogPickItem {
  id: string;
  name: string;
  description?: string;
  unitPriceCents: number;
  unit?: string;
  /** Catalog category is PascalCase: 'Labor' | 'Parts' | 'Materials'. */
  category?: string;
  /** EE-4 — catalog photo reference (UUID into the files table), or null. */
  imageFileId?: string | null;
}

/**
 * Catalog categories are PascalCase ('Labor' | 'Parts' | 'Materials', and
 * 'Equipment' in the bundled starter catalog) while estimate line items use a
 * lowercase enum ('labor' | 'material' | 'equipment' | 'other'). Unknown
 * values map to `undefined` — the editor's "uncategorised" state. We must NOT
 * fall back to `''`: `category` is an *optional enum* in the line-item Zod
 * contract, so `undefined` is omitted (valid) while `''` would fail enum
 * validation on submit.
 */
export function mapCatalogCategory(category?: string): LineItemDraft['category'] {
  switch ((category ?? '').toLowerCase()) {
    case 'labor':
      return 'labor';
    case 'parts':
    case 'material':
    case 'materials':
      return 'material';
    case 'equipment':
      return 'equipment';
    default:
      return undefined;
  }
}

/** Generate a stable client id for a new row (matches LineItemEditor's scheme). */
function makeId(): string {
  return `li-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * Convert a Price Book item into an editable line-item draft. The catalog
 * stores no quantity or taxable flag, so we default to qty 1 / taxable true
 * and let the user adjust. The unit (e.g. "per hr") is appended to the
 * description since line items have no dedicated unit field.
 */
export function catalogItemToDraft(item: CatalogPickItem): LineItemDraft {
  const unit = item.unit?.trim();
  return {
    id: makeId(),
    description: unit ? `${item.name} (${unit})` : item.name,
    quantity: '1',
    unitPriceDollars: (item.unitPriceCents / 100).toFixed(2),
    taxable: true,
    category: mapCatalogCategory(item.category),
    // EE-4 — carry the catalog photo onto the manually-picked line so it
    // freezes on the estimate exactly as the AI path does.
    imageFileId: item.imageFileId ?? undefined,
  };
}
