import { SourceContext, estimateContextSize, MAX_CONTEXT_TOKENS } from '../orchestration/context-builder';
import { VerticalPackConfig } from '../../shared/pack-config-loader';
import { EstimateTemplate } from './estimate-template';
import { VerticalType, ServiceCategory } from '../../shared/vertical-types';
import { EstimateSummarySnapshotRepository } from '../../estimates/estimate-snapshots';
import { BundlePatternRepository } from '../../estimates/bundle-patterns';
import { WordingPreferenceRepository } from '../../estimates/wording-preferences';
import { MissingItemSignalRepository } from '../../estimates/missing-item-signals';

// P4-009B: Service category + template context assembly
export interface VerticalEstimateContext {
  serviceCategory?: ServiceCategory;
  templateSummary?: {
    name: string;
    defaultLineItems: Array<{ description: string; category?: string }>;
    defaultNotes?: string;
  };
  terminologyHints?: Array<{ term: string; hint: string }>;
}

export function assembleVerticalEstimateContext(
  sourceContext: SourceContext,
  verticalConfig?: VerticalPackConfig | null,
  template?: EstimateTemplate | null
): VerticalEstimateContext {
  const result: VerticalEstimateContext = {};

  if (!verticalConfig) return result;

  if (template) {
    result.serviceCategory = template.serviceCategory;
    result.templateSummary = {
      name: template.name,
      defaultLineItems: template.defaultLineItems.map((li) => ({
        description: li.description,
        category: li.category,
      })),
      defaultNotes: template.defaultNotes,
    };
  }

  if (verticalConfig.terminology) {
    const hints: Array<{ term: string; hint: string }> = [];
    for (const [key, entry] of Object.entries(verticalConfig.terminology)) {
      hints.push({ term: entry.displayLabel, hint: entry.promptHint });
    }
    // Limit to top 15 terms to keep context size manageable
    result.terminologyHints = hints.slice(0, 15);
  }

  return result;
}

// P4-009C: History- and signal-aware context assembly
export interface HistoryContext {
  approvedExamples: Array<{ lineItems: string[]; totalCents: number; message?: string }>;
  bundleSuggestions: Array<{ items: string[]; frequency: number }>;
  wordingPreferences: Array<{ from: string; to: string }>;
  missingItemSignals: Array<{ description: string; frequency: number }>;
}

export interface HistoryContextRepositories {
  snapshotRepo: EstimateSummarySnapshotRepository;
  bundleRepo: BundlePatternRepository;
  wordingRepo: WordingPreferenceRepository;
  missingItemRepo: MissingItemSignalRepository;
}

export async function assembleHistoryContext(
  tenantId: string,
  verticalType?: VerticalType,
  serviceCategory?: ServiceCategory,
  repos?: Partial<HistoryContextRepositories>
): Promise<HistoryContext> {
  const result: HistoryContext = {
    approvedExamples: [],
    bundleSuggestions: [],
    wordingPreferences: [],
    missingItemSignals: [],
  };

  if (!repos) return result;

  // Approved examples from snapshots
  if (repos.snapshotRepo) {
    const snapshots = await repos.snapshotRepo.findByFilters(tenantId, {
      verticalType,
      serviceCategory,
      limit: 5,
    });
    result.approvedExamples = snapshots.map((s) => ({
      lineItems: s.lineItemDescriptions,
      totalCents: s.totalCents,
      message: s.customerMessage,
    }));
  }

  // Bundle suggestions
  if (repos.bundleRepo) {
    const bundles = await repos.bundleRepo.findByFilters(tenantId, {
      verticalType,
      serviceCategory,
    });
    result.bundleSuggestions = bundles
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5)
      .map((b) => ({
        items: b.items.map((i) => i.description),
        frequency: b.frequency,
      }));
  }

  // Wording preferences
  if (repos.wordingRepo) {
    const prefs = verticalType
      ? await repos.wordingRepo.findByFilters(tenantId, { verticalType })
      : await repos.wordingRepo.findByTenant(tenantId);
    result.wordingPreferences = prefs
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10)
      .map((p) => ({ from: p.canonicalPhrase, to: p.preferredPhrase }));
  }

  // Missing item signals
  if (repos.missingItemRepo) {
    const signals = await repos.missingItemRepo.findByFilters(tenantId, {
      verticalType,
      serviceCategory,
    });
    result.missingItemSignals = signals
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10)
      .map((s) => ({ description: s.description, frequency: s.frequency }));
  }

  return result;
}

// Combined full context
export interface FullEstimateContext {
  vertical: VerticalEstimateContext;
  history: HistoryContext;
}

export async function assembleFullEstimateContext(
  sourceContext: SourceContext,
  verticalConfig: VerticalPackConfig | null | undefined,
  template: EstimateTemplate | null | undefined,
  tenantId: string,
  verticalType?: VerticalType,
  serviceCategory?: ServiceCategory,
  repos?: Partial<HistoryContextRepositories>
): Promise<FullEstimateContext> {
  const vertical = assembleVerticalEstimateContext(sourceContext, verticalConfig, template);
  const history = await assembleHistoryContext(tenantId, verticalType, serviceCategory, repos);

  return { vertical, history };
}
