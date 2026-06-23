import { describe, expect, it, vi } from 'vitest';
import { clockTimeEntry } from './jobs';

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
