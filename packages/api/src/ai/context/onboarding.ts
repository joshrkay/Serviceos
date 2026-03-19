import { VerticalType, getServiceCategories } from '../../shared/vertical-types';
import { OnboardingExtraction } from '../tasks/onboarding/types';

export interface OnboardingContext {
  transcript: string;
  priorExtractions?: Partial<OnboardingExtraction>;
  verticalTaxonomy: Record<VerticalType, string[]>;
}

/**
 * Build context for onboarding extraction prompts.
 * Transcript-centric: no customer/job context needed.
 */
export function buildOnboardingContext(
  transcript: string,
  priorExtractions?: Partial<OnboardingExtraction>
): OnboardingContext {
  const verticalTaxonomy: Record<VerticalType, string[]> = {
    hvac: getServiceCategories('hvac').map(String),
    plumbing: getServiceCategories('plumbing').map(String),
  };

  return {
    transcript,
    priorExtractions,
    verticalTaxonomy,
  };
}

/**
 * Estimate token size of the onboarding context (~1 token per 4 chars).
 */
export function estimateOnboardingContextSize(context: OnboardingContext): number {
  return Math.ceil(JSON.stringify(context).length / 4);
}

/**
 * Format onboarding context as a prompt section for AI consumption.
 */
export function formatOnboardingContextForPrompt(context: OnboardingContext): string {
  const parts: string[] = [];

  parts.push(`Available verticals and categories:`);
  for (const [vertical, categories] of Object.entries(context.verticalTaxonomy)) {
    parts.push(`  ${vertical}: ${categories.join(', ')}`);
  }

  if (context.priorExtractions?.businessProfile) {
    const bp = context.priorExtractions.businessProfile;
    parts.push(`\nPrior extraction — Business profile:`);
    if (bp.businessName) parts.push(`  Name: ${bp.businessName}`);
    if (bp.verticalPacks.length > 0) {
      parts.push(`  Verticals: ${bp.verticalPacks.map((v) => v.type).join(', ')}`);
    }
  }

  if (context.priorExtractions?.categories) {
    const cats = context.priorExtractions.categories.categories;
    if (cats.length > 0) {
      parts.push(`\nPrior extraction — Categories:`);
      for (const cat of cats) {
        parts.push(`  ${cat.verticalType}/${cat.categoryId}: ${cat.name}`);
      }
    }
  }

  return parts.join('\n');
}
