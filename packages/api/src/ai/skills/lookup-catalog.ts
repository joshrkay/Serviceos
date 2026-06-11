/**
 * `lookup_catalog` voice skill — owner/dispatcher asks what's in the
 * service catalog ("what services do we offer?", "do we have a catalog
 * item for X?").
 *
 * Tenant-scoped, read-only. Lists active (non-archived) catalog items,
 * optionally filtered by a spoken search term. Bypasses the proposals
 * pipeline.
 */
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

export interface LookupCatalogInput {
  tenantId: string;
  sessionId?: string;
  /** Optional spoken search term ("water heater"). */
  search?: string;
}

export interface LookupCatalogDeps {
  catalogRepo: CatalogItemRepository;
  lookupEvents?: LookupEventService;
}

/**
 * P22-001 — pricing fields for catalog-aware invoice line items.
 * Additive only: existing callers (twilio-adapter, text-mode-driver)
 * keep consuming `summary`/`names` untouched.
 */
export interface LookupCatalogItemDetail {
  id: string;
  name: string;
  /** Integer cents — the catalog's exact price, never an LLM guess. */
  unitPriceCents: number;
  unit: string;
  category: string;
}

export type LookupCatalogResult =
  | {
      status: 'found';
      summary: string;
      data: { count: number; names: string[]; items: LookupCatalogItemDetail[] };
    }
  | { status: 'none'; summary: string; data: { count: 0; names: []; items: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

/** Speak at most this many item names so the TTS turn stays short. */
const MAX_SPOKEN_NAMES = 5;

export async function lookupCatalog(
  input: LookupCatalogInput,
  deps: LookupCatalogDeps,
): Promise<LookupCatalogResult> {
  const start = Date.now();
  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_catalog',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — audit failure never breaks the spoken turn */
    }
  };

  try {
    const items = await deps.catalogRepo.listByTenant(input.tenantId, {
      ...(input.search ? { search: input.search } : {}),
    });
    const active = items.filter((i) => i.archivedAt === null);

    if (active.length === 0) {
      const summary = input.search
        ? `I couldn't find any catalog items matching "${input.search}".`
        : 'Your service catalog is empty right now.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { count: 0, names: [], items: [] } };
    }

    const names = active.slice(0, MAX_SPOKEN_NAMES).map((i) => i.name);
    // P22-001: full active list with pricing — programmatic consumers
    // (catalog resolution) need every item, not the TTS-capped names.
    const detailedItems: LookupCatalogItemDetail[] = active.map((i) => ({
      id: i.id,
      name: i.name,
      unitPriceCents: i.unitPriceCents,
      unit: i.unit,
      category: i.category,
    }));
    const noun = active.length === 1 ? 'item' : 'items';
    const summary =
      active.length <= MAX_SPOKEN_NAMES
        ? `You have ${active.length} catalog ${noun}: ${names.join(', ')}.`
        : `You have ${active.length} catalog items, including ${names.join(', ')}.`;
    await record('found', active.length, summary);
    return {
      status: 'found',
      summary,
      data: { count: active.length, names, items: detailedItems },
    };
  } catch (err) {
    const summary = "I'm having trouble pulling up the catalog right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
