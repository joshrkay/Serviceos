import { SourceContext, MAX_CONTEXT_TOKENS } from '../orchestration/context-builder';
import { VerticalPackConfig } from '../../shared/pack-config-loader';
import { EstimateTemplate } from './estimate-template';
import { VerticalType, ServiceCategory } from '../../shared/vertical-types';
import { EstimateSummarySnapshotRepository } from '../../estimates/estimate-snapshots';
import { BundlePatternRepository } from '../../estimates/bundle-patterns';
import { WordingPreferenceRepository } from '../../estimates/wording-preferences';
import { MissingItemSignalRepository } from '../../estimates/missing-item-signals';

const MAX_TERMINOLOGY_HINTS = 15;
type VerticalConfigInput = VerticalPackConfig | VerticalPackConfig[] | null | undefined;

// P4-009B: Service category + template context assembly
export interface VerticalEstimateContext {
  serviceCategory?: ServiceCategory;
  templateSummary?: {
    name: string;
    defaultLineItems: Array<{ description: string; category?: string }>;
    defaultNotes?: string;
  };
  terminologyHints?: Array<{ term: string; hint: string }>;
  terminologyPreferencesApplied?: Record<string, string>;
}

export function assembleVerticalEstimateContext(
  sourceContext: SourceContext,
  verticalConfig?: VerticalConfigInput,
  template?: EstimateTemplate | null
): VerticalEstimateContext {
  const result: VerticalEstimateContext = {};
  const resolvedConfig = resolveVerticalConfig(verticalConfig, template);

  if (!resolvedConfig) return result;

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

  if (resolvedConfig.terminology) {
    const hints: Array<{ term: string; hint: string }> = [];
    for (const [key, entry] of Object.entries(resolvedConfig.terminology)) {
      if (entry.displayLabel && entry.promptHint) {
        const tenantPreferredTerm = tenantTerminologyPreferences?.[key]?.trim();
        if (tenantPreferredTerm) {
          terminologyPreferencesApplied[key] = tenantPreferredTerm;
        }

        hints.push({
          term: terminologyPreferencesApplied[key] ?? entry.displayLabel,
          hint: entry.promptHint,
        });
      }
    }
    result.terminologyHints = hints.slice(0, MAX_TERMINOLOGY_HINTS);
    result.terminologyPreferencesApplied = terminologyPreferencesApplied;
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
  verticalConfig: VerticalConfigInput,
  template: EstimateTemplate | null | undefined,
  tenantId: string,
  verticalType?: VerticalType,
  serviceCategory?: ServiceCategory,
  repos?: Partial<HistoryContextRepositories>
): Promise<FullEstimateContext> {
  const vertical = assembleVerticalEstimateContext(sourceContext, verticalConfig, template);
  const history = await assembleHistoryContext(tenantId, verticalType, serviceCategory, repos);

  // Enforce token budget — progressively trim history if over limit
  trimHistoryToFit(vertical, history);

  return { vertical, history };
}

function resolveVerticalConfig(
  verticalConfig: VerticalConfigInput,
  template?: EstimateTemplate | null
): VerticalPackConfig | null {
  const fromInput = Array.isArray(verticalConfig) ? verticalConfig : verticalConfig ? [verticalConfig] : [];
  if (fromInput.length === 0) {
    return null;
  }

  return pickBestVerticalConfig(fromInput, template?.verticalType);
}

function pickBestVerticalConfig(
  configs: VerticalPackConfig[],
  preferredVerticalType?: VerticalType
): VerticalPackConfig {
  const sorted = [...configs].sort(
    (a, b) => a.verticalType.localeCompare(b.verticalType) || a.packId.localeCompare(b.packId)
  );
  if (preferredVerticalType) {
    return sorted.find((c) => c.verticalType === preferredVerticalType) ?? sorted[0];
  }
  return sorted[0];
}

function trimHistoryToFit(vertical: VerticalEstimateContext, history: HistoryContext): void {
  const contextSize = () => Math.ceil(JSON.stringify({ vertical, history }).length / 4);

  if (contextSize() <= MAX_CONTEXT_TOKENS) return;

  // Progressive trimming: reduce approved examples first
  if (history.approvedExamples.length > 3) {
    history.approvedExamples = history.approvedExamples.slice(0, 3);
  }
  if (contextSize() <= MAX_CONTEXT_TOKENS) return;

  if (history.approvedExamples.length > 1) {
    history.approvedExamples = history.approvedExamples.slice(0, 1);
  }
  if (contextSize() <= MAX_CONTEXT_TOKENS) return;

  // Then trim bundle suggestions
  if (history.bundleSuggestions.length > 3) {
    history.bundleSuggestions = history.bundleSuggestions.slice(0, 3);
  }
  if (contextSize() <= MAX_CONTEXT_TOKENS) return;

  // Then wording preferences
  if (history.wordingPreferences.length > 5) {
    history.wordingPreferences = history.wordingPreferences.slice(0, 5);
  }
  if (contextSize() <= MAX_CONTEXT_TOKENS) return;

  // Then missing item signals
  if (history.missingItemSignals.length > 5) {
    history.missingItemSignals = history.missingItemSignals.slice(0, 5);
  }
}
