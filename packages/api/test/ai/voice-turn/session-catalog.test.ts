/**
 * WS5 — per-session catalog preload + bounded resolve.
 *
 * Covers: idempotent preload, active-item filtering, the "unavailable"
 * degradations (no preload, empty catalog, read error), and the tight
 * timeout that guarantees a slow DB never blocks the caller's turn.
 */
import { describe, it, expect } from 'vitest';
import {
  preloadSessionCatalog,
  resolveSessionCatalog,
} from '../../../src/ai/voice-turn/session-catalog';
import type { CatalogItem, CatalogItemRepository } from '../../../src/catalog/catalog-item';
import type { VoiceSession } from '../../../src/ai/agents/customer-calling/voice-session-store';

function item(name: string, unitPriceCents: number, archived = false): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name}`,
    tenantId: 't1',
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: archived ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal session stand-in — only the fields session-catalog reads. */
function fakeSession(): VoiceSession {
  return { id: 's1', tenantId: 't1' } as unknown as VoiceSession;
}

function repoReturning(
  items: CatalogItem[],
  opts: { delayMs?: number; throws?: boolean } = {},
): { repo: CatalogItemRepository; calls: () => number } {
  let calls = 0;
  const repo = {
    listByTenant: async () => {
      calls += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new Error('db down');
      return items;
    },
  } as unknown as CatalogItemRepository;
  return { repo, calls: () => calls };
}

describe('preloadSessionCatalog', () => {
  it('is idempotent — a second call does not re-load', () => {
    const session = fakeSession();
    const { repo, calls } = repoReturning([item('Gasket', 450)]);
    preloadSessionCatalog(session, repo);
    preloadSessionCatalog(session, repo);
    expect(calls()).toBe(1);
    expect(session.catalogPreload).toBeDefined();
  });

  it('no-ops when no catalogRepo is wired', () => {
    const session = fakeSession();
    preloadSessionCatalog(session, undefined);
    expect(session.catalogPreload).toBeUndefined();
  });
});

describe('resolveSessionCatalog', () => {
  it('returns active items (archived filtered out)', async () => {
    const session = fakeSession();
    const { repo } = repoReturning([item('Gasket', 450), item('Old Part', 100, true)]);
    preloadSessionCatalog(session, repo);
    const catalog = await resolveSessionCatalog(session);
    expect(catalog).toHaveLength(1);
    expect(catalog![0]!.name).toBe('Gasket');
  });

  it('returns null when no preload was started (unavailable)', async () => {
    const session = fakeSession();
    expect(await resolveSessionCatalog(session)).toBeNull();
  });

  it('returns null for an empty catalog', async () => {
    const session = fakeSession();
    const { repo } = repoReturning([]);
    preloadSessionCatalog(session, repo);
    expect(await resolveSessionCatalog(session)).toBeNull();
  });

  it('returns null on a read error (never rejects)', async () => {
    const session = fakeSession();
    const { repo } = repoReturning([], { throws: true });
    preloadSessionCatalog(session, repo);
    expect(await resolveSessionCatalog(session)).toBeNull();
  });

  it('returns null (degrades) when the load outruns the timeout budget', async () => {
    const session = fakeSession();
    const { repo } = repoReturning([item('Gasket', 450)], { delayMs: 200 });
    preloadSessionCatalog(session, repo);
    // 20ms budget vs 200ms load → timeout wins, degrade to unavailable.
    const catalog = await resolveSessionCatalog(session, 20);
    expect(catalog).toBeNull();
  });
});
