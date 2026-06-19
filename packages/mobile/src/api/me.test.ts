import { describe, expect, it, vi } from 'vitest';
import { fetchMe, postModeSwitch } from './me';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchMe', () => {
  it('GETs /api/me and returns the parsed body', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({ user_id: 'u1', tenant_id: 't1', role: 'owner', current_mode: 'supervisor' }),
    );

    const me = await fetchMe(client);

    expect(client).toHaveBeenCalledWith('/api/me');
    expect(me.user_id).toBe('u1');
    expect(me.current_mode).toBe('supervisor');
  });

  it('throws on a non-ok response', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }));

    await expect(fetchMe(client)).rejects.toThrow(/fetchMe: 500/);
  });
});

describe('postModeSwitch', () => {
  it('POSTs the mode and resolves on 204', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(postModeSwitch(client, 'tech')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/me/mode');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'tech' });
  });

  it('throws with the server message when the switch is rejected', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'no field serve' }, 403));

    await expect(postModeSwitch(client, 'tech')).rejects.toThrow(/no field serve/);
  });
});
