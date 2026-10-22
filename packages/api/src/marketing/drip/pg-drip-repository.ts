import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type {
  DripBooking,
  DripEnrollmentUpdate,
  DripRepository,
  DripSequenceStats,
  DripSignals,
  DripStepEventInput,
  DripTarget,
} from './drip-repository';
import type {
  DripEnrollment,
  DripSequence,
  DripSequenceStatus,
  DripStep,
  DripSourceEntityType,
  DripTargetKind,
} from './sequence';

/**
 * #1735 — Postgres adapters for drip campaigns. tenant_id is the first WHERE
 * predicate on every query (defense-in-depth alongside FORCE RLS, migrations
 * 336/337).
 */

function mapSequence(row: Record<string, unknown>): DripSequence {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    targetKind: row.target_kind as DripTargetKind,
    targetDays: Number(row.target_days),
    steps: row.steps as DripStep[],
    status: row.status as DripSequenceStatus,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapEnrollment(row: Record<string, unknown>): DripEnrollment {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sequenceId: row.sequence_id as string,
    customerId: row.customer_id as string,
    sourceEntityType: (row.source_entity_type as DripSourceEntityType | null) ?? null,
    sourceEntityId: (row.source_entity_id as string | null) ?? null,
    status: row.status as DripEnrollment['status'],
    exitReason: (row.exit_reason as DripEnrollment['exitReason']) ?? null,
    currentStep: Number(row.current_step),
    stepAttempts: Number(row.step_attempts),
    nextRunAt: new Date(row.next_run_at as string),
    enrolledAt: new Date(row.enrolled_at as string),
    finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
    bookedAt: row.booked_at ? new Date(row.booked_at as string) : null,
    bookedAppointmentId: (row.booked_appointment_id as string | null) ?? null,
  };
}

export class PgDripRepository extends PgBaseRepository implements DripRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createSequence(s: DripSequence): Promise<DripSequence> {
    return this.withTenant(s.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO drip_sequences (id, tenant_id, name, target_kind, target_days, steps, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING *`,
        [
          s.id,
          s.tenantId,
          s.name,
          s.targetKind,
          s.targetDays,
          JSON.stringify(s.steps),
          s.status,
          s.createdBy,
          s.createdAt,
          s.updatedAt,
        ],
      );
      return mapSequence(r.rows[0]);
    });
  }

  async findSequence(tenantId: string, id: string): Promise<DripSequence | null> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM drip_sequences WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return r.rows[0] ? mapSequence(r.rows[0]) : null;
    });
  }

  async listSequences(tenantId: string): Promise<DripSequence[]> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM drip_sequences WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId],
      );
      return r.rows.map(mapSequence);
    });
  }

  async setSequenceStatus(
    tenantId: string,
    id: string,
    status: DripSequenceStatus,
  ): Promise<DripSequence | null> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE drip_sequences SET status = $3, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, id, status],
      );
      return r.rows[0] ? mapSequence(r.rows[0]) : null;
    });
  }

  async stats(tenantId: string): Promise<DripSequenceStats[]> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT s.id AS sequence_id,
                COUNT(e.id) AS enrolled,
                COUNT(e.id) FILTER (WHERE e.status = 'active') AS active,
                COUNT(e.id) FILTER (WHERE e.status = 'completed') AS completed,
                COUNT(e.id) FILTER (WHERE e.booked_at IS NOT NULL) AS booked
           FROM drip_sequences s
           LEFT JOIN drip_enrollments e ON e.sequence_id = s.id AND e.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1
          GROUP BY s.id`,
        [tenantId],
      );
      return r.rows.map((row) => ({
        sequenceId: row.sequence_id as string,
        enrolled: Number(row.enrolled),
        active: Number(row.active),
        completed: Number(row.completed),
        booked: Number(row.booked),
      }));
    });
  }

  async enroll(
    tenantId: string,
    sequenceId: string,
    targets: DripTarget[],
    firstRunAt: Date,
  ): Promise<number> {
    if (targets.length === 0) return 0;
    return this.withTenant(tenantId, async (client) => {
      let added = 0;
      for (const t of targets) {
        const r = await client.query(
          `INSERT INTO drip_enrollments
             (tenant_id, sequence_id, customer_id, source_entity_type, source_entity_id, source_due_on, next_run_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7)
           ON CONFLICT (tenant_id, sequence_id, customer_id) DO NOTHING`,
          [tenantId, sequenceId, t.customerId, t.sourceEntityType, t.sourceEntityId, t.sourceDueOn ?? null, firstRunAt],
        );
        added += r.rowCount ?? 0;
      }
      return added;
    });
  }

  async listDue(tenantId: string, now: Date, limit: number): Promise<DripEnrollment[]> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT e.* FROM drip_enrollments e
           JOIN drip_sequences s ON s.id = e.sequence_id AND s.tenant_id = e.tenant_id
          WHERE e.tenant_id = $1 AND e.status = 'active' AND e.next_run_at <= $2
            AND s.status = 'active'
          ORDER BY e.next_run_at ASC
          LIMIT $3`,
        [tenantId, now, limit],
      );
      return r.rows.map(mapEnrollment);
    });
  }

  async claim(tenantId: string, id: string, now: Date, leaseUntil: Date): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE drip_enrollments SET next_run_at = $4, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND next_run_at <= $3`,
        [tenantId, id, now, leaseUntil],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async updateEnrollment(tenantId: string, id: string, u: DripEnrollmentUpdate): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE drip_enrollments
            SET status = $3, exit_reason = $4, current_step = $5, step_attempts = $6,
                next_run_at = $7, finished_at = $8, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, u.status, u.exitReason, u.currentStep, u.stepAttempts, u.nextRunAt, u.finishedAt],
      );
    });
  }

  async recordBooking(tenantId: string, id: string, booking: DripBooking): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE drip_enrollments SET booked_at = $3, booked_appointment_id = $4, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, booking.bookedAt, booking.appointmentId],
      );
    });
  }

  async listAttributionCandidates(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<DripEnrollment[]> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM drip_enrollments
          WHERE tenant_id = $1 AND status <> 'active' AND booked_at IS NULL AND finished_at >= $2
          ORDER BY finished_at DESC LIMIT $3`,
        [tenantId, since, limit],
      );
      return r.rows.map(mapEnrollment);
    });
  }

  async addStepEvent(e: DripStepEventInput): Promise<void> {
    await this.withTenant(e.tenantId, async (client) => {
      await client.query(
        `INSERT INTO drip_step_events (tenant_id, enrollment_id, step_index, channel, outcome, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.tenantId, e.enrollmentId, e.stepIndex, e.channel, e.outcome, e.reason ?? null],
      );
    });
  }
}

