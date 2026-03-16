import { LineItemBundle, LineItemBundleRepository } from './line-item-bundle';
import { EstimateSummarySnapshot, EstimateSummaryRepository } from './estimate-summary';
import { LineItem } from './estimate';

export interface BundleSuggestion {
  bundle: LineItemBundle;
  reason: string;
  confidence: number;
  sourceEstimateIds: string[];
}

export interface BundleSuggestionOptions {
  tenantId: string;
  verticalSlug: string;
  categoryId?: string;
  currentLineItems?: LineItem[];
  limit?: number;
}

export async function suggestBundles(
  options: BundleSuggestionOptions,
  bundleRepo: LineItemBundleRepository,
  summaryRepo: EstimateSummaryRepository
): Promise<BundleSuggestion[]> {
  const bundles = await bundleRepo.findByVerticalAndCategory(
    options.tenantId,
    options.verticalSlug,
    options.categoryId
  );

  const summaries = await summaryRepo.findByTenantAndVertical(options.tenantId, options.verticalSlug);

  const suggestions: BundleSuggestion[] = bundles.map((bundle) => {
    const relevance = options.currentLineItems
      ? scoreBundleRelevance(bundle, options.currentLineItems)
      : bundle.confidence;

    const sourceIds = summaries
      .filter((s) => s.categoryId === bundle.categoryId)
      .map((s) => s.estimateId)
      .slice(0, 5);

    return {
      bundle,
      reason: buildSuggestionReason(bundle, relevance),
      confidence: relevance,
      sourceEstimateIds: sourceIds,
    };
  });

  suggestions.sort((a, b) => b.confidence - a.confidence);

  const limit = options.limit || 5;
  return suggestions.slice(0, limit);
}

export function detectBundlePatterns(
  estimates: EstimateSummarySnapshot[],
  minOccurrences: number
): LineItemBundle[] {
  const descriptionSets = new Map<string, { count: number; descriptions: string[] }>();

  for (const estimate of estimates) {
    const key = estimate.lineItemSummaries
      .map((li) => li.description.toLowerCase())
      .sort()
      .join('|');

    const existing = descriptionSets.get(key);
    if (existing) {
      existing.count++;
    } else {
      descriptionSets.set(key, {
        count: 1,
        descriptions: estimate.lineItemSummaries.map((li) => li.description),
      });
    }
  }

  const patterns: LineItemBundle[] = [];
  for (const [, value] of descriptionSets) {
    if (value.count >= minOccurrences) {
      patterns.push({
        id: '',
        tenantId: '',
        verticalSlug: '',
        name: `Pattern: ${value.descriptions.slice(0, 2).join(', ')}`,
        description: `Detected pattern appearing ${value.count} times`,
        items: value.descriptions.map((desc, i) => ({
          description: desc,
          isRequired: true,
          sortOrder: i + 1,
        })),
        frequency: value.count,
        confidence: 0,
        lastSeenAt: new Date(),
        createdAt: new Date(),
      });
    }
  }

  return patterns;
}

export function scoreBundleRelevance(bundle: LineItemBundle, currentLineItems: LineItem[]): number {
  if (bundle.items.length === 0) return 0;

  const currentDescriptions = currentLineItems.map((li) => li.description.toLowerCase());
  const bundleDescriptions = bundle.items.map((bi) => bi.description.toLowerCase());

  const matchedItems = bundleDescriptions.filter((bd) =>
    currentDescriptions.some((cd) => cd.includes(bd) || bd.includes(cd))
  );

  return matchedItems.length / bundleDescriptions.length;
}

function buildSuggestionReason(bundle: LineItemBundle, relevance: number): string {
  if (relevance > 0.7) return `High match with bundle "${bundle.name}" (${bundle.frequency} occurrences)`;
  if (relevance > 0.3) return `Partial match with bundle "${bundle.name}"`;
  return `Bundle "${bundle.name}" may be relevant based on frequency`;
}
