import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db';
import { createCustomerCommand } from '../../src/modules/crm/customers';
import {
  completeAppointmentCommand,
  createJobCommand,
  listSchedule,
  scheduleAppointmentCommand,
} from '../../src/modules/money/jobs';
import { createProposalCommand, makeApproveProposalCommand, claimProposalForExecutionCommand, completeProposalCommand } from '../../src/modules/proposals/engine';
import { executeProposalPayloadCommand } from '../../src/modules/proposals/handlers';
import { createTestDb, createTestTenant, waitFor, type TestDb } from './helpers';

describe('scheduling and dispatch flow', () => {
  let env: TestDb;
  let tenantId: string;
  let scope: { tenantId: string; actor: { type: 'user'; id: string } };
  let systemScope: { tenantId: string; actor: { type: 'system'; id: string } };
  let customerId: string;

  beforeAll(async () => {
    env = await createTestDb();
    const t = await createTestTenant(env.db);
    tenantId = t.tenantId;
    scope = { tenantId, actor: { type: 'user', id: t.ownerUserId } };
    systemScope = { tenantId, actor: { type: 'system', id: 'executor' } };
    const customer = await env.bus.execute(createCustomerCommand, scope, {
      name: 'Sched Customer',
      phone: '+15554000',
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await env.destroy();
  });

  it('manual dispatch: create job -> schedule -> visible in schedule view -> complete -> job done', async () => {
    const job = await env.bus.execute(createJobCommand, scope, {
      customerId,
      title: 'Water heater swap',
    });
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const appointment = await env.bus.execute(scheduleAppointmentCommand, scope, {
      jobId: job.id,
      startsAt,
      durationMinutes: 120,
    });

    const schedule = await listSchedule(env.db, tenantId);
    const entry = schedule.find((e) => e.id === appointment.id);
    expect(entry).toMatchObject({
      jobTitle: 'Water heater swap',
      jobStatus: 'scheduled',
      customerName: 'Sched Customer',
      status: 'scheduled',
    });

    const completed = await env.bus.execute(completeAppointmentCommand, scope, {
      appointmentId: appointment.id,
    });
    expect(completed.status).toBe('completed');
    expect(completed.jobStatus).toBe('done');

    // Completing twice is refused (guarded transition).
    await expect(
      env.bus.execute(completeAppointmentCommand, scope, { appointmentId: appointment.id }),
    ).rejects.toThrow(/only scheduled/);

    const events = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(
        `SELECT event_type FROM events WHERE tenant_id = $1 AND entity_id IN ($2, $3) ORDER BY id`,
        [tenantId, appointment.id, job.id],
      ),
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain('appointment.scheduled');
    expect(types).toContain('appointment.completed');
    expect(types).toContain('job.completed');
  });

  it('job stays open while it still has other scheduled visits', async () => {
    const job = await env.bus.execute(createJobCommand, scope, {
      customerId,
      title: 'Two-visit install',
    });
    const first = await env.bus.execute(scheduleAppointmentCommand, scope, {
      jobId: job.id,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      durationMinutes: 60,
    });
    await env.bus.execute(scheduleAppointmentCommand, scope, {
      jobId: job.id,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationMinutes: 60,
    });

    const afterFirst = await env.bus.execute(completeAppointmentCommand, scope, {
      appointmentId: first.id,
    });
    expect(afterFirst.jobStatus).toBe('scheduled'); // second visit still pending

    const jobRow = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query('SELECT status FROM jobs WHERE id = $1', [job.id]),
    );
    expect(jobRow.rows[0].status).toBe('scheduled');
  });

  it('never double-books: a conflicting AI booking slides to the next free slot and confirms the customer', async () => {
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    startsAt.setUTCMinutes(0, 0, 0);
    const bookTwice = async (phone: string) =>
      env.bus.execute(executeProposalPayloadCommand, systemScope, {
        type: 'schedule_job',
        payload: {
          customerName: `Caller ${phone}`,
          customerPhone: phone,
          title: 'Same-slot request',
          startsAt: startsAt.toISOString(),
          durationMinutes: 60,
        },
      });

    const first = await bookTwice('+15554201');
    const second = await bookTwice('+15554202');

    expect(first.adjustedForConflict).toBe(false);
    expect(first.scheduledFor).toBe(startsAt.toISOString());
    // Second request for the identical slot slides to the end of the first.
    expect(second.adjustedForConflict).toBe(true);
    expect(second.scheduledFor).toBe(new Date(startsAt.getTime() + 3_600_000).toISOString());

    // Both customers get a booking-confirmation side effect, atomically.
    const outbox = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(
        `SELECT dedupe_key FROM outbox WHERE tenant_id = $1 AND topic = 'comms.booking-confirmation'`,
        [tenantId],
      ),
    );
    const keys = outbox.rows.map((row) => row.dedupe_key);
    expect(keys).toContain(`booking-confirmation:${first.appointmentId}`);
    expect(keys).toContain(`booking-confirmation:${second.appointmentId}`);
  });

  it('AI dispatch path: approved schedule_job proposal lands on the schedule view', async () => {
    const approve = makeApproveProposalCommand(0);
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const proposal = await env.bus.execute(
      createProposalCommand,
      { tenantId, actor: { type: 'ai', id: 'test-ai' } },
      {
        type: 'schedule_job',
        source: 'voice',
        payload: {
          customerName: 'New Caller',
          customerPhone: '+15554111',
          title: 'No-heat emergency',
          startsAt,
          durationMinutes: 90,
        },
        summary: 'Book New Caller for no-heat emergency',
      },
    );
    await env.bus.execute(approve, scope, { proposalId: proposal.id });
    const claimed = await waitFor(() =>
      env.bus.execute(claimProposalForExecutionCommand, systemScope, { proposalId: proposal.id }),
    );
    const result = await env.bus.execute(executeProposalPayloadCommand, systemScope, {
      type: claimed.type,
      payload: claimed.payload,
    });
    await env.bus.execute(completeProposalCommand, systemScope, { proposalId: proposal.id, result });

    const schedule = await listSchedule(env.db, tenantId);
    const entry = schedule.find((e) => e.id === result.appointmentId);
    expect(entry).toMatchObject({
      jobTitle: 'No-heat emergency',
      customerName: 'New Caller',
      customerPhone: '+15554111',
      status: 'scheduled',
      jobStatus: 'scheduled',
    });
    expect(new Date(entry!.endsAt).getTime() - new Date(entry!.startsAt).getTime()).toBe(90 * 60_000);
  });
});
