import { Estimate } from '../../estimates/estimate';
import { EstimateQualityMetric } from '../../estimates/estimate-quality';
import { LoadedVerticalPack } from '../../verticals/vertical-loader';
import { TerminologyMap, lookupTerm } from '../../verticals/terminology-map';
import { ServiceTaxonomy, findCategoryById } from '../../verticals/service-taxonomy';

export interface VerticalQualityMetric extends EstimateQualityMetric {
  verticalSlug: string;
  categoryId?: string;
}

export interface VerticalQualityDimension {
  dimension: string;
  weight: number;
  evaluator: (estimate: Estimate, pack: LoadedVerticalPack) => number;
}

export function evaluateVerticalQuality(estimate: Estimate, pack: LoadedVerticalPack): VerticalQualityMetric {
  const dimensions = [
    { dimension: 'terminology_accuracy', score: evaluateTerminologyAccuracy(estimate, pack.terminology), weight: 0.4 },
    { dimension: 'category_alignment', score: evaluateCategoryAlignment(estimate, pack.taxonomy, estimate.categoryId || ''), weight: 0.3 },
    { dimension: 'completeness', score: evaluateCompleteness(estimate), weight: 0.3 },
  ];

  const weightedScore = calculateWeightedScore(dimensions);

  return {
    id: '',
    tenantId: estimate.tenantId,
    estimateId: estimate.id,
    metricType: 'vertical_quality',
    score: weightedScore,
    details: {
      dimensions: dimensions.map((d) => ({ dimension: d.dimension, score: d.score, weight: d.weight })),
    },
    evaluatedAt: new Date(),
    verticalSlug: pack.pack.slug,
    categoryId: estimate.categoryId,
  };
}

export function evaluateTerminologyAccuracy(estimate: Estimate, terminology: TerminologyMap): number {
  if (estimate.lineItems.length === 0) return 0;

  let termsFound = 0;
  let totalTermsChecked = 0;

  for (const li of estimate.lineItems) {
    const words = li.description.split(/\s+/);
    for (const word of words) {
      if (word.length > 2) {
        totalTermsChecked++;
        if (lookupTerm(terminology, word)) {
          termsFound++;
        }
      }
    }
  }

  if (totalTermsChecked === 0) return 0;
  return Math.min(termsFound / Math.max(totalTermsChecked * 0.3, 1), 1);
}

export function evaluateCategoryAlignment(
  estimate: Estimate,
  taxonomy: ServiceTaxonomy,
  categoryId: string
): number {
  if (!categoryId) return 0;

  const category = findCategoryById(taxonomy, categoryId);
  if (!category) return 0;

  const categoryTerms = [...category.tags, category.name.toLowerCase()];
  let matches = 0;

  for (const li of estimate.lineItems) {
    const desc = li.description.toLowerCase();
    if (categoryTerms.some((t) => desc.includes(t.toLowerCase()))) {
      matches++;
    }
  }

  if (estimate.lineItems.length === 0) return 0;
  return matches / estimate.lineItems.length;
}

function evaluateCompleteness(estimate: Estimate): number {
  if (estimate.lineItems.length === 0) return 0;

  let score = 0;
  const factors = estimate.lineItems.length;

  for (const li of estimate.lineItems) {
    let itemScore = 0;
    if (li.description.length > 0) itemScore += 0.4;
    if (li.quantity > 0) itemScore += 0.2;
    if (li.unitPrice > 0) itemScore += 0.2;
    if (li.total > 0) itemScore += 0.2;
    score += itemScore;
  }

  return score / factors;
}

export function calculateWeightedScore(
  dimensions: { dimension: string; score: number; weight: number }[]
): number {
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight === 0) return 0;
  return dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight;
}
