import { describe, expect, it, vi } from 'vitest';
import { createAppointment, fetchAvailability } from './appointments';

describe('fetchAvailability', () => {
  it('GETs the public availability endpoint with the date range', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          timezone: 'America/New_York',
          durationMin: 60,
          slots: [{ start: '2026-07-23T18:00:00Z', end: '2026-07-23T19:00:00Z' }],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAvailability(client, 'ten-1', { from: '2026-07-23', to: '2026-08-06' });

    const [path] = client.mock.calls[0] as [string];
    expect(path).toBe('/api/public/booking/ten-1/availability?from=2026-07-23&to=2026-08-06');
    expect(result.timezone).toBe('America/New_York');
    expect(result.slots).toHaveLength(1);
  });

  it('includes durationMin when given', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ timezone: 'UTC', durationMin: 30, slots: [] }), { status: 200 }),
    );

    await fetchAvailability(client, 'ten-1', { from: '2026-07-23', to: '2026-07-24', durationMin: 30 });

    const [path] = client.mock.calls[0] as [string];
    expect(path).toContain('durationMin=30');
  });

  it('surfaces the server message on failure', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Booking page not found' }), { status: 404 }),
    );

    await expect(
      fetchAvailability(client, 'ten-1', { from: '2026-07-23', to: '2026-07-24' }),
    ).rejects.toThrow(/Booking page not found/);
  });
});

describe('createAppointment', () => {
  it('POSTs /api/appointments with the slot instants and timezone', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'appt-1' }), { status: 201 }),
    );

    const result = await createAppointment(client, {
      jobId: 'job-1',
      scheduledStart: '2026-07-23T18:00:00Z',
      scheduledEnd: '2026-07-23T19:00:00Z',
      timezone: 'America/New_York',
    });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/appointments');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      jobId: 'job-1',
      scheduledStart: '2026-07-23T18:00:00Z',
      scheduledEnd: '2026-07-23T19:00:00Z',
      timezone: 'America/New_York',
    });
    expect(result.id).toBe('appt-1');
  });

  it('surfaces the double-booking conflict message', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'CONFLICT', message: 'Schedule conflict: the assigned technician is already booked during this time.' }),
        { status: 409 },
      ),
    );

    await expect(
      createAppointment(client, {
        jobId: 'job-1',
        scheduledStart: '2026-07-23T18:00:00Z',
        scheduledEnd: '2026-07-23T19:00:00Z',
        timezone: 'America/New_York',
      }),
    ).rejects.toThrow(/already booked/);
  });
});
