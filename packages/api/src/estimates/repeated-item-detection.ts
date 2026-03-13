import { EditDeltaRepository, EstimateEditDelta } from './edit-delta';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';

export interface RepeatedItemSignal {
  description: string;
  normalizedDescription: string;
  frequency: number;
  tenantId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
}

export interface DetectionOptions {
  minFrequency?: number;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
}

export function normalizeDescription(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function detectRepeatedlyAddedItems(
  tenantId: string,
  estimateIds: string[],
  deltaRepo: EditDeltaRepository,
  options: DetectionOptions = {}
): Promise<RepeatedItemSignal[]> {
  const minFreq = options.minFrequency ?? 2;
  const descriptionCounts = new Map<string, { original: string; count: number }>();

  for (const estimateId of estimateIds) {
    const deltas = await deltaRepo.findByEstimate(tenantId, estimateId);
    for (const delta of deltas) {
      for (const entry of delta.deltas) {
        if (entry.type === 'line_item_added' && entry.newValue) {
          const item = entry.newValue as Record<string, unknown>;
          const desc = typeof item.description === 'string' ? item.description : '';
          if (!desc) continue;
          const normalized = normalizeDescription(desc);
          const existing = descriptionCounts.get(normalized);
          if (existing) {
            existing.count += 1;
          } else {
            descriptionCounts.set(normalized, { original: desc, count: 1 });
          }
        }
      }
    }
  }

  const signals: RepeatedItemSignal[] = [];
  for (const [normalized, data] of descriptionCounts) {
    if (data.count >= minFreq) {
      signals.push({
        description: data.original,
        normalizedDescription: normalized,
        frequency: data.count,
        tenantId,
        verticalType: options.verticalType,
        serviceCategory: options.serviceCategory,
      });
    }
  }

  return signals.sort((a, b) => b.frequency - a.frequency);
}
