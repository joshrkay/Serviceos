/**
 * P8-001 — PgEntityResolver
 *
 * Postgres-backed entity resolver using pg_trgm similarity() for fuzzy
 * matching. Migration 051_p8_entity_resolution_indexes creates the GIN
 * trigram indexes on customers.name, jobs.title, invoices.invoice_number,
 * and a btree index on appointments.scheduled_for.
 *
 * Resolution thresholds:
 *   τ_ent = 0.80  — above → `resolved`
 *                 — multiple above → `ambiguous`
 *                 — none above → `not_found`
 *
 * All queries are scoped to tenantId for tenant isolation.
 */

import { Pool } from 'pg';
import { withTenantConnection } from '../../db/tenant-transaction';
import {
  EntityCandidate,
  EntityKind,
  EntityResolver,
  EntityResolverResult,
  TAU_ENT,
} from './entity-resolver';

/** Minimum similarity score to even consider a candidate (pre-filter). */
const SIMILARITY_PREFILTER = 0.3;

export class PgEntityResolver implements EntityResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
  }): Promise<EntityResolverResult> {
    const { tenantId, reference, kind } = input;

    // Guard: empty/null/whitespace-only references are not resolvable.
    if (!reference || reference.trim() === '') {
      return { kind: 'skipped' };
    }

    switch (kind) {
      case 'customer':
        return this.resolveCustomer(tenantId, reference);
      case 'job':
        return this.resolveJob(tenantId, reference);
      case 'invoice':
        return this.resolveInvoice(tenantId, reference);
      case 'appointment':
        return this.resolveAppointment(tenantId, reference);
      case 'estimate':
        return this.resolveEstimate(tenantId, reference);
      case 'technician':
        return this.resolveTechnician(tenantId, reference);
      default:
        return { kind: 'skipped' };
    }
  }

  // ---------------------------------------------------------------------------
  // Private resolution methods
  // ---------------------------------------------------------------------------

  private async resolveCustomer(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // Schema columns are display_name / primary_phone (the trigram index from
    // migration 051 is on display_name). Archived customers are excluded —
    // they must not become invoice/estimate targets.
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          display_name: string;
          primary_phone: string | null;
          score: number;
        }>(
          `SELECT id, display_name, primary_phone, similarity(display_name, $2) AS score
             FROM customers
            WHERE tenant_id = $1
              AND is_archived = false
              AND similarity(display_name, $2) > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'customer' as EntityKind,
      label: row.display_name,
      hint: row.primary_phone ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  private async resolveJob(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // Schema column is `summary` (the trigram index from migration 051 is on
    // jobs.summary — there is no `title` column).
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          summary: string;
          status: string | null;
          score: number;
        }>(
          `SELECT id, summary, status, similarity(summary, $2) AS score
             FROM jobs
            WHERE tenant_id = $1
              AND similarity(summary, $2) > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'job' as EntityKind,
      label: row.summary,
      hint: row.status ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  private async resolveInvoice(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const exact = await this.resolveExactDocumentNumber(
      tenantId,
      reference,
      'invoice',
      'invoices',
      'invoice_number',
    );
    if (exact) return exact;

    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          invoice_number: string;
          status: string | null;
          score: number;
        }>(
          `SELECT id, invoice_number, status, similarity(invoice_number, $2) AS score
             FROM invoices
            WHERE tenant_id = $1
              AND similarity(invoice_number, $2) > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'invoice' as EntityKind,
      label: row.invoice_number,
      hint: row.status ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  private async resolveEstimate(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const exact = await this.resolveExactDocumentNumber(
      tenantId,
      reference,
      'estimate',
      'estimates',
      'estimate_number',
      { excludeDeleted: true },
    );
    if (exact) return exact;
    return { kind: 'not_found', reference };
  }

  /**
   * Exact document-number match (INV-0042, EST-0042) before fuzzy trigram.
   * Returns null when no rows match so callers can fall through to similarity.
   */
  private async resolveExactDocumentNumber(
    tenantId: string,
    reference: string,
    kind: 'invoice' | 'estimate',
    table: 'invoices' | 'estimates',
    numberColumn: 'invoice_number' | 'estimate_number',
    opts: { excludeDeleted?: boolean } = {},
  ): Promise<EntityResolverResult | null> {
    const deletedFilter = opts.excludeDeleted ? ' AND deleted_at IS NULL' : '';
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          doc_number: string;
          status: string | null;
        }>(
          `SELECT id, ${numberColumn} AS doc_number, status
             FROM ${table}
            WHERE tenant_id = $1
              AND UPPER(${numberColumn}) = UPPER($2)${deletedFilter}
            ORDER BY created_at DESC
            LIMIT 5`,
          [tenantId, reference],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0) return null;

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind,
      label: row.doc_number,
      hint: row.status ?? undefined,
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  private async resolveAppointment(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const parsed = parseDateReference(reference);
    if (!parsed) {
      return { kind: 'not_found', reference };
    }

    // Schema column is `scheduled_start`; appointments have no title — label is
    // the start time, hint is the status. Canceled appointments are excluded
    // (they are not reschedule targets).
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          scheduled_start: string;
          status: string | null;
        }>(
          `SELECT id, scheduled_start, status
             FROM appointments
            WHERE tenant_id = $1
              AND scheduled_start >= $2
              AND scheduled_start < $3
              AND status <> 'canceled'
            ORDER BY scheduled_start ASC
            LIMIT 5`,
          [tenantId, parsed.start.toISOString(), parsed.end.toISOString()],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0) {
      return { kind: 'not_found', reference };
    }

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint: row.status ?? undefined,
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  private async resolveTechnician(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // U1 — spoken team-member names ("Carlos", "Mike R") resolve against the
    // users full-name expression. The expression must stay byte-identical to
    // migration 230's GIN trigram index expression so Postgres can serve it
    // from the index. Role filter: anyone assignable to an appointment
    // (technician/dispatcher/owner — the full users role CHECK today, kept
    // explicit so a future non-field role never becomes a reassign target).
    // Soft-deleted users (migration 093) are excluded — they must not become
    // assignment targets. Label = full name, hint = role.
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          full_name: string;
          role: string | null;
          score: number;
        }>(
          `SELECT id,
                  TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS full_name,
                  role,
                  similarity(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), $2) AS score
             FROM users
            WHERE tenant_id = $1
              AND role IN ('technician','dispatcher','owner')
              AND deleted_at IS NULL
              AND similarity(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), $2) > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'technician' as EntityKind,
      label: row.full_name,
      hint: row.role ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  // ---------------------------------------------------------------------------
  // Shared classification logic
  // ---------------------------------------------------------------------------

  /**
   * Convert a scored candidate list into a resolution result using τ_ent.
   *
   *   - 0 candidates above τ_ent → not_found
   *   - 1 candidate above τ_ent  → resolved
   *   - 2+ candidates above τ_ent → ambiguous
   */
  private toResult(
    candidates: EntityCandidate[],
    reference: string,
  ): EntityResolverResult {
    const above = candidates.filter((c) => c.score >= TAU_ENT);

    if (above.length === 0) {
      return { kind: 'not_found', reference };
    }
    if (above.length === 1) {
      return { kind: 'resolved', candidate: above[0] };
    }
    return { kind: 'ambiguous', candidates: above };
  }
}

