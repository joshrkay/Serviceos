import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CatalogCategory,
  CatalogItem,
  CatalogItemRepository,
  ListCatalogItemOptions,
  ProductServiceType,
  UpdateCatalogItemInput,
} from './catalog-item';

function mapRow(row: Record<string, unknown>): CatalogItem {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? '',
    category: row.category as CatalogCategory,
    unit: row.unit as CatalogItem['unit'],
    unitPriceCents: Number(row.unit_price_cents),
    productServiceType: row.product_service_type as ProductServiceType,
    archivedAt: row.archived_at ? new Date(row.archived_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export class PgCatalogItemRepository extends PgBaseRepository implements CatalogItemRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(item: CatalogItem): Promise<CatalogItem> {
    return this.withTenant(item.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO catalog_items
          (id, tenant_id, name, description, category, unit, unit_price_cents, product_service_type, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          item.id,
          item.tenantId,
          item.name,
          item.description,
          item.category,
          item.unit,
          item.unitPriceCents,
          item.productServiceType,
          item.archivedAt,
          item.createdAt,
          item.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async listByTenant(tenantId: string, options: ListCatalogItemOptions = {}): Promise<CatalogItem[]> {
    return this.withTenant(tenantId, async (client) => {
      const whereClauses = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let param = 2;

      if (!options.includeArchived) {
        whereClauses.push('archived_at IS NULL');
      }

      if (options.category) {
        whereClauses.push(`category = $${param++}`);
        values.push(options.category);
      }

      if (options.search?.trim()) {
        whereClauses.push(`(name ILIKE $${param} OR description ILIKE $${param})`);
        values.push(`%${options.search.trim()}%`);
        param += 1;
      }

      // Stable ORDER BY is required before LIMIT so the bounded window is
      // deterministic across calls (matches InMemoryCatalogItemRepository's
      // `name.localeCompare` sort).
      let sql = `SELECT * FROM catalog_items
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY name ASC`;
      if (options.limit !== undefined) {
        sql += ` LIMIT $${param++}`;
        values.push(Math.max(0, Math.trunc(options.limit)));
      }

      const result = await client.query(sql, values);

      return result.rows.map(mapRow);
    });
  }

  async findById(tenantId: string, id: string): Promise<CatalogItem | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM catalog_items WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );

      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async update(tenantId: string, id: string, updates: UpdateCatalogItemInput): Promise<CatalogItem | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let param = 1;

      if (updates.name !== undefined) {
        setClauses.push(`name = $${param++}`);
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        setClauses.push(`description = $${param++}`);
        values.push(updates.description);
      }
      if (updates.category !== undefined) {
        setClauses.push(`category = $${param++}`);
        values.push(updates.category);
      }
      if (updates.unit !== undefined) {
        setClauses.push(`unit = $${param++}`);
        values.push(updates.unit);
      }
      if (updates.unitPriceCents !== undefined) {
        setClauses.push(`unit_price_cents = $${param++}`);
        values.push(updates.unitPriceCents);
      }
      if (updates.category !== undefined) {
        setClauses.push(`product_service_type = $${param++}`);
        values.push(updates.category === 'Labor' ? 'service' : 'product');
      }

      setClauses.push(`updated_at = $${param++}`);
      values.push(new Date());

      values.push(id);
      values.push(tenantId);

      const result = await client.query(
        `UPDATE catalog_items
         SET ${setClauses.join(', ')}
         WHERE id = $${param++} AND tenant_id = $${param} AND archived_at IS NULL
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async archive(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE catalog_items
         SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
        [id, tenantId]
      );

      return (result.rowCount ?? 0) > 0;
    });
  }
}
