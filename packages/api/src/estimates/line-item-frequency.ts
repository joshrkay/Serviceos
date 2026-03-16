import { v4 as uuidv4 } from 'uuid';
import { LineItem } from './estimate';

export interface LineItemFrequency {
  id: string;
  tenantId: string;
  verticalSlug: string;
  categoryId?: string;
  normalizedDescription: string;
  occurrenceCount: number;
  avgQuantity: number;
  avgUnitPrice: number;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface LineItemFrequencyRepository {
  create(freq: LineItemFrequency): Promise<LineItemFrequency>;
  findByTenant(tenantId: string): Promise<LineItemFrequency[]>;
  findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId?: string): Promise<LineItemFrequency[]>;
  incrementOccurrence(tenantId: string, id: string, quantity: number, unitPrice: number): Promise<LineItemFrequency | null>;
  findAboveThreshold(tenantId: string, threshold: number): Promise<LineItemFrequency[]>;
}

export function normalizeLineItemDescription(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

export async function trackLineItemOccurrence(
  lineItem: LineItem,
  tenantId: string,
  verticalSlug: string,
  categoryId: string | undefined,
  repo: LineItemFrequencyRepository
): Promise<LineItemFrequency> {
  const normalized = normalizeLineItemDescription(lineItem.description);
  const existing = await repo.findByVerticalAndCategory(tenantId, verticalSlug, categoryId);
  const match = existing.find((f) => f.normalizedDescription === normalized);

  if (match) {
    const updated = await repo.incrementOccurrence(tenantId, match.id, lineItem.quantity, lineItem.unitPriceCents);
    return updated!;
  }

  const now = new Date();
  const freq: LineItemFrequency = {
    id: uuidv4(),
    tenantId,
    verticalSlug,
    categoryId,
    normalizedDescription: normalized,
    occurrenceCount: 1,
    avgQuantity: lineItem.quantity,
    avgUnitPrice: lineItem.unitPriceCents,
    lastSeenAt: now,
    createdAt: now,
  };
  return repo.create(freq);
}

export async function detectFrequentItems(
  tenantId: string,
  verticalSlug: string,
  threshold: number,
  repo: LineItemFrequencyRepository
): Promise<LineItemFrequency[]> {
  const all = await repo.findByTenant(tenantId);
  return all.filter((f) => f.verticalSlug === verticalSlug && f.occurrenceCount >= threshold);
}

export class InMemoryLineItemFrequencyRepository implements LineItemFrequencyRepository {
  private frequencies: Map<string, LineItemFrequency> = new Map();

  async create(freq: LineItemFrequency): Promise<LineItemFrequency> {
    this.frequencies.set(freq.id, { ...freq });
    return { ...freq };
  }

  async findByTenant(tenantId: string): Promise<LineItemFrequency[]> {
    return Array.from(this.frequencies.values())
      .filter((f) => f.tenantId === tenantId)
      .map((f) => ({ ...f }));
  }

  async findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId?: string): Promise<LineItemFrequency[]> {
    return Array.from(this.frequencies.values())
      .filter((f) => {
        if (f.tenantId !== tenantId) return false;
        if (f.verticalSlug !== verticalSlug) return false;
        if (categoryId && f.categoryId !== categoryId) return false;
        return true;
      })
      .map((f) => ({ ...f }));
  }

  async incrementOccurrence(tenantId: string, id: string, quantity: number, unitPrice: number): Promise<LineItemFrequency | null> {
    const freq = this.frequencies.get(id);
    if (!freq || freq.tenantId !== tenantId) return null;
    const newCount = freq.occurrenceCount + 1;
    freq.avgQuantity = (freq.avgQuantity * freq.occurrenceCount + quantity) / newCount;
    freq.avgUnitPrice = (freq.avgUnitPrice * freq.occurrenceCount + unitPrice) / newCount;
    freq.occurrenceCount = newCount;
    freq.lastSeenAt = new Date();
    this.frequencies.set(id, freq);
    return { ...freq };
  }

  async findAboveThreshold(tenantId: string, threshold: number): Promise<LineItemFrequency[]> {
    return Array.from(this.frequencies.values())
      .filter((f) => f.tenantId === tenantId && f.occurrenceCount >= threshold)
      .map((f) => ({ ...f }));
  }
}
