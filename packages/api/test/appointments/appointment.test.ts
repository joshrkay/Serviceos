import {
  createAppointment,
  getAppointment,
  updateAppointment,
  listByJob,
  listByDateRange,
  validateAppointmentInput,
  InMemoryAppointmentRepository,
} from '../../src/appointments/appointment';

describe('P1-007 — Appointment entity with schedule + arrival window', () => {
  let repo: InMemoryAppointmentRepository;

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(tomorrow.getTime() + 2 * 60 * 60 * 1000);
  const arrivalStart = new Date(tomorrow.getTime() - 60 * 60 * 1000);
  const arrivalEnd = new Date(tomorrow.getTime() + 60 * 60 * 1000);

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
  });

  it('happy path — creates appointment and retrieves it', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        arrivalWindowStart: arrivalStart,
        arrivalWindowEnd: arrivalEnd,
        timezone: 'America/New_York',
        notes: 'Customer prefers morning',
        createdBy: 'user-1',
      },
      repo
    );

    expect(apt.id).toBeTruthy();
    expect(apt.status).toBe('scheduled');
    expect(apt.timezone).toBe('America/New_York');

    const found = await getAppointment('tenant-1', apt.id, repo);
    expect(found).not.toBeNull();
    expect(found!.notes).toBe('Customer prefers morning');
  });

  it('normalizes all persisted time fields as UTC instants regardless of timezone metadata', async () => {
    const scheduledStartIso = '2025-03-15T09:30:00-04:00';
    const scheduledEndIso = '2025-03-15T11:00:00-04:00';
    const arrivalStartIso = '2025-03-15T09:00:00-04:00';
    const arrivalEndIso = '2025-03-15T10:00:00-04:00';

    const nyAppointment = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-utc-1',
        scheduledStart: new Date(scheduledStartIso),
        scheduledEnd: new Date(scheduledEndIso),
        arrivalWindowStart: new Date(arrivalStartIso),
        arrivalWindowEnd: new Date(arrivalEndIso),
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      repo
    );

    const utcAppointment = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-utc-2',
        scheduledStart: new Date(scheduledStartIso),
        scheduledEnd: new Date(scheduledEndIso),
        arrivalWindowStart: new Date(arrivalStartIso),
        arrivalWindowEnd: new Date(arrivalEndIso),
        timezone: 'UTC',
        createdBy: 'user-1',
      },
      repo
    );

    expect(nyAppointment.scheduledStart.toISOString()).toBe('2025-03-15T13:30:00.000Z');
    expect(nyAppointment.scheduledEnd.toISOString()).toBe('2025-03-15T15:00:00.000Z');
    expect(nyAppointment.arrivalWindowStart?.toISOString()).toBe('2025-03-15T13:00:00.000Z');
    expect(nyAppointment.arrivalWindowEnd?.toISOString()).toBe('2025-03-15T14:00:00.000Z');

    expect(utcAppointment.scheduledStart.toISOString()).toBe(nyAppointment.scheduledStart.toISOString());
    expect(utcAppointment.scheduledEnd.toISOString()).toBe(nyAppointment.scheduledEnd.toISOString());
    expect(utcAppointment.arrivalWindowStart?.toISOString()).toBe(nyAppointment.arrivalWindowStart?.toISOString());
    expect(utcAppointment.arrivalWindowEnd?.toISOString()).toBe(nyAppointment.arrivalWindowEnd?.toISOString());
  });

  it('normalizes updated time fields as UTC instants', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      repo
    );

    const updated = await updateAppointment(
      'tenant-1',
      apt.id,
      {
        scheduledStart: new Date('2025-01-10T07:00:00-08:00'),
        scheduledEnd: new Date('2025-01-10T09:00:00-08:00'),
        arrivalWindowStart: new Date('2025-01-10T06:30:00-08:00'),
        arrivalWindowEnd: new Date('2025-01-10T07:30:00-08:00'),
        timezone: 'America/Los_Angeles',
      },
      repo
    );

    expect(updated!.scheduledStart.toISOString()).toBe('2025-01-10T15:00:00.000Z');
    expect(updated!.scheduledEnd.toISOString()).toBe('2025-01-10T17:00:00.000Z');
    expect(updated!.arrivalWindowStart?.toISOString()).toBe('2025-01-10T14:30:00.000Z');
    expect(updated!.arrivalWindowEnd?.toISOString()).toBe('2025-01-10T15:30:00.000Z');
  });

  it('happy path — updates appointment', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      repo
    );

    const updated = await updateAppointment(
      'tenant-1',
      apt.id,
      { status: 'confirmed', notes: 'Confirmed by customer' },
      repo
    );

    expect(updated!.status).toBe('confirmed');
    expect(updated!.notes).toBe('Confirmed by customer');
  });

  it('validation — rejects invalid appointment update before write', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      repo
    );

    await expect(
      updateAppointment(
        'tenant-1',
        apt.id,
        { arrivalWindowStart: new Date(tomorrow.getTime() + 60 * 60 * 1000) },
        repo
      )
    ).rejects.toThrow('Validation failed: Both arrivalWindowStart and arrivalWindowEnd must be provided together');

    const unchanged = await getAppointment('tenant-1', apt.id, repo);
    expect(unchanged!.arrivalWindowStart).toBeUndefined();
    expect(unchanged!.arrivalWindowEnd).toBeUndefined();
  });

  it('validation — valid partial appointment update continues to work', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        timezone: 'America/New_York',
        createdBy: 'user-1',
      },
      repo
    );

    const updated = await updateAppointment('tenant-1', apt.id, { notes: 'Bring ladder' }, repo);
    expect(updated!.notes).toBe('Bring ladder');
    expect(updated!.scheduledStart).toEqual(tomorrow);
    expect(updated!.scheduledEnd).toEqual(tomorrowEnd);
  });

  it('happy path — lists appointments by job', async () => {
    await createAppointment(
      { tenantId: 'tenant-1', jobId: 'job-1', scheduledStart: tomorrow, scheduledEnd: tomorrowEnd, timezone: 'UTC', createdBy: 'u-1' },
      repo
    );
    await createAppointment(
      { tenantId: 'tenant-1', jobId: 'job-2', scheduledStart: tomorrow, scheduledEnd: tomorrowEnd, timezone: 'UTC', createdBy: 'u-1' },
      repo
    );

    const job1Apts = await listByJob('tenant-1', 'job-1', repo);
    expect(job1Apts).toHaveLength(1);
  });

  it('happy path — lists appointments by date range', async () => {
    await createAppointment(
      { tenantId: 'tenant-1', jobId: 'job-1', scheduledStart: tomorrow, scheduledEnd: tomorrowEnd, timezone: 'UTC', createdBy: 'u-1' },
      repo
    );

    const rangeStart = new Date(tomorrow.getTime() - 12 * 60 * 60 * 1000);
    const rangeEnd = new Date(tomorrow.getTime() + 12 * 60 * 60 * 1000);
    const results = await listByDateRange('tenant-1', rangeStart, rangeEnd, repo);
    expect(results).toHaveLength(1);
  });


  it('validation — create rejects scheduledStart >= scheduledEnd', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrowEnd,
          scheduledEnd: tomorrow,
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: scheduledStart must be before scheduledEnd');
  });

  it('validation — create rejects partial arrival window', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: tomorrowEnd,
          arrivalWindowStart: arrivalStart,
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: Both arrivalWindowStart and arrivalWindowEnd must be provided together');
  });

  it('validation — create rejects arrival window start after scheduled start', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: tomorrowEnd,
          arrivalWindowStart: new Date(tomorrow.getTime() + 30 * 60 * 1000),
          arrivalWindowEnd: new Date(tomorrow.getTime() + 90 * 60 * 1000),
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: arrivalWindowStart must be at or before scheduledStart');
  });

  it('validation — create rejects duration greater than 24h', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: new Date(tomorrow.getTime() + 25 * 60 * 60 * 1000),
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: Appointment duration cannot exceed 24 hours');
  });

  it('validation — update validates merged schedule values', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        timezone: 'UTC',
        createdBy: 'u-1',
      },
      repo
    );

    await expect(
      updateAppointment(
        'tenant-1',
        apt.id,
        {
          scheduledStart: new Date(tomorrowEnd.getTime() + 60 * 1000),
        },
        repo
      )
    ).rejects.toThrow('Validation failed: scheduledStart must be before scheduledEnd');
  });

  it('validation — create allows writes when only warnings are present', async () => {
    const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const pastEnd = new Date(Date.now() - 60 * 60 * 1000);

    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: pastStart,
        scheduledEnd: pastEnd,
        timezone: 'UTC',
        createdBy: 'u-1',
      },
      repo
    );

    expect(apt.id).toBeTruthy();
    const found = await getAppointment('tenant-1', apt.id, repo);
    expect(found).not.toBeNull();
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateAppointmentInput({
      tenantId: '',
      jobId: '',
      scheduledStart: null as any,
      scheduledEnd: null as any,
      timezone: '',
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('jobId is required');
    expect(errors).toContain('scheduledStart is required');
    expect(errors).toContain('scheduledEnd is required');
    expect(errors).toContain('timezone is required');
    expect(errors).toContain('createdBy is required');
  });

  it('validation — rejects invalid timezone values', () => {
    const errors = validateAppointmentInput({
      tenantId: 'tenant-1',
      jobId: 'job-1',
      scheduledStart: tomorrow,
      scheduledEnd: tomorrowEnd,
      timezone: 'Mars/Phobos',
      createdBy: 'user-1',
    });

    expect(errors).toContain('Invalid timezone');
  });

  it('validation — rejects invalid timezone values on update', async () => {
    const apt = await createAppointment(
      { tenantId: 'tenant-1', jobId: 'job-1', scheduledStart: tomorrow, scheduledEnd: tomorrowEnd, timezone: 'UTC', createdBy: 'u-1' },
      repo
    );

    await expect(
      updateAppointment('tenant-1', apt.id, { timezone: 'Mars/Phobos' }, repo)
    ).rejects.toThrow('Validation failed: Invalid timezone');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const apt = await createAppointment(
      { tenantId: 'tenant-1', jobId: 'job-1', scheduledStart: tomorrow, scheduledEnd: tomorrowEnd, timezone: 'UTC', createdBy: 'u-1' },
      repo
    );

    const found = await getAppointment('tenant-2', apt.id, repo);
    expect(found).toBeNull();
  });

  it('validation — create rejects scheduledStart >= scheduledEnd', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrowEnd,
          scheduledEnd: tomorrow,
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('scheduledStart must be before scheduledEnd');
  });

  it('validation — create rejects only one arrival window boundary provided', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: tomorrowEnd,
          arrivalWindowStart: arrivalStart,
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Both arrivalWindowStart and arrivalWindowEnd must be provided together');
  });

  it('validation — create rejects arrivalWindowStart after scheduledStart', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: tomorrowEnd,
          arrivalWindowStart: new Date(tomorrow.getTime() + 30 * 60 * 1000),
          arrivalWindowEnd: new Date(tomorrow.getTime() + 90 * 60 * 1000),
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('arrivalWindowStart must be at or before scheduledStart');
  });

  it('validation — create rejects max duration > 24h', async () => {
    await expect(
      createAppointment(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          scheduledStart: tomorrow,
          scheduledEnd: new Date(tomorrow.getTime() + 25 * 60 * 60 * 1000),
          timezone: 'UTC',
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Appointment duration cannot exceed 24 hours');
  });

  it('validation — update uses merged schedule and rejects invalid arrival window', async () => {
    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: tomorrow,
        scheduledEnd: tomorrowEnd,
        arrivalWindowStart: arrivalStart,
        arrivalWindowEnd: arrivalEnd,
        timezone: 'UTC',
        createdBy: 'u-1',
      },
      repo
    );

    await expect(
      updateAppointment(
        'tenant-1',
        apt.id,
        {
          arrivalWindowStart: new Date(tomorrow.getTime() + 10 * 60 * 1000),
        },
        repo
      )
    ).rejects.toThrow('arrivalWindowStart must be at or before scheduledStart');
  });

  it('validation — warnings are emitted through optional metadata channel', async () => {
    const warnings: string[] = [];

    const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const pastEnd = new Date(Date.now() - 1 * 60 * 60 * 1000);

    const apt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: pastStart,
        scheduledEnd: pastEnd,
        timezone: 'UTC',
        createdBy: 'u-1',
      },
      repo,
      {
        onValidationWarnings: (incomingWarnings) => warnings.push(...incomingWarnings),
      }
    );

    expect(apt.id).toBeTruthy();
    expect(warnings).toContain('Appointment is scheduled in the past');
  });
});
