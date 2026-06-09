import { z } from 'zod';
import type { Appointment, Job, ScheduleEntry } from '@rivet/contracts';
import { CommandError, defineCommand } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';

const SCHEDULE_ENTRY_SQL = `
  SELECT a.id, a.job_id, a.starts_at, a.ends_at, a.status,
         j.title AS job_title, j.status AS job_status,
         c.name AS customer_name, c.phone AS customer_phone
  FROM appointments a
  JOIN jobs j ON j.id = a.job_id
  JOIN customers c ON c.id = j.customer_id`;

interface ScheduleEntryRow {
  id: string;
  job_id: string;
  starts_at: Date;
  ends_at: Date;
  status: ScheduleEntry['status'];
  job_title: string;
  job_status: ScheduleEntry['jobStatus'];
  customer_name: string;
  customer_phone: string;
}

function toScheduleEntry(row: ScheduleEntryRow): ScheduleEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status,
    jobTitle: row.job_title,
    jobStatus: row.job_status,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
  };
}

export const createJobCommand = defineCommand({
  name: 'money.create_job',
  input: z.object({
    customerId: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  }),
  async run(ctx, input): Promise<Job> {
    const customer = await ctx.client.query(
      `SELECT id FROM customers WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.customerId],
    );
    if (!customer.rows[0]) throw new CommandError('not_found', 'customer not found');
    const { rows } = await ctx.client.query(
      `INSERT INTO jobs (tenant_id, customer_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, customer_id, title, description, status, created_at`,
      [ctx.tenantId, input.customerId, input.title, input.description ?? null],
    );
    const row = rows[0]!;
    ctx.emit({
      eventType: 'job.created',
      entityType: 'job',
      entityId: row.id,
      payload: { title: input.title, customerId: input.customerId },
    });
    return {
      id: row.id,
      customerId: row.customer_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    };
  },
});

export const scheduleAppointmentCommand = defineCommand({
  name: 'money.schedule_appointment',
  input: z.object({
    jobId: z.string().uuid(),
    startsAt: z.string().datetime(),
    durationMinutes: z.number().int().min(15).max(720),
  }),
  async run(ctx, input): Promise<Appointment> {
    const job = await ctx.client.query(
      `SELECT id, status FROM jobs WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.jobId],
    );
    if (!job.rows[0]) throw new CommandError('not_found', 'job not found');
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
    const { rows } = await ctx.client.query(
      `INSERT INTO appointments (tenant_id, job_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, job_id, starts_at, ends_at, status`,
      [ctx.tenantId, input.jobId, startsAt, endsAt],
    );
    await ctx.client.query(
      `UPDATE jobs SET status = 'scheduled', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'unscheduled'`,
      [ctx.tenantId, input.jobId],
    );
    const row = rows[0]!;
    ctx.emit({
      eventType: 'appointment.scheduled',
      entityType: 'appointment',
      entityId: row.id,
      payload: { jobId: input.jobId, startsAt: input.startsAt, durationMinutes: input.durationMinutes },
    });
    return {
      id: row.id,
      jobId: row.job_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status,
    };
  },
});

/**
 * Dispatch action for a 1-truck shop: the visit happened. Marks the
 * appointment completed and the job done, which is what makes the job
 * invoiceable in the time-to-cash flow.
 */
export const completeAppointmentCommand = defineCommand({
  name: 'money.complete_appointment',
  input: z.object({ appointmentId: z.string().uuid() }),
  async run(ctx, input): Promise<ScheduleEntry> {
    const updated = await ctx.client.query<{ job_id: string }>(
      `UPDATE appointments SET status = 'completed'
       WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'
       RETURNING job_id`,
      [ctx.tenantId, input.appointmentId],
    );
    if (!updated.rows[0]) {
      const exists = await ctx.client.query(
        `SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, input.appointmentId],
      );
      if (!exists.rows[0]) throw new CommandError('not_found', 'appointment not found');
      throw new CommandError('conflict', `appointment is ${exists.rows[0].status}, only scheduled visits can be completed`);
    }
    const jobId = updated.rows[0].job_id;
    const jobDone = await ctx.client.query(
      `UPDATE jobs SET status = 'done', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status IN ('scheduled', 'in_progress')
         AND NOT EXISTS (
           SELECT 1 FROM appointments
           WHERE tenant_id = $1 AND job_id = $2 AND status = 'scheduled'
         )
       RETURNING id`,
      [ctx.tenantId, jobId],
    );
    ctx.emit({
      eventType: 'appointment.completed',
      entityType: 'appointment',
      entityId: input.appointmentId,
      payload: { jobId },
    });
    if (jobDone.rows[0]) {
      ctx.emit({ eventType: 'job.completed', entityType: 'job', entityId: jobId });
    }
    const { rows } = await ctx.client.query<ScheduleEntryRow>(
      `${SCHEDULE_ENTRY_SQL} WHERE a.tenant_id = $1 AND a.id = $2`,
      [ctx.tenantId, input.appointmentId],
    );
    return toScheduleEntry(rows[0]!);
  },
});

export async function listSchedule(
  db: Db,
  tenantId: string,
  from?: string,
): Promise<ScheduleEntry[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query<ScheduleEntryRow>(
      `${SCHEDULE_ENTRY_SQL}
       WHERE a.tenant_id = $1 AND a.starts_at >= COALESCE($2::timestamptz, now() - interval '1 day')
       ORDER BY a.starts_at
       LIMIT 200`,
      [tenantId, from ?? null],
    );
    return rows.map(toScheduleEntry);
  });
}

export async function listJobs(
  db: Db,
  tenantId: string,
): Promise<Array<Job & { customerName: string }>> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT j.id, j.customer_id, j.title, j.description, j.status, j.created_at,
              c.name AS customer_name
       FROM jobs j JOIN customers c ON c.id = j.customer_id
       WHERE j.tenant_id = $1
       ORDER BY j.created_at DESC
       LIMIT 200`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      customerName: row.customer_name,
    }));
  });
}
