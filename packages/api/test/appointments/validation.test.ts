import { validateAppointmentTimes, validateAppointmentUpdateInput } from '../../src/appointments/validation';

describe('P1-007A — Appointment validation rules', () => {
  const now = new Date();
  const future = (hoursFromNow: number) => new Date(now.getTime() + hoursFromNow * 60 * 60 * 1000);
  const past = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);

  it('happy path — valid appointment passes all checks', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
      arrivalWindowStart: future(23),
      arrivalWindowEnd: future(25),
    });

    expect(result.errors).toHaveLength(0);
  });

  it('happy path — appointment without arrival window is valid', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
    });

    expect(result.errors).toHaveLength(0);
  });

  it('validation — rejects scheduledStart >= scheduledEnd', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(26),
      scheduledEnd: future(24),
    });

    expect(result.errors).toContain('scheduledStart must be before scheduledEnd');
  });

  it('validation — rejects duration exceeding 24 hours', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(1),
      scheduledEnd: future(26),
    });

    expect(result.errors).toContain('Appointment duration cannot exceed 24 hours');
  });

  it('validation — rejects partial arrival window (start only)', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
      arrivalWindowStart: future(23),
    });

    expect(result.errors).toContain('Both arrivalWindowStart and arrivalWindowEnd must be provided together');
  });

  it('validation — rejects partial arrival window (end only)', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
      arrivalWindowEnd: future(25),
    });

    expect(result.errors).toContain('Both arrivalWindowStart and arrivalWindowEnd must be provided together');
  });

  it('validation — rejects arrivalWindowStart >= arrivalWindowEnd', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
      arrivalWindowStart: future(25),
      arrivalWindowEnd: future(23),
    });

    expect(result.errors).toContain('arrivalWindowStart must be before arrivalWindowEnd');
  });

  it('validation — rejects arrivalWindowStart after scheduledStart', () => {
    const result = validateAppointmentTimes({
      scheduledStart: future(24),
      scheduledEnd: future(26),
      arrivalWindowStart: future(25),
      arrivalWindowEnd: future(27),
    });

    expect(result.errors).toContain('arrivalWindowStart must be at or before scheduledStart');
  });

  it('validation — warns on past scheduling', () => {
    const result = validateAppointmentTimes({
      scheduledStart: past(2),
      scheduledEnd: past(1),
    });

    expect(result.warnings).toContain('Appointment is scheduled in the past');
    // Past scheduling is a warning, not an error
    expect(result.errors).toHaveLength(0);
  });

  it('validation — update merges existing fields and validates cross-field rules', () => {
    const result = validateAppointmentUpdateInput(
      {
        id: 'apt-1',
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: future(24),
        scheduledEnd: future(26),
        timezone: 'UTC',
        status: 'scheduled',
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { scheduledEnd: future(23) }
    );

    expect(result.errors).toContain('scheduledStart must be before scheduledEnd');
  });

  it('validation — update partial fields can remain valid when merged', () => {
    const result = validateAppointmentUpdateInput(
      {
        id: 'apt-1',
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: future(24),
        scheduledEnd: future(26),
        timezone: 'UTC',
        status: 'scheduled',
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { notes: 'Customer asked for text updates' }
    );

    expect(result.errors).toHaveLength(0);
  });
});
