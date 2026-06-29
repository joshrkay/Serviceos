import type { LineItem } from '../components/LineItemSheet';

/**
 * Map a mobile capture-sheet LineItem to the server `lineItemSchema` shape
 * (packages/api/src/shared/contracts.ts). That schema requires `id`,
 * `totalCents`, `sortOrder`, and `taxable` as non-optional fields, but the
 * mobile LineItem only tracks description/quantity/unitPriceCents/catalogItemId.
 * Synthesize the rest here so `POST /api/estimates` and `POST /api/invoices`
 * pass Zod validation instead of 400-ing.
 *
 * Money stays integer cents: totalCents = unitPriceCents * quantity, rounded.
 * `taxable` defaults to false (the mobile sheet has no per-line tax control);
 * document-level taxRateBps still applies. The server re-derives authoritative
 * totals/ids on persist — these values satisfy the contract, not the books.
 */
export function toServerLineItems(items: LineItem[]): Array<{
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
  catalogItemId?: string;
}> {
  return items.map((li, i) => ({
    id: `li-${i + 1}`,
    description: li.description,
    quantity: li.quantity,
    unitPriceCents: li.unitPriceCents,
    totalCents: Math.round(li.unitPriceCents * li.quantity),
    sortOrder: i,
    taxable: false,
    ...(li.catalogItemId ? { catalogItemId: li.catalogItemId } : {}),
  }));
}
