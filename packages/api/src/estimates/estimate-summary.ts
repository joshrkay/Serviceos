import { v4 as uuidv4 } from 'uuid';
import { Estimate, LineItem } from './estimate';

export interface LineItemSummary {
  description: string;
  quantity: number;
  unitPrice: number;
  category?: string;
}

export interface EstimateSummarySnapshot {
  id: string;
  tenantId: string;
  estimateId: string;
  verticalSlug: string;
  categoryId: string;
  summaryText: string;
  lineItemSummaries: LineItemSummary[];
  totalAmount: number;
  keyTerms: string[];
  createdAt: Date;
}

export interface EstimateSummaryRepository {
  create(summary: EstimateSummarySnapshot): Promise<EstimateSummarySnapshot>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateSummarySnapshot | null>;
  findByTenantAndVertical(tenantId: string, verticalSlug: string): Promise<EstimateSummarySnapshot[]>;
}

export function createEstimateSummary(
  estimate: Estimate,
  verticalSlug: string,
  categoryId: string
): EstimateSummarySnapshot {
  const lineItemSummaries = summarizeLineItems(estimate.lineItems);
  const totalAmount = estimate.lineItems.reduce((sum, li) => sum + li.totalCents, 0);

  return {
    id: uuidv4(),
    tenantId: estimate.tenantId,
    estimateId: estimate.id,
    verticalSlug,
    categoryId,
    summaryText: buildSummaryText(estimate, verticalSlug, totalAmount),
    lineItemSummaries,
    totalAmount,
    keyTerms: extractKeyTerms(estimate.lineItems),
    createdAt: new Date(),
  };
}

export function summarizeLineItems(lineItems: LineItem[]): LineItemSummary[] {
  return lineItems.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unitPrice: li.unitPriceCents,
    category: li.category,
  }));
}

export function extractKeyTerms(lineItems: LineItem[]): string[] {
  const terms = new Set<string>();
  for (const li of lineItems) {
    const words = li.description.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 3) terms.add(word);
    }
    if (li.category) terms.add(li.category.toLowerCase());
  }
  return Array.from(terms);
}

function buildSummaryText(estimate: Estimate, verticalSlug: string, totalAmount: number): string {
  const itemCount = estimate.lineItems.length;
  return `${verticalSlug} estimate with ${itemCount} line item${itemCount !== 1 ? 's' : ''} totaling $${totalAmount.toFixed(2)}`;
}

export class InMemoryEstimateSummaryRepository implements EstimateSummaryRepository {
  private summaries: Map<string, EstimateSummarySnapshot> = new Map();

  async create(summary: EstimateSummarySnapshot): Promise<EstimateSummarySnapshot> {
    this.summaries.set(summary.id, { ...summary });
    return { ...summary };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateSummarySnapshot | null> {
    for (const s of this.summaries.values()) {
      if (s.tenantId === tenantId && s.estimateId === estimateId) return { ...s };
    }
    return null;
  }

  async findByTenantAndVertical(tenantId: string, verticalSlug: string): Promise<EstimateSummarySnapshot[]> {
    return Array.from(this.summaries.values())
      .filter((s) => s.tenantId === tenantId && s.verticalSlug === verticalSlug)
      .map((s) => ({ ...s }));
  }
}
