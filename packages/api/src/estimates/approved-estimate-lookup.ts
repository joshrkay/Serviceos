import { ApprovedEstimateMetadata, ApprovedEstimateMetadataRepository } from './approved-estimate-metadata';

export interface ApprovedEstimateLookupOptions {
  tenantId: string;
  verticalSlug?: string;
  categoryId?: string;
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

  if (options.verticalSlug && options.categoryId) {
    records = await repo.findByVerticalAndCategory(options.tenantId, options.verticalSlug, options.categoryId);
  } else {
    records = await repo.findByTenant(options.tenantId);
  }

  if (options.verticalSlug && !options.categoryId) {
    records = records.filter((r) => r.verticalSlug === options.verticalSlug);
  }

  if (options.minDate) {
    records = records.filter((r) => r.approvedAt >= options.minDate!);
  }
  if (options.maxDate) {
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

  if (options.verticalSlug && metadata.verticalSlug === options.verticalSlug) score += 0.3;
  if (options.categoryId && metadata.categoryId === options.categoryId) score += 0.3;

  // Recency boost
  const daysSinceApproval = (Date.now() - metadata.approvedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceApproval < 30) score += 0.2;
  else if (daysSinceApproval < 90) score += 0.1;

  // Search term matching
  if (options.searchTerms && options.searchTerms.length > 0) {
    const matchedTerms = options.searchTerms.filter((term) =>
      metadata.searchableContent.includes(term.toLowerCase())
    );
    score += (matchedTerms.length / options.searchTerms.length) * 0.2;
  }

  return Math.min(score, 1);
}