// ---------------------------------------------------------------------------
// Relative date parsing helpers
// ---------------------------------------------------------------------------

interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Parse a natural-language date reference into a UTC date range covering
 * the full calendar day. Handles "today", "tomorrow", "yesterday", and
 * weekday names ("next Tuesday", "Tuesday").
 *
 * Returns null when the reference cannot be parsed.
 */
function parseDateReference(reference: string): DateRange | null {
  const ref = reference.toLowerCase().trim();
  const now = new Date();

  const startOfDay = (d: Date): Date => {
    const s = new Date(d);
    s.setUTCHours(0, 0, 0, 0);
    return s;
  };

  const endOfDay = (d: Date): Date => {
    const s = new Date(d);
    s.setUTCHours(23, 59, 59, 999);
    return s;
  };

  const rangeFor = (d: Date): DateRange => ({
    start: startOfDay(d),
    end: endOfDay(d),
  });

  if (ref === 'today') {
    return rangeFor(now);
  }

  if (ref === 'tomorrow') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    return rangeFor(d);
  }

  if (ref === 'yesterday') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return rangeFor(d);
  }

  // Weekday name, optionally prefixed with "next "
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextMatch = ref.match(/^(?:next\s+)?(\w+)$/);
  if (nextMatch) {
    const dayName = nextMatch[1];
    const targetDay = WEEKDAYS.indexOf(dayName);
    if (targetDay !== -1) {
      const isNext = ref.startsWith('next ');
      const d = new Date(now);
      const currentDay = d.getUTCDay();
      let diff = targetDay - currentDay;
      if (diff <= 0 || isNext) {
        diff += 7;
      }
      d.setUTCDate(d.getUTCDate() + diff);
      return rangeFor(d);
    }
  }

  // ISO date string "YYYY-MM-DD"
  const isoMatch = ref.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch) {
    const d = new Date(isoMatch[1] + 'T00:00:00.000Z');
    if (!isNaN(d.getTime())) {
      return rangeFor(d);
    }
  }

  return null;
}
