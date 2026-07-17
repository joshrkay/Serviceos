import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { CustomerRepository } from '../customers/customer';
import type { UserRepository } from '../users/user';
import type { TranscriptionGlossaryProvider } from '../workers/transcription';

export interface TenantGlossaryProviderDeps {
  catalogRepo: Pick<CatalogItemRepository, 'listByTenant'>;
  customerRepo: Pick<CustomerRepository, 'findByTenant'>;
  userRepo: Pick<UserRepository, 'findByTenant'>;
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
 */
export class TenantGlossaryProvider implements TranscriptionGlossaryProvider {
  private static readonly MAX_TERMS = 100;
  /** Per-source cap applied before merging, so no single source can crowd out the others. */
  private static readonly PER_SOURCE_CAP = 40;

  constructor(private readonly deps: TenantGlossaryProviderDeps) {}

  async termsForTenant(tenantId: string): Promise<string[]> {
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
