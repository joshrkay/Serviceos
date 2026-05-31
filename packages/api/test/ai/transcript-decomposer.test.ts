import { describe, it, expect, vi } from 'vitest';
import {
  decomposeTranscript,
  parseDecompositionJson,
} from '../../src/ai/orchestration/transcript-decomposer';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';

describe('parseDecompositionJson', () => {
  it('returns null for invalid JSON', () => {
    expect(parseDecompositionJson('not json')).toBeNull();
    expect(parseDecompositionJson('[]')).toBeNull();
    expect(parseDecompositionJson('{"segments": []}')).toBeNull();
  });

  it('re-derives index from array position and sorts backward deps', () => {
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          { index: 0, text: 'create customer Jane', dependsOn: [], dependencyEntityKind: null },
          { index: 1, text: 'book Jane Tuesday', dependsOn: [0], dependencyEntityKind: 'customerId' },
        ],
      })
    );
    expect(segments).not.toBeNull();
    expect(segments!).toHaveLength(2);
    expect(segments![1].dependsOn).toEqual([0]);
    expect(segments![1].dependencyEntityKind).toBe('customerId');
  });

  it('sanitizes forward, self, and out-of-range dependency edges', () => {
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          // forward ref (1) and self ref (0) must be dropped
          { index: 0, text: 'a', dependsOn: [1, 0], dependencyEntityKind: 'customerId' },
          // out-of-range (5) dropped; valid backward (0) kept
          { index: 1, text: 'b', dependsOn: [0, 5], dependencyEntityKind: 'customerId' },
        ],
      })
    );
    expect(segments![0].dependsOn).toEqual([]);
    expect(segments![1].dependsOn).toEqual([0]);
  });

  it('drops an invalid dependencyEntityKind', () => {
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          { index: 0, text: 'a', dependsOn: [] },
          { index: 1, text: 'b', dependsOn: [0], dependencyEntityKind: 'bogus' },
        ],
      })
    );
    expect(segments![1].dependencyEntityKind).toBeUndefined();
  });

  it('skips empty-text segments', () => {
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          { index: 0, text: '  ', dependsOn: [] },
          { index: 1, text: 'real action', dependsOn: [] },
        ],
      })
    );
    expect(segments).toHaveLength(1);
    expect(segments![0].text).toBe('real action');
  });

  it('remaps dependency edges through original→new index when a segment is dropped', () => {
    // The LLM emits 3 segments; the middle one (original index 1) is
    // empty and dropped. Segment at original index 2 depends on 0 and
    // should still point at the surviving customer segment (new index 0).
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          { index: 0, text: 'create customer Jane', dependsOn: [] },
          { index: 1, text: '   ', dependsOn: [] },
          { index: 2, text: 'send Jane an estimate', dependsOn: [0], dependencyEntityKind: 'customerId' },
        ],
      })
    );
    expect(segments).toHaveLength(2);
    expect(segments![1].dependsOn).toEqual([0]);
    expect(segments![1].dependencyEntityKind).toBe('customerId');
  });

  it('translates 1-based LLM indices to 0-based', () => {
    const segments = parseDecompositionJson(
      JSON.stringify({
        segments: [
          { index: 1, text: 'create customer Jane', dependsOn: [] },
          { index: 2, text: 'book Jane', dependsOn: [1], dependencyEntityKind: 'jobId' },
        ],
      })
    );
    expect(segments).toHaveLength(2);
    // original index 1 → new 0, so the edge resolves to 0.
    expect(segments![1].dependsOn).toEqual([0]);
  });
});

describe('decomposeTranscript', () => {
  it('short-circuits empty transcript without an LLM call', async () => {
    const { gateway, provider } = createMockLLMGateway('{}');
    const spy = vi.spyOn(provider, 'complete');
    const result = await decomposeTranscript('   ', { tenantId: 't' }, gateway);
    expect(result.isMultiAction).toBe(false);
    expect(result.segments).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('flags a single-segment result as NOT multi-action', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({ segments: [{ index: 0, text: 'create an invoice', dependsOn: [] }] })
    );
    const result = await decomposeTranscript('create an invoice', { tenantId: 't' }, gateway);
    expect(result.isMultiAction).toBe(false);
  });

  it('flags multi-segment output as multi-action and carries token usage', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        segments: [
          { index: 0, text: 'create customer Jane', dependsOn: [] },
          { index: 1, text: 'book Jane Tuesday 2pm', dependsOn: [0], dependencyEntityKind: 'jobId' },
        ],
      })
    );
    const result = await decomposeTranscript('create Jane and book her', { tenantId: 't' }, gateway);
    expect(result.isMultiAction).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.tokenUsage).toBeDefined();
  });

  it('falls back to single-action on unparseable output', async () => {
    const { gateway } = createMockLLMGateway('garbage');
    const result = await decomposeTranscript('do two things', { tenantId: 't' }, gateway);
    expect(result.isMultiAction).toBe(false);
  });
});
