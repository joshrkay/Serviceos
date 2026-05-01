/**
 * P9-003 — ServiceAgreement domain entity + InMemory repository.
 */
import { AgreementStatus } from './enums';

export interface Agreement {
  id: string;
  tenantId: string;
  customerId: string;
  locationId?: string;
  name: string;
  description?: string;
  recurrenceRule: string;
  priceCents: number;
  autoGenerateInvoice: boolean;
  autoGenerateJob: boolean;
  /** Next scheduled run (UTC). */
  nextRunAt: Date;
  /** Last successful run (UTC). null until the first run. */
  lastRunAt?: Date;
  status: AgreementStatus;
  /** Calendar dates (YYYY-MM-DD strings). Stored as DATE in Postgres. */
  startsOn: string;
  endsOn?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgreementListOptions {
  customerId?: string;
  status?: AgreementStatus;
  limit?: number;
  offset?: number;
}

export interface AgreementRepository {
  create(agreement: Agreement): Promise<Agreement>;
  findById(tenantId: string, id: string): Promise<Agreement | null>;
  findByTenant(tenantId: string, options?: AgreementListOptions): Promise<Agreement[]>;
  /** Active agreements with next_run_at <= asOf. Used by runDueAgreements. */
  findDue(tenantId: string, asOf: Date): Promise<Agreement[]>;
  update(tenantId: string, id: string, updates: Partial<Agreement>): Promise<Agreement | null>;
}

export class InMemoryAgreementRepository implements AgreementRepository {
  private rows: Map<string, Agreement> = new Map();

  async create(agreement: Agreement): Promise<Agreement> {
    this.rows.set(agreement.id, { ...agreement });
    return { ...agreement };
  }

  async findById(tenantId: string, id: string): Promise<Agreement | null> {
    const a = this.rows.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    return { ...a };
  }

  async findByTenant(tenantId: string, options?: AgreementListOptions): Promise<Agreement[]> {
    let rows = Array.from(this.rows.values()).filter((a) => a.tenantId === tenantId);
    if (options?.customerId) rows = rows.filter((a) => a.customerId === options.customerId);
    if (options?.status) rows = rows.filter((a) => a.status === options.status);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map((a) => ({ ...a }));
  }

  async findDue(tenantId: string, asOf: Date): Promise<Agreement[]> {
    return Array.from(this.rows.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.status === 'active' &&
          a.nextRunAt.getTime() <= asOf.getTime() &&
          (!a.endsOn || a.endsOn >= asOf.toISOString().slice(0, 10)),
      )
      .map((a) => ({ ...a }));
  }

  async update(tenantId: string, id: string, updates: Partial<Agreement>): Promise<Agreement | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.tenantId !== tenantId) return null;
    const next = { ...existing, ...updates, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }
}
