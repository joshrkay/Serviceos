import { v4 as uuidv4 } from 'uuid';
import { LineItem } from '../../shared/billing-engine';

export type DeltaType =
  | 'line_item_added'
  | 'line_item_removed'
  | 'line_item_changed'
  | 'description_changed'
  | 'quantity_changed'
  | 'price_changed'
  | 'category_changed'
  | 'order_changed'
  | 'taxable_changed'
  | 'discount_changed'
  | 'tax_changed'
  | 'message_changed';

export interface DeltaEntry {
  type: DeltaType;
  lineItemId?: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface InvoiceEditDelta {
  id: string;
  tenantId: string;
  invoiceId: string;
  fromRevisionId: string;
  toRevisionId: string;
  deltas: DeltaEntry[];
  summary: string;
  createdAt: Date;
}

export interface InvoiceEditDeltaRepository {
  create(delta: InvoiceEditDelta): Promise<InvoiceEditDelta>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceEditDelta[]>;
}

interface InvoiceSnapshot {
  lineItems?: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
}

export function computeInvoiceDeltas(
  oldSnapshot: InvoiceSnapshot,
  newSnapshot: InvoiceSnapshot
): DeltaEntry[] {
  const deltas: DeltaEntry[] = [];
  const oldItems = oldSnapshot.lineItems || [];
  const newItems = newSnapshot.lineItems || [];

  const oldMap = new Map(oldItems.map((item) => [item.id, item]));
  const newMap = new Map(newItems.map((item) => [item.id, item]));

  // Added items
  for (const [id, item] of newMap) {
    if (!oldMap.has(id)) {
      deltas.push({ type: 'line_item_added', lineItemId: id, newValue: item });
    }
  }

  // Removed items
  for (const [id, item] of oldMap) {
    if (!newMap.has(id)) {
      deltas.push({ type: 'line_item_removed', lineItemId: id, oldValue: item });
    }
  }

  // Changed items
  for (const [id, newItem] of newMap) {
    const oldItem = oldMap.get(id);
    if (!oldItem) continue;

    if (oldItem.description !== newItem.description) {
      deltas.push({
        type: 'description_changed',
        lineItemId: id,
        field: 'description',
        oldValue: oldItem.description,
        newValue: newItem.description,
      });
    }
    if (oldItem.quantity !== newItem.quantity) {
      deltas.push({
        type: 'quantity_changed',
        lineItemId: id,
        field: 'quantity',
        oldValue: oldItem.quantity,
        newValue: newItem.quantity,
      });
    }
    if (oldItem.unitPriceCents !== newItem.unitPriceCents) {
      deltas.push({
        type: 'price_changed',
        lineItemId: id,
        field: 'unitPriceCents',
        oldValue: oldItem.unitPriceCents,
        newValue: newItem.unitPriceCents,
      });
    }
    if (oldItem.category !== newItem.category) {
      deltas.push({
        type: 'category_changed',
        lineItemId: id,
        field: 'category',
        oldValue: oldItem.category,
        newValue: newItem.category,
      });
    }
    if (oldItem.sortOrder !== newItem.sortOrder) {
      deltas.push({
        type: 'order_changed',
        lineItemId: id,
        field: 'sortOrder',
        oldValue: oldItem.sortOrder,
        newValue: newItem.sortOrder,
      });
    }
    if (oldItem.taxable !== newItem.taxable) {
      deltas.push({
        type: 'taxable_changed',
        lineItemId: id,
        field: 'taxable',
        oldValue: oldItem.taxable,
        newValue: newItem.taxable,
      });
    }
  }

  // Document-level changes
  if (oldSnapshot.discountCents !== newSnapshot.discountCents) {
    deltas.push({
      type: 'discount_changed',
      field: 'discountCents',
      oldValue: oldSnapshot.discountCents,
      newValue: newSnapshot.discountCents,
    });
  }
  if (oldSnapshot.taxRateBps !== newSnapshot.taxRateBps) {
    deltas.push({
      type: 'tax_changed',
      field: 'taxRateBps',
      oldValue: oldSnapshot.taxRateBps,
      newValue: newSnapshot.taxRateBps,
    });
  }
  if (oldSnapshot.customerMessage !== newSnapshot.customerMessage) {
    deltas.push({
      type: 'message_changed',
      field: 'customerMessage',
      oldValue: oldSnapshot.customerMessage,
      newValue: newSnapshot.customerMessage,
    });
  }

  return deltas;
}

export function summarizeInvoiceDeltas(deltas: DeltaEntry[]): string {
  const added = deltas.filter((d) => d.type === 'line_item_added').length;
  const removed = deltas.filter((d) => d.type === 'line_item_removed').length;
  const changed = deltas.filter((d) => !['line_item_added', 'line_item_removed'].includes(d.type)).length;
  const parts: string[] = [];
  if (added) parts.push(`${added} item(s) added`);
  if (removed) parts.push(`${removed} item(s) removed`);
  if (changed) parts.push(`${changed} change(s)`);
  return parts.join(', ') || 'No changes';
}

export async function createInvoiceEditDelta(
  tenantId: string,
  invoiceId: string,
  fromRevisionId: string,
  toRevisionId: string,
  oldSnapshot: InvoiceSnapshot,
  newSnapshot: InvoiceSnapshot,
  repository: InvoiceEditDeltaRepository
): Promise<InvoiceEditDelta> {
  const deltas = computeInvoiceDeltas(oldSnapshot, newSnapshot);

  const editDelta: InvoiceEditDelta = {
    id: uuidv4(),
    tenantId,
    invoiceId,
    fromRevisionId,
    toRevisionId,
    deltas,
    summary: summarizeInvoiceDeltas(deltas),
    createdAt: new Date(),
  };

  return repository.create(editDelta);
}

export class InMemoryInvoiceEditDeltaRepository implements InvoiceEditDeltaRepository {
  private deltas: InvoiceEditDelta[] = [];

  async create(delta: InvoiceEditDelta): Promise<InvoiceEditDelta> {
    this.deltas.push({ ...delta, deltas: [...delta.deltas] });
    return { ...delta, deltas: [...delta.deltas] };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceEditDelta[]> {
    return this.deltas
      .filter((d) => d.tenantId === tenantId && d.invoiceId === invoiceId)
      .map((d) => ({ ...d, deltas: [...d.deltas] }));
  }
}
