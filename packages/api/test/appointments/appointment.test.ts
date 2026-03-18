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
