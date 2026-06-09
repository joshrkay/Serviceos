import { z } from 'zod';
import type { Appointment, Job } from '@rivet/contracts';
import { CommandError, defineCommand } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';

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
