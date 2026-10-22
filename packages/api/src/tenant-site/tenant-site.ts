/**
 * D-044 / #1768 — the hosted tenant site record: the business's chosen address
 * (slug) and whether the page is live (`tenant_sites`, migration 334). The page
 * content itself is never stored here; it is built from tenant settings on each
 * request so the site follows the settings.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface TenantSite {
  tenantId: string;
  slug: string;
  published: boolean;
  publishedAt: Date | null;
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
      : { tenantId, slug, published: false, publishedAt: null, createdAt: now, updatedAt: now };
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
}

function mapRow(row: Record<string, unknown>): TenantSite {
  return {
    tenantId: row.tenant_id as string,
    slug: row.slug as string,
    published: row.published as boolean,
    publishedAt: (row.published_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

const COLUMNS = 'tenant_id, slug, published, published_at, created_at, updated_at';
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
}
