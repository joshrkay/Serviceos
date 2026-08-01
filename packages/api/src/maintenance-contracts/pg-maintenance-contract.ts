import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  MaintenanceContract,
  MaintenanceContractRepository,
  MaintenanceContractStatus,
} from './maintenance-contract';

function mapRow(row: Record<string, unknown>): MaintenanceContract {
  const displayName = (row.customer_display_name as string) ?? undefined;
  const street1 = (row.location_street1 as string) ?? undefined;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    title: row.title as string,
    status: row.status as MaintenanceContractStatus,
    // Reconstruct the nested shape the API already returns; omit entirely when
    // the free-text field is absent (matches the stub's `undefined`).
    customer: displayName ? { displayName } : undefined,
    location: street1 ? { street1 } : undefined,
    cadence: (row.cadence as string) ?? undefined,
    serviceWindow: (row.service_window as string) ?? undefined,
    duration: (row.duration as string) ?? undefined,
    startDate: (row.start_date as string) ?? undefined,
    endDate: (row.end_date as string) ?? undefined,
    defaultSummary: (row.default_summary as string) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export class PgMaintenanceContractRepository
  extends PgBaseRepository
  implements MaintenanceContractRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(contract: MaintenanceContract): Promise<MaintenanceContract> {
    return this.withTenant(contract.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO maintenance_contracts (
          id, tenant_id, title, status, customer_display_name, location_street1,
          cadence, service_window, duration, start_date, end_date, default_summary,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *`,
        [
          contract.id,
          contract.tenantId,
          contract.title,
          contract.status,
          contract.customer?.displayName ?? null,
          contract.location?.street1 ?? null,
          contract.cadence ?? null,
          contract.serviceWindow ?? null,
          contract.duration ?? null,
          contract.startDate ?? null,
          contract.endDate ?? null,
          contract.defaultSummary ?? null,
          contract.createdAt,
          contract.updatedAt,
        ],
      );
      return mapRow(res.rows[0]);
    });
  }

  async findByTenant(tenantId: string): Promise<MaintenanceContract[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM maintenance_contracts WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return res.rows.map(mapRow);
    });
  }

  async findById(tenantId: string, id: string): Promise<MaintenanceContract | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM maintenance_contracts WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
    });
  }
}
