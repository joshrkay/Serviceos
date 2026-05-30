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
}

/**
 * Catalog categories are PascalCase ('Labor' | 'Parts' | 'Materials') while
 * estimate line items use a lowercase enum ('labor' | 'material' | ...). The
 * catalog has no equivalent for 'equipment'/'other', so unknown values map to
 * `undefined` (the editor's "uncategorised" state).
 */
export function mapCatalogCategory(category?: string): LineItemDraft['category'] {
  switch ((category ?? '').toLowerCase()) {
    case 'labor':
      return 'labor';
    case 'parts':
    case 'material':
    case 'materials':
      return 'material';
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
  };
}
