import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface OnCallEntry {
  id: string;
  userId: string;
  orderIndex: number;
}

export interface OnCallRepository {
  getNextOnCall(tenantId: string): Promise<OnCallEntry | null>;
  listRotation(tenantId: string): Promise<OnCallEntry[]>;
}

export class PgOnCallRepository extends PgBaseRepository implements OnCallRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async getNextOnCall(tenantId: string): Promise<OnCallEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, user_id, order_index
         FROM tenant_oncall_rotation
         WHERE tenant_id = $1 AND active = true
         ORDER BY order_index ASC
         LIMIT 1`,
        [tenantId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        id: row.id as string,
        userId: row.user_id as string,
        orderIndex: row.order_index as number,
      };
    });
  }

  async listRotation(tenantId: string): Promise<OnCallEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, user_id, order_index
         FROM tenant_oncall_rotation
         WHERE tenant_id = $1 AND active = true
         ORDER BY order_index ASC`,
        [tenantId]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        orderIndex: row.order_index as number,
      }));
    });
  }
}

export class InMemoryOnCallRepository implements OnCallRepository {
  constructor(private readonly entries: Map<string, OnCallEntry[]> = new Map()) {}

  async getNextOnCall(tenantId: string): Promise<OnCallEntry | null> {
    const rotation = this.entries.get(tenantId);
    if (!rotation || rotation.length === 0) return null;
    // Return the entry with the lowest order_index
    const sorted = [...rotation].sort((a, b) => a.orderIndex - b.orderIndex);
    return sorted[0];
  }

  async listRotation(tenantId: string): Promise<OnCallEntry[]> {
    const rotation = this.entries.get(tenantId);
    if (!rotation || rotation.length === 0) return [];
    return [...rotation].sort((a, b) => a.orderIndex - b.orderIndex);
  }
}
