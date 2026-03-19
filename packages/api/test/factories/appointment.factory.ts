import { faker } from './faker';
import { Appointment, AppointmentStatus, CreateAppointmentInput } from '../../src/appointments/appointment';

export function buildAppointment(overrides?: Partial<Appointment>): Appointment {
  const start = faker.date.future();
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // 2 hours later

  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    scheduledStart: start,
    scheduledEnd: end,
    arrivalWindowStart: start,
    arrivalWindowEnd: new Date(start.getTime() + 30 * 60 * 1000),
    timezone: 'America/New_York',
    status: 'scheduled' as AppointmentStatus,
    notes: faker.lorem.sentence(),
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateAppointmentInput(overrides?: Partial<CreateAppointmentInput>): CreateAppointmentInput {
  const start = faker.date.future();
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return {
    tenantId: faker.string.uuid(),
    jobId: faker.string.uuid(),
    scheduledStart: start,
    scheduledEnd: end,
    timezone: 'America/New_York',
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
