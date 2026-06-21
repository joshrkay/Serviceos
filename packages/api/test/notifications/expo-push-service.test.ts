import { describe, it, expect, vi } from 'vitest';
import { ExpoPushDeliveryProvider, EXPO_PUSH_SEND_URL } from '../../src/notifications/expo-push-service';
import type { PushMessage } from '../../src/notifications/push-delivery-provider';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const msg = (to: string): PushMessage => ({ to, title: 'Approval needed', body: 'Invoice Acme', data: { kind: 'needs_approval' } });

describe('ExpoPushDeliveryProvider', () => {
  it('posts to the Expo send endpoint and maps ok tickets to ticket ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ data: [{ status: 'ok', id: 'tk_1' }, { status: 'ok', id: 'tk_2' }] }));
    const provider = new ExpoPushDeliveryProvider(fetchMock as unknown as typeof fetch);

    const results = await provider.sendPush([msg('ExponentPushToken[a]'), msg('ExponentPushToken[b]')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_SEND_URL);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent[0]).toEqual({ to: 'ExponentPushToken[a]', title: 'Approval needed', body: 'Invoice Acme', data: { kind: 'needs_approval' } });
    expect(results.map((r) => [r.ok, r.ticketId])).toEqual([
      [true, 'tk_1'],
      [true, 'tk_2'],
    ]);
  });

  it('flags DeviceNotRegistered tickets for pruning', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
    );
    const provider = new ExpoPushDeliveryProvider(fetchMock as unknown as typeof fetch);
    const [r] = await provider.sendPush([msg('ExponentPushToken[dead]')]);
    expect(r.ok).toBe(false);
    expect(r.deviceNotRegistered).toBe(true);
  });

  it('chunks at 100 messages per request', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const count = JSON.parse(init.body as string).length;
      return Promise.resolve(okJson({ data: Array.from({ length: count }, (_, i) => ({ status: 'ok', id: `t${i}` })) }));
    });
    const provider = new ExpoPushDeliveryProvider(fetchMock as unknown as typeof fetch);
    const results = await provider.sendPush(Array.from({ length: 150 }, (_, i) => msg(`ExponentPushToken[${i}]`)));
    expect(fetchMock).toHaveBeenCalledTimes(2); // 100 + 50
    expect(results).toHaveLength(150);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('returns errors (not throws) on a non-ok response or a network failure', async () => {
    const non200 = new ExpoPushDeliveryProvider(
      vi.fn().mockResolvedValue(new Response('nope', { status: 502 })) as unknown as typeof fetch,
    );
    const [a] = await non200.sendPush([msg('ExponentPushToken[a]')]);
    expect(a.ok).toBe(false);
    expect(a.error).toContain('502');

    const threw = new ExpoPushDeliveryProvider(
      vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch,
    );
    const [b] = await threw.sendPush([msg('ExponentPushToken[b]')]);
    expect(b.ok).toBe(false);
    expect(b.deviceNotRegistered).toBe(false);
  });
});