/** Targeting and exit-condition reads over customers / jobs / estimates / appointments / messages. */
export class PgDripSignals extends PgBaseRepository implements DripSignals {
  constructor(pool: Pool) {
    super(pool);
  }

  async findTargets(
    tenantId: string,
    kind: DripTargetKind,
    days: number,
    now: Date,
    limit: number,
    sequenceId: string,
  ): Promise<DripTarget[]> {
    // Customers already in this campaign are skipped BEFORE the cap, so each
    // "add matching customers" reaches past the ones the last run enrolled.
    const notEnrolled = (customerCol: string) =>
      `NOT EXISTS (SELECT 1 FROM drip_enrollments de
                    WHERE de.tenant_id = $1 AND de.sequence_id = $5::uuid AND de.customer_id = ${customerCol})`;
    return this.withTenant(tenantId, async (client) => {
      if (kind === 'lapsed_customers') {
        // Had a completed job once, none (of any status) created within the window.
        const r = await client.query(
          `SELECT c.id FROM customers c
            WHERE c.tenant_id = $1 AND c.is_archived = false
              AND EXISTS (SELECT 1 FROM jobs j WHERE j.tenant_id = c.tenant_id
                            AND j.customer_id = c.id AND j.status = 'completed')
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.tenant_id = c.tenant_id
                                AND j.customer_id = c.id
                                AND j.created_at > $2::timestamptz - make_interval(days => $3))
              AND ${notEnrolled('c.id')}
            ORDER BY c.created_at ASC
            LIMIT $4`,
          [tenantId, now, days, limit, sequenceId],
        );
        return r.rows.map((row) => ({
          customerId: row.id as string,
          sourceEntityType: null,
          sourceEntityId: null,
        }));
      }
      if (kind === 'membership_renewals') {
        // An active membership that will NOT renew itself and ends within
        // `days`, for a customer with no other active membership that both
        // starts by the day after it ends (no gap) and runs past the window.
        // One row per customer: the soonest-ending membership.
        const r = await client.query(
          `SELECT DISTINCT ON (a.customer_id) a.customer_id, a.id AS agreement_id, a.ends_on::text AS ends_on
             FROM service_agreements a
             JOIN customers c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
            WHERE a.tenant_id = $1 AND a.status = 'active' AND a.auto_renew = false
              AND c.is_archived = false
              AND a.ends_on IS NOT NULL
              -- a term that has not started yet is not up for renewal
              AND a.starts_on <= ($2::timestamptz)::date
              AND a.ends_on >= ($2::timestamptz)::date
              AND a.ends_on <= ($2::timestamptz + make_interval(days => $3))::date
              AND NOT EXISTS (SELECT 1 FROM service_agreements o
                               WHERE o.tenant_id = a.tenant_id AND o.customer_id = a.customer_id
                                 AND o.id <> a.id AND o.status = 'active'
                                 AND o.starts_on <= a.ends_on + 1
                                 AND (o.auto_renew = true OR o.ends_on IS NULL
                                      OR o.ends_on > ($2::timestamptz + make_interval(days => $3))::date))
              AND ${notEnrolled('a.customer_id')}
            ORDER BY a.customer_id, a.ends_on ASC
            LIMIT $4`,
          [tenantId, now, days, limit, sequenceId],
        );
        return r.rows.map((row) => ({
          customerId: row.customer_id as string,
          sourceEntityType: 'service_agreement' as const,
          sourceEntityId: row.agreement_id as string,
          sourceDueOn: row.ends_on as string,
        }));
      }
      // Unsold: an estimate still 'sent' for `days`, and the customer has no accepted estimate since.
      const r = await client.query(
        `SELECT DISTINCT ON (j.customer_id) j.customer_id, e.id AS estimate_id
           FROM estimates e
           JOIN jobs j ON j.id = e.job_id AND j.tenant_id = e.tenant_id
           JOIN customers c ON c.id = j.customer_id AND c.tenant_id = j.tenant_id
          WHERE e.tenant_id = $1 AND e.status = 'sent' AND c.is_archived = false
            AND e.updated_at < $2::timestamptz - make_interval(days => $3)
            AND NOT EXISTS (SELECT 1 FROM estimates e2 JOIN jobs j2 ON j2.id = e2.job_id AND j2.tenant_id = e2.tenant_id
                             WHERE e2.tenant_id = e.tenant_id AND j2.customer_id = j.customer_id
                               AND e2.status = 'accepted' AND e2.updated_at >= e.updated_at)
            AND ${notEnrolled('j.customer_id')}
          ORDER BY j.customer_id, e.updated_at DESC
          LIMIT $4`,
        [tenantId, now, days, limit, sequenceId],
      );
      return r.rows.map((row) => ({
        customerId: row.customer_id as string,
        sourceEntityType: 'estimate' as const,
        sourceEntityId: row.estimate_id as string,
      }));
    });
  }

