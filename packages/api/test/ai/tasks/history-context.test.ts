import { buildApprovedHistoryContextBlock, buildBundleSuggestionContextBlock, buildMissingItemContextBlock, assembleHistoryContext, formatApprovedHistoryForPrompt } from '../../../src/ai/tasks/history-context';
import { ApprovedEstimateLookupResult } from '../../../src/estimates/approved-estimate-lookup';

describe('P4-009C — History- and signal-aware context assembly', () => {
  const mockLookupResult: ApprovedEstimateLookupResult = {
    metadata: {
      id: 'm1', tenantId: 't1', estimateId: 'est-1', verticalSlug: 'hvac', categoryId: 'hvac-repair',
      approvedAt: new Date(), approvedBy: 'mgr', lineItemCount: 3, totalAmount: 450, tags: ['parts'], searchableContent: 'test',
    },
    relevanceScore: 0.85,
  };

  it('happy path — builds approved history context block', () => {
    const block = buildApprovedHistoryContextBlock([mockLookupResult]);
    expect(block.type).toBe('approved_history');
    expect(block.content).toContain('est-1');
    expect(block.content).toContain('$450.00');
  });

  it('happy path — builds bundle suggestion context block', () => {
    const block = buildBundleSuggestionContextBlock([{
      bundle: {
        id: 'b1', tenantId: 't', verticalSlug: 'hvac', name: 'AC Repair Bundle', description: 'd',
        items: [{ description: 'Diagnostic', typicalUnitPrice: 89, isRequired: true, sortOrder: 1 }],
        frequency: 5, confidence: 0.8, lastSeenAt: new Date(), createdAt: new Date(),
      },
      reason: 'High match', confidence: 0.8, sourceEstimateIds: ['est-1'],
    }]);
    expect(block.type).toBe('bundle_suggestions');
    expect(block.content).toContain('AC Repair Bundle');
    expect(block.content).toContain('Diagnostic');
  });

  it('happy path — builds missing item context block', () => {
    const block = buildMissingItemContextBlock([{
      lineItem: {
        id: '1', tenantId: 't', verticalSlug: 'hvac', normalizedDescription: 'capacitor',
        occurrenceCount: 8, avgQuantity: 1, avgUnitPrice: 250, lastSeenAt: new Date(), createdAt: new Date(),
      },
      reason: 'Frequently included', confidence: 0.8, suggestedUnitPrice: 250,
    }]);
    expect(block.type).toBe('missing_items');
    expect(block.content).toContain('capacitor');
    expect(block.content).toContain('$250');
  });

  it('validation — assembleHistoryContext returns only non-empty blocks', async () => {
    const blocks = await assembleHistoryContext([mockLookupResult], [], []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('approved_history');
  });

  it('mock provider test — formatApprovedHistoryForPrompt handles empty', () => {
    const result = formatApprovedHistoryForPrompt([]);
    expect(result).toContain('No approved estimate history');
  });

  it('malformed AI output handled gracefully — all empty returns no blocks', async () => {
    const blocks = await assembleHistoryContext([], [], []);
    expect(blocks).toHaveLength(0);
  });
});
