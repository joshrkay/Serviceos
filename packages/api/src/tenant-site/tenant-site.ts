/**
 * D-044 / #1768 — the hosted tenant site record: the business's chosen address
 * (slug) and whether the page is live (`tenant_sites`, migration 334). The page
 * content itself is never stored here; it is built from tenant settings on each
 * request so the site follows the settings.
 *
 * #1770 adds the connected domain (migrations 344/345): a domain the owner
 * already owns, pointed at the site by one CNAME, with the verification state
 * the sweep (workers/custom-domain-sweep.ts) advances.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

/**
 * Where a connected domain is on the way to serving. `pending_dns` waits for
 * the owner's CNAME, `pending_certificate` for HTTPS, `verified` serves, and
 * `failed` is the sweep giving up (the owner re-checks to start it again).
 */
export type CustomDomainStatus = 'pending_dns' | 'pending_certificate' | 'verified' | 'failed';

export interface CustomDomain {
  domain: string;
  status: CustomDomainStatus;
  /** A custom-domain error code for the last failed check, null when none. */
  error: string | null;
  /** The certificate provider's handle for the registered domain. */
  providerRef: string | null;
  attempts: number;
  nextCheckAt: Date | null;
  checkedAt: Date | null;
  verifiedAt: Date | null;
}

/** What one verification check changes; absent keys are left alone. */
export interface CustomDomainPatch {
  status?: CustomDomainStatus;
  error?: string | null;
  providerRef?: string | null;
  attempts?: number;
  nextCheckAt?: Date | null;
  checkedAt?: Date;
  verifiedAt?: Date | null;
}

export interface TenantSite {
  tenantId: string;
  slug: string;
  published: boolean;
  publishedAt: Date | null;
  customDomain: CustomDomain | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The address belongs to another business. */
export class TenantSiteSlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`Tenant site address "${slug}" is already taken`);
    this.name = 'TenantSiteSlugTakenError';
  }
}

/** Another business already has this domain verified. */
export class TenantSiteDomainTakenError extends Error {
  constructor(public readonly domain: string) {
    super(`Domain "${domain}" is already connected to another business`);
    this.name = 'TenantSiteDomainTakenError';
  }
}

export interface TenantSiteRepository {
  findByTenant(tenantId: string): Promise<TenantSite | null>;
  /**
   * The LIVE site at an address, across tenants (the Host header carries no
   * tenant). Unpublished sites are never returned.
   */
  findPublishedBySlug(slug: string): Promise<TenantSite | null>;
  /** True when a different tenant already owns the address (published or not). */
  isSlugTaken(slug: string, exceptTenantId?: string): Promise<boolean>;
  /** Creates or replaces the tenant's address; throws TenantSiteSlugTakenError on a race. */
  setSlug(tenantId: string, slug: string): Promise<TenantSite>;
  /** Null when the tenant has no site record. */
  setPublished(tenantId: string, published: boolean, at: Date): Promise<TenantSite | null>;

  // --- #1770 connected domain -----------------------------------------------
  /** The LIVE site (published, domain verified) served on this exact host, across tenants. */
  findPublishedByDomain(domain: string): Promise<TenantSite | null>;
  /** True when a different tenant has this domain VERIFIED (an unverified claim never blocks). */
  isDomainTaken(domain: string, exceptTenantId?: string): Promise<boolean>;
  /** Claims a domain (pending_dns, history cleared). Null when the tenant has no site record. */
  setCustomDomain(tenantId: string, domain: string, at: Date): Promise<TenantSite | null>;
  /** Back to pending_dns with the history cleared, keeping the domain. Null when none is set. */
  restartCustomDomain(tenantId: string, at: Date): Promise<TenantSite | null>;
  /** Drops the domain. Null when the tenant has no site record. */
  clearCustomDomain(tenantId: string): Promise<TenantSite | null>;
  /**
   * Applies a check's outcome, only while the tenant still holds `domain` (a
   * swap mid-check must not be overwritten). Throws TenantSiteDomainTakenError
   * when verifying collides with another tenant's verified claim.
   */
  updateCustomDomain(tenantId: string, domain: string, patch: CustomDomainPatch): Promise<TenantSite | null>;
  /** Claims waiting on DNS or a certificate whose next check is due, soonest first, across tenants. */
  listDueCustomDomains(now: Date, limit: number): Promise<TenantSite[]>;
}

