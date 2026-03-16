import { ApprovedEstimateMetadata, ApprovedEstimateMetadataRepository, ApprovedEstimateFilters } from './approved-estimate-metadata';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';

export interface ApprovedEstimateLookupOptions {
  tenantId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  minDate?: Date;
  maxDate?: Date;
  limit?: number;
  searchTerms?: string[];
}

export interface ApprovedEstimateLookupResult {
  metadata: ApprovedEstimateMetadata;
  relevanceScore: number;
}

export async function lookupApprovedEstimates(
  options: ApprovedEstimateLookupOptions,
  repo: ApprovedEstimateMetadataRepository
): Promise<ApprovedEstimateLookupResult[]> {
  let records: ApprovedEstimateMetadata[];

  const filters: ApprovedEstimateFilters = {};
  if (options.verticalType) filters.verticalType = options.verticalType;
  if (options.serviceCategory) filters.serviceCategory = options.serviceCategory;
  if (options.minDate && options.maxDate) {
    filters.dateRange = { from: options.minDate, to: options.maxDate };
  }

  if (options.verticalType || options.serviceCategory) {
    records = await repo.findByFilters(options.tenantId, filters);
  } else {
    records = await repo.findByTenant(options.tenantId);
  }

  if (options.minDate && !options.maxDate) {
    records = records.filter((r) => r.approvedAt >= options.minDate!);
  }
  if (options.maxDate && !options.minDate) {
    records = records.filter((r) => r.approvedAt <= options.maxDate!);
  }

  const results = records.map((metadata) => ({
    metadata,
    relevanceScore: scoreRelevance(metadata, options),
  }));

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const limit = options.limit || 20;
  return results.slice(0, limit);
}

export function scoreRelevance(
  metadata: ApprovedEstimateMetadata,
  options: ApprovedEstimateLookupOptions
): number {
  let score = 0;

  if (options.verticalType && metadata.verticalType === options.verticalType) score += 0.3;
  if (options.serviceCategory && metadata.serviceCategory === options.serviceCategory) score += 0.3;

  // Recency boost
  const daysSinceApproval = (Date.now() - metadata.approvedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceApproval < 30) score += 0.2;
  else if (daysSinceApproval < 90) score += 0.1;

  // Search term matching
  if (options.searchTerms && options.searchTerms.length > 0) {
    const searchContent = (metadata.lineItemSummary || []).join(' ').toLowerCase();
    const matchedTerms = options.searchTerms.filter((term) =>
      searchContent.includes(term.toLowerCase())
    );
    score += (matchedTerms.length / options.searchTerms.length) * 0.2;
  }

  return Math.min(score, 1);
}
