// P4-009A/009B/009C: Vertical-Aware Context Assembly
// Assembles vertical-specific context for AI estimate generation

import { VerticalPack, VerticalPackRepository, VerticalType, resolveTerminology } from './registry';
import { ServiceBundle, ServiceBundleRepository, matchBundles } from './bundles';
import { EstimateTemplate, EstimateTemplateRepository, findBestTemplate } from '../templates/estimate-template';
import { WordingPreference, WordingPreferenceRepository, getWordingGuidelinesForPrompt } from './wording-preferences';
import {
  MissingItemRule,
  HVAC_MISSING_ITEM_RULES,
  PLUMBING_MISSING_ITEM_RULES,
} from './missing-items';
import { ApprovedEstimateContext, ApprovedEstimateRepository } from '../learning/approved-estimates';

export interface VerticalContext {
  verticalPack: VerticalPack | null;
  matchedTemplate: EstimateTemplate | null;
  matchedBundles: ServiceBundle[];
  wordingGuidelines: string;
  missingItemRules: MissingItemRule[];
  similarEstimates: ApprovedEstimateContext[];
  resolvedTerms: Record<string, string>;
}

export interface ContextAssemblyInput {
  tenantId: string;
  verticalType?: VerticalType;
  categoryId?: string;
  descriptionText: string;
  keywords: string[];
  estimatedTotalCents?: number;
}

export interface ContextAssemblyDependencies {
  verticalPackRepo: VerticalPackRepository;
  templateRepo: EstimateTemplateRepository;
  bundleRepo: ServiceBundleRepository;
  wordingRepo: WordingPreferenceRepository;
  approvedEstimateRepo: ApprovedEstimateRepository;
}

export async function assembleVerticalContext(
  input: ContextAssemblyInput,
  deps: ContextAssemblyDependencies
): Promise<VerticalContext> {
  const {
    tenantId,
    verticalType,
    categoryId,
    descriptionText,
    keywords,
    estimatedTotalCents,
  } = input;

  // 1. Load vertical pack
  let verticalPack: VerticalPack | null = null;
  if (verticalType) {
    verticalPack = await deps.verticalPackRepo.findByType(verticalType);
  }

  // 2. Find matching template
  let matchedTemplate: EstimateTemplate | null = null;
  if (categoryId) {
    const templates = await deps.templateRepo.findByCategory(tenantId, categoryId);
    matchedTemplate = findBestTemplate(templates, categoryId, keywords);
  }

  // 3. Find matching bundles
  let matchedBundles: ServiceBundle[] = [];
  if (verticalType) {
    const allBundles = await deps.bundleRepo.findByVertical(tenantId, verticalType);
    matchedBundles = matchBundles(allBundles, descriptionText);
  }

  // 4. Load wording preferences
  const wordingPrefs = await deps.wordingRepo.findByTenant(tenantId);
  const wordingGuidelines = getWordingGuidelinesForPrompt(
    wordingPrefs,
    'line_item_description'
  );

  // 5. Get missing item rules for the vertical
  const missingItemRules = getMissingItemRules(verticalType);

  // 6. Find similar approved estimates for learning
  let similarEstimates: ApprovedEstimateContext[] = [];
  if (categoryId && estimatedTotalCents) {
    const range = {
      min: Math.round(estimatedTotalCents * 0.5),
      max: Math.round(estimatedTotalCents * 2.0),
    };
    similarEstimates = await deps.approvedEstimateRepo.findSimilar(
      tenantId,
      categoryId,
      range,
      5
    );
  }

  // 7. Resolve terminology from the description
  const resolvedTerms: Record<string, string> = {};
  if (verticalPack) {
    for (const keyword of keywords) {
      const resolved = resolveTerminology(verticalPack, keyword);
      if (resolved) {
        resolvedTerms[keyword] = resolved.displayName;
      }
    }
  }

  return {
    verticalPack,
    matchedTemplate,
    matchedBundles,
    wordingGuidelines,
    missingItemRules,
    similarEstimates,
    resolvedTerms,
  };
}

function getMissingItemRules(verticalType?: VerticalType): MissingItemRule[] {
  switch (verticalType) {
    case 'hvac':
      return HVAC_MISSING_ITEM_RULES;
    case 'plumbing':
      return PLUMBING_MISSING_ITEM_RULES;
    default:
      return [];
  }
}

export function buildContextPromptSection(context: VerticalContext): string {
  const sections: string[] = [];

  // Vertical info
  if (context.verticalPack) {
    sections.push(
      `## Vertical: ${context.verticalPack.name}`,
      `Industry: ${context.verticalPack.description}`
    );
  }

  // Template guidance
  if (context.matchedTemplate) {
    sections.push(
      `\n## Template Match: ${context.matchedTemplate.name}`,
      `Template has ${context.matchedTemplate.lineItemTemplates.length} default line items.`,
      'Suggested line items:',
      ...context.matchedTemplate.lineItemTemplates.map(
        (li) =>
          `- ${li.description} (${li.category}, $${(li.defaultUnitPriceCents / 100).toFixed(2)} x ${li.defaultQuantity})`
      )
    );
  }

  // Bundle guidance
  if (context.matchedBundles.length > 0) {
    sections.push('\n## Matched Service Bundles:');
    for (const bundle of context.matchedBundles) {
      sections.push(`- ${bundle.name}: ${bundle.description || ''}`);
    }
  }

  // Wording guidelines
  if (context.wordingGuidelines) {
    sections.push(`\n## ${context.wordingGuidelines}`);
  }

  // Similar estimates for reference
  if (context.similarEstimates.length > 0) {
    sections.push(
      `\n## Reference: ${context.similarEstimates.length} similar approved estimates`,
      `Average total: $${(
        context.similarEstimates.reduce((sum, e) => sum + e.totals.totalCents, 0) /
        context.similarEstimates.length /
        100
      ).toFixed(2)}`
    );
  }

  // Resolved terminology
  if (Object.keys(context.resolvedTerms).length > 0) {
    sections.push('\n## Terminology:');
    for (const [term, display] of Object.entries(context.resolvedTerms)) {
      sections.push(`- "${term}" → ${display}`);
    }
  }

  return sections.join('\n');
}
