import { describe, expect, it, vi } from 'vitest';
import { clockTimeEntry, createJob, transitionJob } from './jobs';

describe('createJob', () => {
  it('POSTs /api/jobs with the input body', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'job-1' }), { status: 201 }),
    );

    const result = await createJob(client, {
      customerId: 'c1',
      locationId: 'loc-1',
      summary: 'Replace filter',
    });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/jobs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 'c1',
      locationId: 'loc-1',
      summary: 'Replace filter',
    });
    expect(result.id).toBe('job-1');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

    await expect(
      createJob(client, { customerId: 'c1', locationId: 'loc-1', summary: 'Fix AC' }),
    ).rejects.toThrow(/createJob: 400/);
  });
});

describe('transitionJob', () => {
  it('POSTs /api/jobs/:id/transition with the target status', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(transitionJob(client, 'job-1', 'completed')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/jobs/job-1/transition');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'completed' });
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(transitionJob(client, 'missing', 'completed')).rejects.toThrow(
      /transitionJob: 404/,
    );
  });
});

describe('clockTimeEntry', () => {
  it('POSTs clock-in with jobId and entryType job', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await expect(clockTimeEntry(client, 'job-uuid', 'clock_in')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/time-entries/clock-in');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ jobId: 'job-uuid', entryType: 'job' });
  });

  it('POSTs clock-out with an empty body', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(clockTimeEntry(client, 'job-uuid', 'clock_out')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/time-entries/clock-out');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws on a non-ok response', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));

    await expect(clockTimeEntry(client, 'job-uuid', 'clock_out')).rejects.toThrow(
      /clockTimeEntry: 404/,
    );
  });
});
