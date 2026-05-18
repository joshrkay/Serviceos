import { describe, it, expect, vi } from 'vitest';
import { VerticalTerminologyProvider } from '../../src/voice/vertical-terminology-provider';

describe('VerticalTerminologyProvider', () => {
  it('returns the active pack sttKeywords for a tenant', async () => {
    const repo = {
      findByType: vi.fn(async () => ({
        sttKeywords: ['furnace:3', 'compressor:3'],
      })),
    };
    const tenantVerticalLookup = vi.fn(async () => 'hvac' as const);
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: tenantVerticalLookup,
    });
    const keywords = await provider.getKeywords('tenant-1');
    expect(keywords).toEqual(['furnace:3', 'compressor:3']);
  });

  it('returns empty array when the tenant has no resolved vertical', async () => {
    const repo = { findByType: vi.fn(async () => null) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => null,
    });
    expect(await provider.getKeywords('tenant-2')).toEqual([]);
  });

  it('returns empty array when the pack lacks sttKeywords', async () => {
    const repo = { findByType: vi.fn(async () => ({ /* no sttKeywords */ })) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => 'plumbing' as const,
    });
    expect(await provider.getKeywords('tenant-3')).toEqual([]);
  });

  it('caps total returned keywords at 50 to protect Deepgram URL length', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `term${i}:2`);
    const repo = { findByType: vi.fn(async () => ({ sttKeywords: many })) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => 'hvac' as const,
    });
    const keywords = await provider.getKeywords('tenant-4');
    expect(keywords.length).toBe(50);
  });
});
