import { describe, expect, it, vi } from 'vitest';
// Pin the CLIENT proposal payloads against the REAL server Zod schemas (not a
// hand-written expectation) so a dropped/renamed field fails the build instead
// of shipping a silent 400 — see
// docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md
// (The createAppointment body is pinned api-side in
// packages/api/test/routes/mobile-appointment-booking-contract.test.ts, because
// shared/contracts.ts transitively type-imports auth/clerk and can't be pulled
// into the mobile tsc program — the four scheduling contracts below are
// zod-only leaves and import cleanly.)
import { rescheduleAppointmentPayloadSchema } from '../../../api/src/proposals/contracts/reschedule';
import { reassignAppointmentPayloadSchema } from '../../../api/src/proposals/contracts/reassignment';
import {
  addCrewMemberPayloadSchema,
  removeCrewMemberPayloadSchema,
} from '../../../api/src/proposals/contracts/crew';
import {
  addCrewMember,
  cancelAppointment,
  confirmAppointment,
  createAppointment,
  createReassignProposal,
  createRescheduleProposal,
  fetchAvailability,
  removeCrewMember,
} from './appointments';

const APPT = '11111111-1111-1111-1111-111111111111';
const TECH = '22222222-2222-2222-2222-222222222222';
const VERSION = '2026-06-22T10:00:00.000Z';

function jsonClient(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('fetchAvailability', () => {
  it('GETs /api/dispatch/availability with from/to/durationMin/technicianId', async () => {
    const client = jsonClient({ timezone: 'UTC', durationMin: 90, slots: [] });
    const res = await fetchAvailability(client, {
      from: '2026-06-20',
      to: '2026-07-04',
      durationMin: 90,
      technicianId: TECH,
    });
    const [path] = client.mock.calls[0] as [string];
    expect(path).toContain('/api/dispatch/availability?');
    expect(path).toContain('from=2026-06-20');
    expect(path).toContain('to=2026-07-04');
    expect(path).toContain('durationMin=90');
    expect(path).toContain(`technicianId=${TECH}`);
    expect(res.timezone).toBe('UTC');
  });

  it('throws a decoded AppError on a non-ok response', async () => {
    const client = jsonClient({ error: 'VALIDATION_ERROR', message: 'bad range' }, 400);
    await expect(fetchAvailability(client, { from: 'x', to: 'y' })).rejects.toMatchObject({
      kind: 'validation',
      message: 'bad range',
    });
  });
});

describe('createAppointment (B1)', () => {
  it('POSTs /api/appointments with a body the real createAppointmentSchema accepts', async () => {
    const client = jsonClient({ id: 'appt-1' }, 201);
    const result = await createAppointment(client, {
      jobId: 'job-1',
      scheduledStart: '2026-06-22T13:00:00.000Z',
      scheduledEnd: '2026-06-22T14:00:00.000Z',
      timezone: 'America/New_York',
      notes: 'Front door',
    });
    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/appointments');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    // The full-shape acceptance is pinned api-side against the real schema; here
    // we assert the wire fields the schema requires are present and correct.
    expect(body).toMatchObject({
      jobId: 'job-1',
      scheduledStart: '2026-06-22T13:00:00.000Z',
      scheduledEnd: '2026-06-22T14:00:00.000Z',
      timezone: 'America/New_York',
      notes: 'Front door',
    });
    expect(result.id).toBe('appt-1');
  });
});

describe('confirm/cancel (B4/B3)', () => {
  it('confirmAppointment PUTs status=confirmed', async () => {
    const client = jsonClient({ id: APPT, status: 'confirmed' });
    await confirmAppointment(client, APPT);
    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/appointments/${APPT}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'confirmed' });
  });

  it('cancelAppointment PUTs status=canceled', async () => {
    const client = jsonClient({ id: APPT, status: 'canceled' });
    await cancelAppointment(client, APPT);
    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ status: 'canceled' });
  });

  it('surfaces the server error when an illegal transition 400s', async () => {
    const client = jsonClient({ error: 'VALIDATION_ERROR', message: 'Invalid transition' }, 400);
    await expect(cancelAppointment(client, APPT)).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('createRescheduleProposal (B2)', () => {
  it('POSTs /api/proposals with an If-Match header and a schema-valid payload', async () => {
    const client = jsonClient({ id: 'prop-1' });
    await createRescheduleProposal(client, {
      appointmentId: APPT,
      newScheduledStart: '2026-06-25T13:00:00.000Z',
      newScheduledEnd: '2026-06-25T14:00:00.000Z',
      appointmentVersion: VERSION,
    });
    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/proposals');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['If-Match']).toBe(VERSION);
    const body = JSON.parse(init.body as string);
    expect(body.proposalType).toBe('reschedule_appointment');
    expect(body.appointmentVersion).toBe(VERSION);
    expect(() => rescheduleAppointmentPayloadSchema.parse(body.payload)).not.toThrow();
  });

  it('surfaces a 409 stale-appointment rejection', async () => {
    const client = jsonClient({ error: 'CONFLICT', message: 'stale' }, 409);
    await expect(
      createRescheduleProposal(client, {
        appointmentId: APPT,
        newScheduledStart: '2026-06-25T13:00:00.000Z',
        newScheduledEnd: '2026-06-25T14:00:00.000Z',
        appointmentVersion: VERSION,
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('reassign / crew mints (B5)', () => {
  it('createReassignProposal payload matches the real reassign schema', async () => {
    const client = jsonClient({ id: 'prop-2' });
    await createReassignProposal(client, {
      appointmentId: APPT,
      toTechnicianId: TECH,
      appointmentVersion: VERSION,
    });
    const [, init] = client.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(() => reassignAppointmentPayloadSchema.parse(body.payload)).not.toThrow();
  });

  it('addCrewMember payload matches the real add-crew schema', async () => {
    const client = jsonClient({ id: 'prop-3' });
    await addCrewMember(client, { appointmentId: APPT, technicianId: TECH, appointmentVersion: VERSION });
    const [, init] = client.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.proposalType).toBe('add_crew_member');
    expect(() => addCrewMemberPayloadSchema.parse(body.payload)).not.toThrow();
  });

  it('removeCrewMember payload matches the real remove-crew schema', async () => {
    const client = jsonClient({ id: 'prop-4' });
    await removeCrewMember(client, { appointmentId: APPT, technicianId: TECH, appointmentVersion: VERSION });
    const [, init] = client.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.proposalType).toBe('remove_crew_member');
    expect(() => removeCrewMemberPayloadSchema.parse(body.payload)).not.toThrow();
  });

  it('surfaces a 422 infeasible rejection', async () => {
    const client = jsonClient({ error: 'VALIDATION_ERROR', message: 'infeasible' }, 422);
    await expect(
      createReassignProposal(client, { appointmentId: APPT, toTechnicianId: TECH, appointmentVersion: VERSION }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});
