import { ContextBlock, createContextBlock } from '../context-assembly';
import { ApprovedEstimateLookupResult } from '../../estimates/approved-estimate-lookup';
import { BundleSuggestion } from '../../estimates/bundle-suggestions';
import { MissingItemSignal } from '../../estimates/missing-item-signals';

export function buildApprovedHistoryContextBlock(
  lookupResults: ApprovedEstimateLookupResult[]
): ContextBlock {
  const content = formatApprovedHistoryForPrompt(lookupResults);
  return createContextBlock('approved_history', 'estimate_history', content, 7);
}

export function buildBundleSuggestionContextBlock(
  suggestions: BundleSuggestion[]
): ContextBlock {
  const lines = ['Suggested line-item bundles based on approved history:'];
  for (const suggestion of suggestions) {
    lines.push(`\n- Bundle: ${suggestion.bundle.name} (confidence: ${(suggestion.confidence * 100).toFixed(0)}%)`);
    lines.push(`  Reason: ${suggestion.reason}`);
    for (const item of suggestion.bundle.items) {
      const price = item.typicalUnitPrice ? ` @ $${item.typicalUnitPrice}` : '';
      lines.push(`  • ${item.description}${price}${item.isRequired ? '' : ' (optional)'}`);
    }
  }
  return createContextBlock('bundle_suggestions', 'learning', lines.join('\n'), 6);
}

export function buildMissingItemContextBlock(
  signals: MissingItemSignal[]
): ContextBlock {
  const lines = ['Potentially missing items based on historical patterns:'];
  for (const signal of signals) {
    const price = signal.suggestedUnitPrice ? ` (typical price: $${signal.suggestedUnitPrice})` : '';
    lines.push(`- ${signal.lineItem.normalizedDescription}${price}`);
    lines.push(`  Reason: ${signal.reason}`);
    lines.push(`  Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
  }
  return createContextBlock('missing_items', 'learning', lines.join('\n'), 5);
}

export async function assembleHistoryContext(
  lookupResults: ApprovedEstimateLookupResult[],
  bundleSuggestions: BundleSuggestion[],
  missingItemSignals: MissingItemSignal[]
): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];

  if (lookupResults.length > 0) {
    blocks.push(buildApprovedHistoryContextBlock(lookupResults));
  }
  if (bundleSuggestions.length > 0) {
    blocks.push(buildBundleSuggestionContextBlock(bundleSuggestions));
  }
  if (missingItemSignals.length > 0) {
    blocks.push(buildMissingItemContextBlock(missingItemSignals));
  }

  return blocks;
}

export function formatApprovedHistoryForPrompt(
  results: ApprovedEstimateLookupResult[]
): string {
  if (results.length === 0) return 'No approved estimate history available.';

  const lines = [`${results.length} similar approved estimate(s) found:`];
  for (const result of results.slice(0, 5)) {
    const m = result.metadata;
    lines.push(`\n- Estimate ${m.estimateId} (${m.verticalSlug}/${m.categoryId})`);
    lines.push(`  Items: ${m.lineItemCount}, Total: $${m.totalAmount.toFixed(2)}`);
    lines.push(`  Approved by: ${m.approvedBy} on ${m.approvedAt.toISOString().split('T')[0]}`);
    lines.push(`  Relevance: ${(result.relevanceScore * 100).toFixed(0)}%`);
  }
  return lines.join('\n');
}
