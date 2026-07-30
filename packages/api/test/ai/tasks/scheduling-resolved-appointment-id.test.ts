/**
 * Found-by-proof regression (rivet-voice-19 item 9) — the scheduling tasks
 * must consume the appointment id the router's entity resolver already
 * verified.
 *
 * Before this fix, RescheduleAppointmentTaskHandler and
 * CancelAppointmentTaskHandler ignored `existingEntities.appointmentId` and
 * re-resolved from scratch via the caller's single-active-appointment lookup.
 * That lookup returns undefined the moment a tenant has two active
 * appointments — so "Move the Garcia job to Thursday at 10" gated as
 * unresolvable in every real shop with more than one job on the books, even
 * though the router had already disambiguated the reference.
 *
 * The multi-appointment fixture below is the whole point: it is the case that
 * used to fail.
 */
import { describe, it, expect } from 'vitest';
import {
  RescheduleAppointmentTaskHandler,
  CancelAppointmentTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import {
  InMemoryAppointmentRepository,
  Appointment,
} from '../../../src/appointments/appointment';

const GARCIA_APPT = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_APPT = 'bbbbbbbb-5555-4666-8777-888888888888';
const TENANT = 't-1';

function appointment(id: string, startsInDays: number): Appointment {
  const start = new Date(Date.now() + startsInDays * 24 * 60 * 60 * 1000);
  return {
    id,
    tenantId: TENANT,
    jobId: `job-for-${id}`,
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
    status: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Appointment;
}

/** A tenant with TWO active appointments — an ordinary shop, and the case
 *  the single-active-appointment fallback cannot answer. */
async function busyTenantRepo(): Promise<InMemoryAppointmentRepository> {
  const repo = new InMemoryAppointmentRepository();
  await repo.create(appointment(GARCIA_APPT, 3));
  await repo.create(appointment(OTHER_APPT, 5));
  return repo;
}

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT,
    userId: 'u-1',
    message: 'Move the Garcia job to Thursday at 10',
    timezone: 'America/Chicago',
    now: new Date('2026-07-29T15:00:00.000Z'),
    ...overrides,
  };
}

describe('scheduling tasks consume the resolver-verified appointmentId', () => {
  it('reschedule uses the resolved id even when the tenant has several active appointments', async () => {
    const repo = await busyTenantRepo();
    const { proposal } = await new RescheduleAppointmentTaskHandler(
      undefined,
      repo,
      undefined,
    ).handle(
      ctx({
        existingEntities: {
          appointmentId: GARCIA_APPT,
          appointmentReference: 'the Garcia job',
          newDateTimeDescription: 'Thursday at 10',
        },
      }),
    );

    expect(proposal.payload.appointmentId).toBe(GARCIA_APPT);
    expect(missingFieldsFor(proposal)).not.toContain('appointmentId');
  });

  it('cancel uses the resolved id even when the tenant has several active appointments', async () => {
    const repo = await busyTenantRepo();
    const { proposal } = await new CancelAppointmentTaskHandler(repo, undefined).handle(
      ctx({
        message: "Cancel Tuesday's Garcia appointment",
        existingEntities: {
          appointmentId: GARCIA_APPT,
          appointmentReference: "Tuesday's Garcia appointment",
        },
      }),
    );

    expect(proposal.payload.appointmentId).toBe(GARCIA_APPT);
    expect(missingFieldsFor(proposal)).not.toContain('appointmentId');
  });

  it('still gates when the resolver could not answer and the tenant is busy', async () => {
    const repo = await busyTenantRepo();
    const { proposal } = await new CancelAppointmentTaskHandler(repo, undefined).handle(
      ctx({
        message: 'Cancel that appointment',
        existingEntities: { appointmentReference: 'that appointment' },
      }),
    );

    expect(proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('appointmentId');
  });

  it('keeps the single-active-appointment fallback for an unresolved reference (SCH-03)', async () => {
    const repo = new InMemoryAppointmentRepository();
    await repo.create(appointment(GARCIA_APPT, 3));

    const { proposal } = await new CancelAppointmentTaskHandler(repo, undefined).handle(
      ctx({
        message: 'Cancel the upcoming appointment',
        existingEntities: { appointmentReference: 'the upcoming appointment' },
      }),
    );

    expect(proposal.payload.appointmentId).toBe(GARCIA_APPT);
  });

  it('ignores a non-UUID appointmentId rather than trusting it', async () => {
    const repo = await busyTenantRepo();
    const { proposal } = await new CancelAppointmentTaskHandler(repo, undefined).handle(
      ctx({
        existingEntities: {
          appointmentId: 'the Garcia job',
          appointmentReference: 'the Garcia job',
        },
      }),
    );

    expect(proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('appointmentId');
  });
});
