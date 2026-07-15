import { describe, expect, it } from 'vitest';
import type { AuthedFetch } from './me';
import {
  listTechnicianAppointments,
  postEnRoute,
  postLocationBatch,
  postRunningLate,
  type TechnicianLocationBatchInput,
} from './technicianField';

function recordingClient(response: Response): {
  client: AuthedFetch;
  calls: Array<{ input: string; init?: RequestInit }>;
} {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  return {
    calls,
    client: async (input, init) => {
      calls.push({ input, init });
      return response.clone();
    },
  };
}

describe('technician field API', () => {
  it('lists a technician day using the tenant-local date', async () => {
    const response = {
      appointments: [],
      total: 0,
    };
    const { client, calls } = recordingClient(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    await expect(
      listTechnicianAppointments(
        client,
        '059f1a36-2d09-4698-954f-e640d61a9237',
        '2026-07-15',
      ),
    ).resolves.toEqual(response);
    expect(calls[0]?.input).toBe(
      '/api/dispatch/technician/059f1a36-2d09-4698-954f-e640d61a9237/appointments?date=2026-07-15',
    );
  });

  it('posts en-route to the dispatch action endpoint', async () => {
    const result = { accepted: true, notified: true, idempotencyKey: 'notice-1' };
    const { client, calls } = recordingClient(
      new Response(JSON.stringify(result), { status: 202 }),
    );

    await expect(postEnRoute(client, 'appointment-1')).resolves.toEqual(result);
    expect(calls[0]?.input).toBe('/api/dispatch/appointments/appointment-1/en-route');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  });

  it('posts a running-late notice with a default of 20 minutes', async () => {
    const result = { appointmentId: 'appointment-1', delayMinutes: 20, queued: true };
    const { client, calls } = recordingClient(
      new Response(JSON.stringify(result), { status: 200 }),
    );

    await expect(postRunningLate(client, 'appointment-1')).resolves.toEqual(result);
    expect(calls[0]?.input).toBe('/api/appointments/appointment-1/running-late');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ delayMinutes: 20 });
  });

  it('preserves each stable clientPingId when a location batch is resubmitted', async () => {
    const clientPingId = '04b0afcd-bd09-4e9d-a671-b44d57dd617b';
    const input: TechnicianLocationBatchInput = {
      technicianId: '059f1a36-2d09-4698-954f-e640d61a9237',
      pings: [
        {
          clientPingId,
          lat: 37.775,
          lng: -122.419,
          accuracyMeters: 8,
          recordedAt: '2026-07-15T16:00:00.000Z',
          source: 'mobile_foreground',
        },
      ],
    };
    const { client, calls } = recordingClient(
      new Response(JSON.stringify({ count: 1, pings: [] }), { status: 201 }),
    );

    await postLocationBatch(client, input);
    await postLocationBatch(client, input);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(String(call.init?.body)) as TechnicianLocationBatchInput;
      expect(body.pings[0]?.clientPingId).toBe(clientPingId);
    }
  });

  it('throws a named error when a technician action fails', async () => {
    const { client } = recordingClient(
      new Response(JSON.stringify({ message: 'Not assigned' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    );

    await expect(postEnRoute(client, 'appointment-1')).rejects.toThrow(
      /postEnRoute: 403 Forbidden — Not assigned/,
    );
  });
});
