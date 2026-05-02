/**
 * P9-003 — AgreementRun (audit row per recurrence cycle).
 *
 * Idempotency model: (agreement_id, scheduled_for) is unique. The Pg
 * migration enforces this via UNIQUE constraint; the in-memory repo
 * mirrors the rule so test environments behave the same.
 */
import { RunStatus } from './enums';

export interface AgreementRun {
  id: string;
  tenantId: string;
  agreementId: string;
  /** Calendar date (YYYY-MM-DD) the run was scheduled for. */
  scheduledFor: string;
  generatedJobId?: string;
  generatedInvoiceId?: string;
  status: RunStatus;
  errorMessage?: string;
  createdAt: Date;
}

export interface AgreementRunRepository {
  create(run: AgreementRun): Promise<AgreementRun>;
  findById(tenantId: string, id: string): Promise<AgreementRun | null>;
  findByAgreement(tenantId: string, agreementId: string, limit?: number): Promise<AgreementRun[]>;
  findByAgreementAndDate(
    tenantId: string,
    agreementId: string,
    scheduledFor: string,
  ): Promise<AgreementRun | null>;
  update(tenantId: string, id: string, updates: Partial<AgreementRun>): Promise<AgreementRun | null>;
}

export class InMemoryAgreementRunRepository implements AgreementRunRepository {
  private rows: Map<string, AgreementRun> = new Map();

  async create(run: AgreementRun): Promise<AgreementRun> {
    // Enforce the (agreement_id, scheduled_for) UNIQUE invariant.
    for (const existing of this.rows.values()) {
      if (
        existing.tenantId === run.tenantId &&
        existing.agreementId === run.agreementId &&
        existing.scheduledFor === run.scheduledFor
      ) {
        const err: Error & { code?: string } = new Error(
          `duplicate run for agreement ${run.agreementId} on ${run.scheduledFor}`,
        );
        err.code = '23505'; // PG unique_violation, so callers can branch the same way.
        throw err;
      }
    }
    this.rows.set(run.id, { ...run });
    return { ...run };
  }

  async findById(tenantId: string, id: string): Promise<AgreementRun | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findByAgreement(
    tenantId: string,
    agreementId: string,
    limit?: number,
  ): Promise<AgreementRun[]> {
    const rows = Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  async findByAgreementAndDate(
    tenantId: string,
    agreementId: string,
    scheduledFor: string,
  ): Promise<AgreementRun | null> {
    for (const r of this.rows.values()) {
      if (
        r.tenantId === tenantId &&
        r.agreementId === agreementId &&
        r.scheduledFor === scheduledFor
      ) {
        return { ...r };
      }
    }
    return null;
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<AgreementRun>,
  ): Promise<AgreementRun | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.tenantId !== tenantId) return null;
    const next = { ...existing, ...updates };
    this.rows.set(id, next);
    return { ...next };
  }
}
