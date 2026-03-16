import { v4 as uuidv4 } from 'uuid';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';
import { RepeatedItemSignal } from './repeated-item-detection';

const RECENCY_DIVISOR = 10;

export interface MissingItemSignal {
  id: string;
  tenantId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  description: string;
  normalizedDescription: string;
  frequency: number;
  recencyScore: number;
  lastSeenAt: Date;
}

export interface MissingItemFilters {
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  minFrequency?: number;
}

export interface MissingItemSignalRepository {
  create(signal: MissingItemSignal): Promise<MissingItemSignal>;
  findByTenant(tenantId: string): Promise<MissingItemSignal[]>;
  findByFilters(tenantId: string, filters: MissingItemFilters): Promise<MissingItemSignal[]>;
}

export function validateMissingItemSignal(signal: Partial<MissingItemSignal>): string[] {
  const errors: string[] = [];
  if (!signal.tenantId) errors.push('tenantId is required');
  if (!signal.description) errors.push('description is required');
  if (signal.frequency !== undefined && signal.frequency < 1) errors.push('frequency must be at least 1');
  if (signal.recencyScore !== undefined && (signal.recencyScore < 0 || signal.recencyScore > 1)) {
    errors.push('recencyScore must be between 0 and 1');
  }
  return errors;
}

export function storeMissingItemSignal(
  repeatedItems: RepeatedItemSignal[],
  maxAge: Date = new Date()
): MissingItemSignal[] {
  return repeatedItems.map((item) => ({
    id: uuidv4(),
    tenantId: item.tenantId,
    verticalType: item.verticalType,
    serviceCategory: item.serviceCategory,
    description: item.description,
    normalizedDescription: item.normalizedDescription,
    frequency: item.frequency,
    recencyScore: Math.min(1, item.frequency / RECENCY_DIVISOR),
    lastSeenAt: maxAge,
  }));
}

export async function getMissingItemSignals(
  tenantId: string,
  filters: MissingItemFilters,
  repository: MissingItemSignalRepository
): Promise<MissingItemSignal[]> {
  const signals = await repository.findByFilters(tenantId, filters);
  return signals.sort((a, b) => b.recencyScore - a.recencyScore || b.frequency - a.frequency);
}

export class InMemoryMissingItemSignalRepository implements MissingItemSignalRepository {
  private signals: Map<string, MissingItemSignal> = new Map();

  async create(signal: MissingItemSignal): Promise<MissingItemSignal> {
    this.signals.set(signal.id, { ...signal });
    return { ...signal };
  }

  async findByTenant(tenantId: string): Promise<MissingItemSignal[]> {
    return Array.from(this.signals.values())
      .filter((s) => s.tenantId === tenantId)
      .map((s) => ({ ...s }));
  }

  async findByFilters(tenantId: string, filters: MissingItemFilters): Promise<MissingItemSignal[]> {
    return Array.from(this.signals.values())
      .filter((s) => {
        if (s.tenantId !== tenantId) return false;
        if (filters.verticalType && s.verticalType !== filters.verticalType) return false;
        if (filters.serviceCategory && s.serviceCategory !== filters.serviceCategory) return false;
        if (filters.minFrequency && s.frequency < filters.minFrequency) return false;
        return true;
      })
      .map((s) => ({ ...s }));
  }
}