export class InMemoryTenantSiteRepository implements TenantSiteRepository {
  private readonly sites = new Map<string, TenantSite>();

  async findByTenant(tenantId: string): Promise<TenantSite | null> {
    const site = this.sites.get(tenantId);
    return site ? { ...site } : null;
  }

  async findPublishedBySlug(slug: string): Promise<TenantSite | null> {
    for (const site of this.sites.values()) {
      if (site.slug === slug && site.published) return { ...site };
    }
    return null;
  }

  async isSlugTaken(slug: string, exceptTenantId?: string): Promise<boolean> {
    for (const site of this.sites.values()) {
      if (site.slug === slug && site.tenantId !== exceptTenantId) return true;
    }
    return false;
  }

  async setSlug(tenantId: string, slug: string): Promise<TenantSite> {
    if (await this.isSlugTaken(slug, tenantId)) throw new TenantSiteSlugTakenError(slug);
    const now = new Date();
    const existing = this.sites.get(tenantId);
    const next: TenantSite = existing
      ? { ...existing, slug, updatedAt: now }
      : { tenantId, slug, published: false, publishedAt: null, customDomain: null, createdAt: now, updatedAt: now };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async setPublished(tenantId: string, published: boolean, at: Date): Promise<TenantSite | null> {
    const existing = this.sites.get(tenantId);
    if (!existing) return null;
    const next: TenantSite = {
      ...existing,
      published,
      publishedAt: published ? at : existing.publishedAt,
      updatedAt: at,
    };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async findPublishedByDomain(domain: string): Promise<TenantSite | null> {
    for (const site of this.sites.values()) {
      if (site.published && site.customDomain?.status === 'verified' && site.customDomain.domain === domain) {
        return { ...site };
      }
    }
    return null;
  }

  async isDomainTaken(domain: string, exceptTenantId?: string): Promise<boolean> {
    for (const site of this.sites.values()) {
      if (
        site.customDomain?.status === 'verified' &&
        site.customDomain.domain === domain &&
        site.tenantId !== exceptTenantId
      ) {
        return true;
      }
    }
    return false;
  }

  private pendingDomain(domain: string, at: Date): CustomDomain {
    return {
      domain,
      status: 'pending_dns',
      error: null,
      providerRef: null,
      attempts: 0,
      nextCheckAt: at,
      checkedAt: null,
      verifiedAt: null,
    };
  }

  async setCustomDomain(tenantId: string, domain: string, at: Date): Promise<TenantSite | null> {
    const existing = this.sites.get(tenantId);
    if (!existing) return null;
    const next = { ...existing, customDomain: this.pendingDomain(domain, at), updatedAt: at };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async restartCustomDomain(tenantId: string, at: Date): Promise<TenantSite | null> {
    const existing = this.sites.get(tenantId);
    if (!existing?.customDomain) return null;
    const next = { ...existing, customDomain: this.pendingDomain(existing.customDomain.domain, at), updatedAt: at };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async clearCustomDomain(tenantId: string): Promise<TenantSite | null> {
    const existing = this.sites.get(tenantId);
    if (!existing) return null;
    const next = { ...existing, customDomain: null, updatedAt: new Date() };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async updateCustomDomain(tenantId: string, domain: string, patch: CustomDomainPatch): Promise<TenantSite | null> {
    const existing = this.sites.get(tenantId);
    if (!existing?.customDomain || existing.customDomain.domain !== domain) return null;
    if (patch.status === 'verified' && (await this.isDomainTaken(domain, tenantId))) {
      throw new TenantSiteDomainTakenError(domain);
    }
    const next = { ...existing, customDomain: { ...existing.customDomain, ...patch }, updatedAt: new Date() };
    this.sites.set(tenantId, next);
    return { ...next };
  }

  async listDueCustomDomains(now: Date, limit: number): Promise<TenantSite[]> {
    return [...this.sites.values()]
      .filter(
        (s) =>
          (s.customDomain?.status === 'pending_dns' || s.customDomain?.status === 'pending_certificate') &&
          s.customDomain.nextCheckAt !== null &&
          s.customDomain.nextCheckAt <= now,
      )
      .sort((a, b) => a.customDomain!.nextCheckAt!.getTime() - b.customDomain!.nextCheckAt!.getTime())
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
}

function mapRow(row: Record<string, unknown>): TenantSite {
  return {
    tenantId: row.tenant_id as string,
    slug: row.slug as string,
    published: row.published as boolean,
    publishedAt: (row.published_at as Date | null) ?? null,
    customDomain: row.custom_domain
      ? {
          domain: row.custom_domain as string,
          status: row.custom_domain_status as CustomDomainStatus,
          error: (row.custom_domain_error as string | null) ?? null,
          providerRef: (row.custom_domain_provider_ref as string | null) ?? null,
          attempts: Number(row.custom_domain_attempts ?? 0),
          nextCheckAt: (row.custom_domain_next_check_at as Date | null) ?? null,
          checkedAt: (row.custom_domain_checked_at as Date | null) ?? null,
          verifiedAt: (row.custom_domain_verified_at as Date | null) ?? null,
        }
      : null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

const COLUMNS =
  'tenant_id, slug, published, published_at, created_at, updated_at, custom_domain, custom_domain_status, ' +
  'custom_domain_error, custom_domain_provider_ref, custom_domain_attempts, custom_domain_next_check_at, ' +
  'custom_domain_checked_at, custom_domain_verified_at';
const UNIQUE_VIOLATION = '23505';

export class PgTenantSiteRepository extends PgBaseRepository implements TenantSiteRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async findByTenant(tenantId: string): Promise<TenantSite | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(`SELECT ${COLUMNS} FROM tenant_sites WHERE tenant_id = $1`, [tenantId]);
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async findPublishedBySlug(slug: string): Promise<TenantSite | null> {
    // The Host header names no tenant, so this lookup is the one intentional
    // cross-tenant read of the table (see withCrossTenantSweep).
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT ${COLUMNS} FROM tenant_sites WHERE slug = $1 AND published = TRUE`,
        [slug],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async isSlugTaken(slug: string, exceptTenantId?: string): Promise<boolean> {
    // RLS hides other tenants' rows from a tenant-scoped read, so "taken" has to
    // look across tenants. It reveals only whether an address exists.
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT 1 FROM tenant_sites WHERE slug = $1 AND ($2::uuid IS NULL OR tenant_id <> $2::uuid) LIMIT 1`,
        [slug, exceptTenantId ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async setSlug(tenantId: string, slug: string): Promise<TenantSite> {
    try {
      return await this.withTenant(tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO tenant_sites (tenant_id, slug) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug, updated_at = NOW()
           RETURNING ${COLUMNS}`,
          [tenantId, slug],
        );
        return mapRow(result.rows[0]);
      });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new TenantSiteSlugTakenError(slug);
      throw err;
    }
  }

  async setPublished(tenantId: string, published: boolean, at: Date): Promise<TenantSite | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_sites
            SET published = $2,
                published_at = CASE WHEN $2 THEN $3 ELSE published_at END,
                updated_at = $3
          WHERE tenant_id = $1
          RETURNING ${COLUMNS}`,
        [tenantId, published, at],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async findPublishedByDomain(domain: string): Promise<TenantSite | null> {
    // Like findPublishedBySlug: the Host header names no tenant.
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT ${COLUMNS} FROM tenant_sites
          WHERE custom_domain = $1 AND custom_domain_status = 'verified' AND published = TRUE`,
        [domain],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async isDomainTaken(domain: string, exceptTenantId?: string): Promise<boolean> {
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT 1 FROM tenant_sites
          WHERE custom_domain = $1 AND custom_domain_status = 'verified'
            AND ($2::uuid IS NULL OR tenant_id <> $2::uuid) LIMIT 1`,
        [domain, exceptTenantId ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async setCustomDomain(tenantId: string, domain: string, at: Date): Promise<TenantSite | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_sites
            SET custom_domain = $2, custom_domain_status = 'pending_dns', custom_domain_error = NULL,
                custom_domain_provider_ref = NULL, custom_domain_attempts = 0,
                custom_domain_next_check_at = $3, custom_domain_checked_at = NULL,
                custom_domain_verified_at = NULL, updated_at = $3
          WHERE tenant_id = $1
          RETURNING ${COLUMNS}`,
        [tenantId, domain, at],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async restartCustomDomain(tenantId: string, at: Date): Promise<TenantSite | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_sites
            SET custom_domain_status = 'pending_dns', custom_domain_error = NULL,
                custom_domain_provider_ref = NULL, custom_domain_attempts = 0,
                custom_domain_next_check_at = $2, custom_domain_checked_at = NULL,
                custom_domain_verified_at = NULL, updated_at = $2
          WHERE tenant_id = $1 AND custom_domain IS NOT NULL
          RETURNING ${COLUMNS}`,
        [tenantId, at],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async clearCustomDomain(tenantId: string): Promise<TenantSite | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_sites
            SET custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL,
                custom_domain_provider_ref = NULL, custom_domain_attempts = 0,
                custom_domain_next_check_at = NULL, custom_domain_checked_at = NULL,
                custom_domain_verified_at = NULL, updated_at = NOW()
          WHERE tenant_id = $1
          RETURNING ${COLUMNS}`,
        [tenantId],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async updateCustomDomain(tenantId: string, domain: string, patch: CustomDomainPatch): Promise<TenantSite | null> {
    const has = (k: keyof CustomDomainPatch): number => (patch[k] !== undefined ? 1 : 0);
    try {
      return await this.withTenant(tenantId, async (client) => {
        // `$n::int = 1` leaves an absent key untouched while letting a present key be NULL.
        const result = await client.query(
          `UPDATE tenant_sites
              SET custom_domain_status = CASE WHEN $3::int = 1 THEN $4::text ELSE custom_domain_status END,
                  custom_domain_error = CASE WHEN $5::int = 1 THEN $6::text ELSE custom_domain_error END,
                  custom_domain_provider_ref = CASE WHEN $7::int = 1 THEN $8::text ELSE custom_domain_provider_ref END,
                  custom_domain_attempts = CASE WHEN $9::int = 1 THEN $10::int ELSE custom_domain_attempts END,
                  custom_domain_next_check_at = CASE WHEN $11::int = 1 THEN $12::timestamptz ELSE custom_domain_next_check_at END,
                  custom_domain_checked_at = CASE WHEN $13::int = 1 THEN $14::timestamptz ELSE custom_domain_checked_at END,
                  custom_domain_verified_at = CASE WHEN $15::int = 1 THEN $16::timestamptz ELSE custom_domain_verified_at END,
                  updated_at = NOW()
            WHERE tenant_id = $1 AND custom_domain = $2
            RETURNING ${COLUMNS}`,
          [
            tenantId,
            domain,
            has('status'),
            patch.status ?? null,
            has('error'),
            patch.error ?? null,
            has('providerRef'),
            patch.providerRef ?? null,
            has('attempts'),
            patch.attempts ?? null,
            has('nextCheckAt'),
            patch.nextCheckAt ?? null,
            has('checkedAt'),
            patch.checkedAt ?? null,
            has('verifiedAt'),
            patch.verifiedAt ?? null,
          ],
        );
        return result.rows[0] ? mapRow(result.rows[0]) : null;
      });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new TenantSiteDomainTakenError(domain);
      throw err;
    }
  }

  async listDueCustomDomains(now: Date, limit: number): Promise<TenantSite[]> {
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT ${COLUMNS} FROM tenant_sites
          WHERE custom_domain_status IN ('pending_dns', 'pending_certificate')
            AND custom_domain_next_check_at <= $1
          ORDER BY custom_domain_next_check_at
          LIMIT $2`,
        [now, limit],
      );
      return result.rows.map(mapRow);
    });
  }
}