  async findBookingSince(
    tenantId: string,
    customerId: string,
    since: Date,
  ): Promise<DripBooking | null> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT a.id, a.created_at FROM appointments a
           JOIN jobs j ON j.id = a.job_id AND j.tenant_id = a.tenant_id
          WHERE a.tenant_id = $1 AND j.customer_id = $2 AND a.created_at > $3
            AND a.status <> 'canceled'
          ORDER BY a.created_at ASC LIMIT 1`,
        [tenantId, customerId, since],
      );
      const row = r.rows[0];
      return row
        ? { appointmentId: row.id as string, bookedAt: new Date(row.created_at as string) }
        : null;
    });
  }

  async hasRenewedMembership(tenantId: string, enrollmentId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM drip_enrollments e
           JOIN drip_sequences s ON s.tenant_id = e.tenant_id AND s.id = e.sequence_id
           JOIN service_agreements a
             ON a.tenant_id = e.tenant_id AND a.status = 'active'
            AND (a.id = e.source_entity_id
                 OR (a.customer_id = e.customer_id
                     -- another membership only counts if it starts by the day after the old term ends
                     AND a.starts_on <= e.source_due_on + 1))
          WHERE e.tenant_id = $1 AND e.id = $2 AND e.source_entity_type = 'service_agreement'
            AND (a.auto_renew = true OR a.ends_on IS NULL
                 OR a.ends_on > CASE
                      -- the enrolled membership, or one added since: any end past the old one
                      WHEN a.id = e.source_entity_id OR a.created_at > e.enrolled_at THEN e.source_due_on
                      -- one that already existed at enrollment: targeting proved it ended inside
                      -- the window then, so it counts once it runs past that window
                      -- (target_days is fixed once the campaign is created)
                      ELSE (e.enrolled_at + make_interval(days => s.target_days))::date
                    END)
          LIMIT 1`,
        [tenantId, enrollmentId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async hasRepliedSince(tenantId: string, customerId: string, since: Date): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND c.entity_type = 'customer' AND c.entity_id = $2
            AND m.sender_role = 'customer' AND m.source = 'sms' AND m.created_at > $3
          LIMIT 1`,
        [tenantId, customerId, since],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }
}
