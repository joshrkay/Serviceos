/**
 * Maintenance contracts domain — graduated from the in-memory route stub to a
 * real persisted entity (migration 203). Distinct from `/api/agreements` (the
 * stricter RRULE-driven recurrence model); this is the lighter,
 * owner-authored "service plan" the Contracts page renders.
 *
 * The customer/location are stored as the free-text fields the Contracts UI
 * sends today (a display name and a street line), not FKs — graduating
 * persistence without re-architecting the contract↔CRM link (a separate
 * follow-up). On read they are reconstructed into the nested {customer,location}
 * shape the API already returns, so the client contract is unchanged.
 */
export type MaintenanceContractStatus = 'active' | 'paused' | 'cancelled';

export interface MaintenanceContract {
  id: string;
  tenantId: string;
  title: string;
  status: MaintenanceContractStatus;
  customer?: { id?: string; displayName?: string; firstName?: string; lastName?: string };
  location?: { id?: string; street1?: string };
  cadence?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
  defaultSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceContractRepository {
  create(contract: MaintenanceContract): Promise<MaintenanceContract>;
  findByTenant(tenantId: string): Promise<MaintenanceContract[]>;
  findById(tenantId: string, id: string): Promise<MaintenanceContract | null>;
}

export function validateMaintenanceContractTitle(title: unknown): string {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  return trimmed;
}

/** Test/double implementation mirroring the Pg repo's tenant scoping + order. */
export class InMemoryMaintenanceContractRepository implements MaintenanceContractRepository {
  private byTenant = new Map<string, MaintenanceContract[]>();

  async create(contract: MaintenanceContract): Promise<MaintenanceContract> {
    const rows = this.byTenant.get(contract.tenantId) ?? [];
    // Newest-first, matching the Pg ORDER BY created_at DESC.
    this.byTenant.set(contract.tenantId, [{ ...contract }, ...rows]);
    return { ...contract };
  }

  async findByTenant(tenantId: string): Promise<MaintenanceContract[]> {
    return (this.byTenant.get(tenantId) ?? []).map((c) => ({ ...c }));
  }

  async findById(tenantId: string, id: string): Promise<MaintenanceContract | null> {
    const found = (this.byTenant.get(tenantId) ?? []).find((c) => c.id === id);
    return found ? { ...found } : null;
  }
}
