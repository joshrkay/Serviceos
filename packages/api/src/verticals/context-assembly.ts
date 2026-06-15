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

export function buildMergedVerticalVoicePrompt(input: {
  canonicalPrompt?: string;
  trainingAssetPrompt?: string;
}): string | undefined {
  const sections = [input.canonicalPrompt, input.trainingAssetPrompt]
    .filter((section): section is string => Boolean(section && section.trim().length > 0));
  return sections.length > 0 ? sections.join('\n\n') : undefined;
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

/**
 * §3E — render the pack's `objectionScripts` as a prompt-shaped block.
 * Two distinct uses:
 *   1. Detection — the classifier sees the trigger patterns and learns
 *      which utterances should fire `objection_detected`.
 *   2. Reframe — when an objection is detected, the agent reads off
 *      the matching `reframe` string verbatim before continuing.
 *
 * Returns '' for null/empty pack so callers can unconditionally
 * concatenate. Mirrors the §3B/§3C/§3D formatter shapes.
 */
export function formatObjectionScriptsForPrompt(
  pack: import('./registry').VerticalPack | null | undefined,
): string {
  if (!pack) return '';
  const scripts = pack.objectionScripts ?? [];
  if (scripts.length === 0) return '';

  const lines: string[] = [
    'Objection-handling scripts (use the matching reframe verbatim when caller says something matching the trigger patterns):',
  ];
  for (const s of scripts) {
    lines.push(`  - id: ${s.id}`);
    lines.push(`    triggers: ${s.patterns.join(', ')}`);
    lines.push(`    reframe: "${s.reframe}"`);
  }
  return lines.join('\n');
}

/**
 * §3D — render the pack's `intakeQuestions` as a prompt-shaped block
 * the calling agent injects into the classifier system prompt. The
 * questions are reference material the LLM uses when classifier
 * confidence is below TAU_INT — instead of asking a generic "Can you
 * tell me more?" the agent picks a vertical-specific clarifying
 * question.
 *
 * Returns '' for null/undefined pack OR a pack with no intake
 * questions, so callers can unconditionally concatenate.
 */
export function formatIntakeQuestionsForPrompt(
  pack: import('./registry').VerticalPack | null | undefined,
): string {
  if (!pack) return '';
  const questions = pack.intakeQuestions ?? [];
  if (questions.length === 0) return '';

  const lines: string[] = ['Disambiguation questions to use when caller intent is unclear:'];
  for (const q of questions) {
    const intentLabel = q.intent ? ` [intent: ${q.intent}]` : '';
    lines.push(`  - "${q.question}"${intentLabel}`);
  }
  return lines.join('\n');
}

/**
 * Build a prompt section the calling agent can inject into its system
 * prompt for the `intent_capture` and downstream states. Closes §3B from
 * `docs/remaining-features.md`: without this, the agent receives the
 * VerticalContext as raw structure with no instructions on how to use it.
 *
 * The output is plain text shaped for an LLM:
 *   Service vertical: <name>
 *   Industry context: <description>
 *   Equipment and terminology recognized:
 *     - <DisplayLabel> (alias, alias)
 *     ...
 *   Service types offered:
 *     - <Category name>: <description>
 *
 * Returns an empty string when no pack is provided so callers can
 * unconditionally concatenate the result.
 *
 * Intake disambiguation questions and objection scripts (§3D / §3E) now
 * live on `VerticalPack` and are rendered by `formatIntakeQuestionsForPrompt`
 * / `formatObjectionScriptsForPrompt` (below); `resolve-active-pack.ts`
 * concatenates those blocks alongside this one. Emergency indicators are
 * handled deterministically by the pre-LLM keyword detector
 * (`ai/agents/customer-calling/emergency-detector.ts`), not via this prompt.
 */
export function formatVerticalForCallerPrompt(
  pack: import('./registry').VerticalPack | null | undefined,
): string {
  if (!pack) return '';

  const lines: string[] = [];
  const displayName = pack.displayName ?? pack.name;
  if (displayName) lines.push(`Service vertical: ${displayName}`);
  if (pack.description) lines.push(`Industry context: ${pack.description}`);

  const terminology = pack.terminology ?? {};
  const equipmentLines = Object.values(terminology).map((entry) => {
    const aliases = entry.aliases.length > 0 ? ` (${entry.aliases.join(', ')})` : '';
    return `  - ${entry.displayName}${aliases}`;
  });
  if (equipmentLines.length > 0) {
    lines.push('Equipment and terminology recognized:');
    lines.push(...equipmentLines);
  }

  const categories = pack.categories ?? [];
  if (categories.length > 0) {
    lines.push('Service types offered:');
    for (const cat of categories) {
      const desc = cat.description ? `: ${cat.description}` : '';
      lines.push(`  - ${cat.name}${desc}`);
    }
  }

  return lines.join('\n');
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
