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
import {
  EntityCandidate,
  EntityKind,
  EntityResolver,
  EntityResolverResult,
} from './entity-resolver';

/** Confidence threshold above which a match is considered "resolved". */
const TAU_ENT = 0.80;

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
        // No trigram index defined for estimates in migration 051; skip.
        return { kind: 'skipped' };
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{
        id: string;
        name: string;
        phone: string | null;
        score: number;
      }>(
        `SELECT id, name, phone, similarity(name, $2) AS score
           FROM customers
          WHERE tenant_id = $1
            AND similarity(name, $2) > $3
          ORDER BY score DESC
          LIMIT 5`,
        [tenantId, reference, SIMILARITY_PREFILTER],
      );
      await client.query('COMMIT');

      const candidates: EntityCandidate[] = rows.map((row) => ({
        id: row.id,
        kind: 'customer' as EntityKind,
        label: row.name,
        hint: row.phone ?? undefined,
        score: Number(row.score),
      }));

      return this.toResult(candidates, reference);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async resolveJob(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{
        id: string;
        title: string;
        status: string | null;
        score: number;
      }>(
        `SELECT id, title, status, similarity(title, $2) AS score
           FROM jobs
          WHERE tenant_id = $1
            AND similarity(title, $2) > $3
          ORDER BY score DESC
          LIMIT 5`,
        [tenantId, reference, SIMILARITY_PREFILTER],
      );
      await client.query('COMMIT');

      const candidates: EntityCandidate[] = rows.map((row) => ({
        id: row.id,
        kind: 'job' as EntityKind,
        label: row.title,
        hint: row.status ?? undefined,
        score: Number(row.score),
      }));

      return this.toResult(candidates, reference);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async resolveInvoice(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{
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
      );
      await client.query('COMMIT');

      const candidates: EntityCandidate[] = rows.map((row) => ({
        id: row.id,
        kind: 'invoice' as EntityKind,
        label: row.invoice_number,
        hint: row.status ?? undefined,
        score: Number(row.score),
      }));

      return this.toResult(candidates, reference);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async resolveAppointment(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const parsed = parseDateReference(reference);
    if (!parsed) {
      return { kind: 'not_found', reference };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{
        id: string;
        scheduled_for: string;
        title: string | null;
      }>(
        `SELECT id, scheduled_for, title
           FROM appointments
          WHERE tenant_id = $1
            AND scheduled_for >= $2
            AND scheduled_for < $3
          ORDER BY scheduled_for ASC
          LIMIT 5`,
        [tenantId, parsed.start.toISOString(), parsed.end.toISOString()],
      );
      await client.query('COMMIT');

      if (rows.length === 0) {
        return { kind: 'not_found', reference };
      }

      const candidates: EntityCandidate[] = rows.map((row) => ({
        id: row.id,
        kind: 'appointment' as EntityKind,
        label: row.title ?? new Date(row.scheduled_for).toISOString(),
        hint: new Date(row.scheduled_for).toISOString(),
        score: 1.0,
      }));

      if (candidates.length === 1) {
        return { kind: 'resolved', candidate: candidates[0] };
      }
      return { kind: 'ambiguous', candidates };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
