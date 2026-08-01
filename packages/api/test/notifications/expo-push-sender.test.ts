import { describe, it, expect, vi } from 'vitest';
import { createExpoPushSender } from '../../src/notifications/expo-push-sender';

describe('createExpoPushSender', () => {
  it('POSTs the messages as a JSON array, bounded by an abort signal', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const sender = createExpoPushSender({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoint: 'https://push.test/send',
    });
    await sender.send([
      { to: 'ExponentPushToken[aaa]', title: 'T', body: 'B' },
      { to: 'ExponentPushToken[bbb]', title: 'T', body: 'B' },
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe('https://push.test/send');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(JSON.parse(seen!.init.body as string)).toEqual([
      { to: 'ExponentPushToken[aaa]', title: 'T', body: 'B' },
      { to: 'ExponentPushToken[bbb]', title: 'T', body: 'B' },
    ]);
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not call the network for an empty batch', async () => {
    const fetchImpl = vi.fn();
    const sender = createExpoPushSender({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await sender.send([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when the endpoint rejects the batch', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 }));
    const sender = createExpoPushSender({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      sender.send([{ to: 'ExponentPushToken[aaa]', title: 'T', body: 'B' }]),
    ).resolves.toBeUndefined();
  });

  it('never throws when the network call itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const sender = createExpoPushSender({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      sender.send([{ to: 'ExponentPushToken[aaa]', title: 'T', body: 'B' }]),
    ).resolves.toBeUndefined();
  });

  it('chunks batches larger than Expo’s 100-message limit', async () => {
    const batches: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      batches.push((JSON.parse(init.body as string) as unknown[]).length);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const sender = createExpoPushSender({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await sender.send(
      Array.from({ length: 150 }, (_, i) => ({
        to: `ExponentPushToken[${i}]`,
        title: 'T',
        body: 'B',
      })),
    );

    expect(batches).toEqual([100, 50]);
  });
});
