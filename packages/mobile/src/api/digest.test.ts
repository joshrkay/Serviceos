import { describe, expect, it, vi } from 'vitest';
import { fetchDigest, formatDigestPayloadSummary, type DigestPayload } from './digest';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const basePayload: DigestPayload = {
  date: '2026-06-10',
  timezone: 'America/New_York',
  revenueCents: 125_00,
  grossRevenueCents: 130_00,
  refundsCents: 5_00,
  paymentsCount: 3,
  jobsCompletedCount: 2,
  tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
  pendingApprovals: { totalCount: 2, top: [] },
  overdueInvoicesCount: 4,
  unbilledJobs: [],
};

describe('fetchDigest', () => {
  it('GETs /api/digests/latest and returns the parsed body', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          date: '2026-06-10',
          payload: basePayload,
          narrative: 'A solid day.',
          generatedAt: '2026-06-10T22:00:00.000Z',
        },
      }),
    );

    const result = await fetchDigest(client, 'latest');

    expect(client).toHaveBeenCalledWith('/api/digests/latest');
    expect(result.date).toBe('2026-06-10');
    expect(result.narrative).toBe('A solid day.');
    expect(result.payload.revenueCents).toBe(125_00);
  });

  it('GETs /api/digests/:date for an explicit calendar date', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          date: '2026-06-10',
          payload: basePayload,
          narrative: null,
          generatedAt: '2026-06-10T22:00:00.000Z',
        },
      }),
    );

    const result = await fetchDigest(client, '2026-06-10');

    expect(client).toHaveBeenCalledWith('/api/digests/2026-06-10');
    expect(result.narrative).toBeNull();
  });

  it('encodes the date param in the path', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          date: '2026/a',
          payload: basePayload,
          narrative: null,
          generatedAt: '2026-06-10T22:00:00.000Z',
        },
      }),
    );

    await fetchDigest(client, '2026/a');

    expect(client).toHaveBeenCalledWith('/api/digests/2026%2Fa');
  });

  it('throws with the server message on 404', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'NOT_FOUND', message: 'No digest for this day' }, 404),
    );

    await expect(fetchDigest(client, '2026-06-10')).rejects.toThrow('No digest for this day');
  });

  it('throws on a non-ok response without a structured body', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }));

    await expect(fetchDigest(client, 'latest')).rejects.toThrow(/Something went wrong/);
  });
});

describe('formatDigestPayloadSummary', () => {
  it('includes formatted revenue and the payload field count', () => {
    const summary = formatDigestPayloadSummary(basePayload, (cents) => `$${(cents / 100).toFixed(2)}`);
    expect(summary).toContain('$125.00 revenue');
    expect(summary).toContain(`${Object.keys(basePayload).length} payload fields`);
  });
});
