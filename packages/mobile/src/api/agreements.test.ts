import { describe, expect, it, vi } from 'vitest';
import { cancelAgreement, pauseAgreement, resumeAgreement } from './agreements';

describe('agreement actions', () => {
  it.each([
    ['pause', pauseAgreement],
    ['resume', resumeAgreement],
    ['cancel', cancelAgreement],
  ] as const)('POSTs /api/agreements/:id/%s', async (action, fn) => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await fn(client, 'agr-1');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/agreements/agr-1/${action}`);
    expect(init.method).toBe('POST');
  });

  it('surfaces the server message on failure', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'CONFLICT', message: 'Already cancelled' }), { status: 409 }),
    );

    await expect(cancelAgreement(client, 'agr-1')).rejects.toThrow(/Already cancelled/);
  });
});
