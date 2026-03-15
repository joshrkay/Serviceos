import { LineItem } from './estimate';
import { LineItemFrequency, LineItemFrequencyRepository, normalizeLineItemDescription } from './line-item-frequency';
import { LineItemBundle, LineItemBundleRepository } from './line-item-bundle';

export interface MissingItemSignal {
  lineItem: LineItemFrequency;
  reason: string;
  confidence: number;
  suggestedQuantity?: number;
  suggestedUnitPrice?: number;
}

export interface MissingItemDetectionOptions {
  tenantId: string;
  verticalSlug: string;
  categoryId?: string;
  currentLineItems: LineItem[];
  frequencyThreshold?: number;
}

export async function detectMissingItems(
  options: MissingItemDetectionOptions,
  frequencyRepo: LineItemFrequencyRepository,
  bundleRepo: LineItemBundleRepository
): Promise<MissingItemSignal[]> {
  const threshold = options.frequencyThreshold || 3;
  const frequentItems = await frequencyRepo.findAboveThreshold(options.tenantId, threshold);
  const filteredFrequent = frequentItems.filter((f) => f.verticalSlug === options.verticalSlug);

  const bundles = await bundleRepo.findByVerticalAndCategory(
    options.tenantId,
    options.verticalSlug,
    options.categoryId
  );

  const fromFrequency = compareWithFrequentItems(options.currentLineItems, filteredFrequent);
  const fromBundles = compareWithBundles(options.currentLineItems, bundles);

  const allSignals = [...fromFrequency, ...fromBundles];
  const seen = new Set<string>();
  const unique = allSignals.filter((s) => {
    const key = s.lineItem.normalizedDescription;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.confidence - a.confidence);
  return unique;
}

export function compareWithFrequentItems(
  currentItems: LineItem[],
  frequentItems: LineItemFrequency[]
): MissingItemSignal[] {
  const currentNormalized = currentItems.map((li) => normalizeLineItemDescription(li.description));

  return frequentItems
    .filter((fi) => !currentNormalized.includes(fi.normalizedDescription))
    .map((fi) => ({
      lineItem: fi,
      reason: `Frequently included item (${fi.occurrenceCount} times) not in current estimate`,
      confidence: Math.min(fi.occurrenceCount / 10, 1),
      suggestedQuantity: fi.avgQuantity,
      suggestedUnitPrice: fi.avgUnitPrice,
    }));
}

export function compareWithBundles(
  currentItems: LineItem[],
  bundles: LineItemBundle[]
): MissingItemSignal[] {
  const currentNormalized = currentItems.map((li) => normalizeLineItemDescription(li.description));
  const signals: MissingItemSignal[] = [];

  for (const bundle of bundles) {
    for (const item of bundle.items) {
      const normalized = normalizeLineItemDescription(item.description);
      if (!currentNormalized.includes(normalized) && item.isRequired) {
        signals.push({
          lineItem: {
            id: '',
            tenantId: '',
            verticalSlug: '',
            normalizedDescription: normalized,
            occurrenceCount: bundle.frequency,
            avgQuantity: item.typicalQuantity || 1,
            avgUnitPrice: item.typicalUnitPrice || 0,
            lastSeenAt: bundle.lastSeenAt,
            createdAt: bundle.createdAt,
          },
          reason: `Required item in bundle "${bundle.name}" is missing`,
          confidence: bundle.confidence,
          suggestedQuantity: item.typicalQuantity,
          suggestedUnitPrice: item.typicalUnitPrice,
        });
      }
    }
  }

  return signals;
}
