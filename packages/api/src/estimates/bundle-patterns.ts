import { v4 as uuidv4 } from 'uuid';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';
import { ApprovedEstimateMetadataRepository, ApprovedEstimateMetadata } from './approved-estimate-metadata';

export interface BundleItem {
  description: string;
  normalizedDescription: string;
  category?: string;
}

export interface BundlePattern {
  id: string;
  tenantId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  items: BundleItem[];
  frequency: number;
  confidence: number;
  lastSeenAt: Date;
}

export interface BundlePatternRepository {
  create(pattern: BundlePattern): Promise<BundlePattern>;
  findByTenant(tenantId: string): Promise<BundlePattern[]>;
  findByFilters(tenantId: string, filters: { verticalType?: VerticalType; serviceCategory?: ServiceCategory }): Promise<BundlePattern[]>;
}

export function validateBundlePattern(pattern: Partial<BundlePattern>): string[] {
  const errors: string[] = [];
  if (!pattern.tenantId) errors.push('tenantId is required');
  if (!pattern.items || pattern.items.length < 2) errors.push('Bundle must have at least 2 items');
  if (pattern.frequency !== undefined && pattern.frequency < 1) errors.push('frequency must be at least 1');
  if (pattern.confidence !== undefined && (pattern.confidence < 0 || pattern.confidence > 1)) {
    errors.push('confidence must be between 0 and 1');
  }
  return errors;
}

function normalizeDesc(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, ' ');
}

// P4-006B: Identify bundle patterns from approved estimates
export async function identifyBundlePatterns(
  tenantId: string,
  approvedEstimates: ApprovedEstimateMetadata[],
  options: { minFrequency?: number; verticalType?: VerticalType } = {}
): Promise<BundlePattern[]> {
  const minFreq = options.minFrequency ?? 2;

  // Cap inputs to prevent O(n * L²) DoS with large datasets
  const capped = approvedEstimates.slice(0, 500);

  // Group line item sets by estimate
  const itemSets: string[][] = capped
    .filter((e) => e.lineItemSummary.length >= 2)
    .map((e) => e.lineItemSummary.slice(0, 20).map((s) => normalizeDesc(s)).sort());

  // Find co-occurring pairs
  const pairCounts = new Map<string, { items: BundleItem[]; count: number; lastSeen: Date }>();

  for (const items of itemSets) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const key = `${items[i]}||${items[j]}`;
        const existing = pairCounts.get(key);
        if (existing) {
          existing.count += 1;
          existing.lastSeen = new Date();
        } else {
          pairCounts.set(key, {
            items: [
              { description: items[i], normalizedDescription: items[i] },
              { description: items[j], normalizedDescription: items[j] },
            ],
            count: 1,
            lastSeen: new Date(),
          });
        }
      }
    }
  }

  const patterns: BundlePattern[] = [];
  for (const [, data] of pairCounts) {
    if (data.count >= minFreq) {
      patterns.push({
        id: uuidv4(),
        tenantId,
        verticalType: options.verticalType,
        items: data.items,
        frequency: data.count,
        confidence: Math.min(data.count / itemSets.length, 1),
        lastSeenAt: data.lastSeen,
      });
    }
  }

  return patterns.sort((a, b) => b.frequency - a.frequency);
}

// P4-006B: Suggest bundles based on current line items
export async function suggestBundles(
  tenantId: string,
  currentLineItems: string[],
  bundleRepo: BundlePatternRepository
): Promise<BundlePattern[]> {
  const bundles = await bundleRepo.findByTenant(tenantId);
  const normalizedCurrent = new Set(currentLineItems.map((d) => normalizeDesc(d)));

  return bundles.filter((bundle) => {
    // At least one item matches, but not all (suggesting the missing ones)
    const matchCount = bundle.items.filter((item) => normalizedCurrent.has(item.normalizedDescription)).length;
    return matchCount > 0 && matchCount < bundle.items.length;
  });
}

export class InMemoryBundlePatternRepository implements BundlePatternRepository {
  private patterns: Map<string, BundlePattern> = new Map();

  async create(pattern: BundlePattern): Promise<BundlePattern> {
    this.patterns.set(pattern.id, { ...pattern, items: pattern.items.map(item => ({ ...item })) });
    return { ...pattern, items: pattern.items.map(item => ({ ...item })) };
  }

  async findByTenant(tenantId: string): Promise<BundlePattern[]> {
    return Array.from(this.patterns.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p, items: [...p.items] }));
  }

  async findByFilters(tenantId: string, filters: { verticalType?: VerticalType; serviceCategory?: ServiceCategory }): Promise<BundlePattern[]> {
    return Array.from(this.patterns.values())
      .filter((p) => {
        if (p.tenantId !== tenantId) return false;
        if (filters.verticalType && p.verticalType !== filters.verticalType) return false;
        if (filters.serviceCategory && p.serviceCategory !== filters.serviceCategory) return false;
        return true;
      })
      .map((p) => ({ ...p, items: [...p.items] }));
  }
}
