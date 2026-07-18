import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { CustomerRepository } from '../customers/customer';
import type { UserRepository } from '../users/user';
import type { TranscriptionGlossaryProvider } from '../workers/transcription';

export interface TenantGlossaryProviderDeps {
  catalogRepo: Pick<CatalogItemRepository, 'listByTenant'>;
  customerRepo: Pick<CustomerRepository, 'findByTenant'>;
  userRepo: Pick<UserRepository, 'findByTenant'>;
}

export interface TenantGlossaryProviderOptions {
  /**
   * TTL (ms) for the per-tenant cache. Defaults to 5 minutes — glossary
   * terms (catalog/customer/user names) change on the order of days, so a
   * few minutes of staleness is a fair trade for skipping 3 DB round-trips
   * on every Gather turn / transcription. `0` disables caching entirely
   * (repos are hit on every call) — useful for callers that need
   * up-to-the-second freshness or for tests asserting per-call repo hits.
   */
  cacheTtlMs?: number;
}

/** Default cache window: 5 minutes. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Upper bound on distinct tenant entries held in the cache. The provider
 * lives for the process lifetime, so an unbounded per-tenant map would be a
 * slow leak on a multi-tenant box. Insertion-order eviction (oldest key
 * dropped once the bound is hit) is sufficient — no LRU dependency needed.
 */
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  promise: Promise<string[]>;
  expiresAt: number;
}

/**
 * Supplies the transcription-correction pass with tenant-specific
 * vocabulary — catalog item names, active customer display names, and
 * technician/user names — so it can bias toward the tenant's real nouns
 * instead of mishearing them ("pex" -> "pecks", "Rodriguez" -> "Roderick").
 *
 * Bounded, tenant-scoped, and best-effort:
 *  - Each source is queried tenant-scoped and capped independently
 *    (`PER_SOURCE_CAP`) before merging, so one large source (e.g. a
 *    thousand-item catalog) can't crowd out the others — customer and
 *    technician names still make it into the glossary even on a tenant
 *    with a huge catalog.
 *  - The merged, deduped (case-insensitive) list is capped at
 *    `MAX_TERMS` (100) overall. `transcription_correction` routes to the
 *    lightweight model tier with `maxTokens: 2048`; 100 short terms keeps
 *    the glossary preamble a small, predictable fraction of that budget
 *    and leaves headroom for the transcript itself.
 *  - Any repo failure is caught per-source and swallowed — correction is
 *    a quality upgrade, never a gate, so `termsForTenant` NEVER throws.
 *    A failing source just contributes no terms; the terms already
 *    collected from other sources are still returned.
 *  - Results are cached per tenant for `cacheTtlMs` (default 5 minutes,
 *    see `TenantGlossaryProviderOptions`) so a Gather turn/transcription
 *    repeated for the same tenant within the window issues zero glossary
 *    DB queries, and concurrent lookups for the same tenant coalesce into
 *    one in-flight query set instead of a thundering herd.
 */
export class TenantGlossaryProvider implements TranscriptionGlossaryProvider {
  private static readonly MAX_TERMS = 100;
  /** Per-source cap applied before merging, so no single source can crowd out the others. */
  private static readonly PER_SOURCE_CAP = 40;

  private readonly cacheTtlMs: number;
  /**
   * Per-tenant cache of the in-flight/settled `termsForTenant` promise.
   * Caching the PROMISE (not just the resolved value) coalesces concurrent
   * lookups for the same tenant into one query set — a thundering herd of
   * Gather turns arriving together still hits the repos exactly once.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly deps: TenantGlossaryProviderDeps,
    options: TenantGlossaryProviderOptions = {}
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async termsForTenant(tenantId: string): Promise<string[]> {
    if (this.cacheTtlMs <= 0) {
      return this.fetchTermsForTenant(tenantId);
    }

    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached) {
      if (cached.expiresAt > now) {
        // Move to the end of insertion order on hit so the bound-eviction
        // sweep below drops the least-recently-used tenant, not just the
        // least-recently-inserted one.
        this.cache.delete(tenantId);
        this.cache.set(tenantId, cached);
        return cached.promise;
      }
      // Expired — evict and fall through to a fresh query.
      this.cache.delete(tenantId);
    }

    const expiresAt = now + this.cacheTtlMs;
    const promise = this.fetchTermsForTenant(tenantId).catch((err) => {
      // termsForTenant never rejects by contract (every source is caught
      // per-source in fetchTermsForTenant), but evict on rejection anyway
      // so a transient failure — should that contract ever change — can't
      // poison the cache window for the rest of its TTL.
      this.cache.delete(tenantId);
      throw err;
    });

    this.evictOldestIfAtBound();
    this.cache.set(tenantId, { promise, expiresAt });

    return promise;
  }

  /** Insertion-order eviction: drop the oldest entry once the bound is hit. */
  private evictOldestIfAtBound(): void {
    if (this.cache.size < MAX_CACHE_ENTRIES) return;
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  private async fetchTermsForTenant(tenantId: string): Promise<string[]> {
    const [catalogTerms, customerTerms, userTerms] = await Promise.all([
      this.safeCatalogTerms(tenantId),
      this.safeCustomerTerms(tenantId),
      this.safeUserTerms(tenantId),
    ]);

    const merged = [...catalogTerms, ...customerTerms, ...userTerms];
    return dedupeCaseInsensitive(merged).slice(0, TenantGlossaryProvider.MAX_TERMS);
  }

  private async safeCatalogTerms(tenantId: string): Promise<string[]> {
    try {
      const items = await this.deps.catalogRepo.listByTenant(tenantId);
      return cleanTerms(items.map((item) => item.name)).slice(
        0,
        TenantGlossaryProvider.PER_SOURCE_CAP
      );
    } catch {
      return [];
    }
  }

  private async safeCustomerTerms(tenantId: string): Promise<string[]> {
    try {
      const customers = await this.deps.customerRepo.findByTenant(tenantId, {
        includeArchived: false,
        limit: TenantGlossaryProvider.PER_SOURCE_CAP,
      });
      return cleanTerms(customers.map((customer) => customer.displayName)).slice(
        0,
        TenantGlossaryProvider.PER_SOURCE_CAP
      );
    } catch {
      return [];
    }
  }

  private async safeUserTerms(tenantId: string): Promise<string[]> {
    try {
      const users = await this.deps.userRepo.findByTenant(tenantId);
      const names = users.map((user) =>
        [user.firstName, user.lastName].filter((part) => part && part.trim().length > 0).join(' ')
      );
      return cleanTerms(names).slice(0, TenantGlossaryProvider.PER_SOURCE_CAP);
    } catch {
      return [];
    }
  }
}

/** Trims, drops empties, keeps first-seen order. */
function cleanTerms(raw: Array<string | undefined | null>): string[] {
  return raw
    .map((term) => (term ?? '').trim())
    .filter((term) => term.length > 0);
}

/** Dedupes case-insensitively while preserving first-seen casing and order. */
function dedupeCaseInsensitive(terms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
  }
  return result;
}
