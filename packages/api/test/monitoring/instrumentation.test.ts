import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { instrument } from '../../src/monitoring/instrumentation';
import {
  setSentryClient,
  resetSentryClient,
  SentryClient,
  SentryTransaction,
} from '../../src/monitoring/sentry';

function makeFakeClient(): SentryClient & {
  calls: { tags: Array<[string, string]>; captured: unknown[] };
} {
  const calls = { tags: [] as Array<[string, string]>, captured: [] as unknown[] };
  return {
    calls,
    captureException(err: Error, _context?: Record<string, unknown>): string {
      calls.captured.push(err);
      return 'fake-event-id';
    },
    captureMessage(_msg: string, _level?: 'info' | 'warning' | 'error'): string {
      return 'fake-event-id';
    },
    setTag(key: string, value: string): void {
      calls.tags.push([key, value]);
    },
    setUser(): void {},
    startTransaction(_name: string): SentryTransaction {
      return { finish() {}, setStatus() {} };
    },
  };
}

describe('instrument()', () => {
  let client: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    client = makeFakeClient();
    setSentryClient(client);
  });

  afterEach(() => {
    resetSentryClient();
  });

  it('passes through return value when handler succeeds', async () => {
    const wrapped = instrument(async (x: number) => x * 2, { path: 'test' });
    await expect(wrapped(21)).resolves.toBe(42);
    expect(client.calls.captured).toHaveLength(0);
    expect(client.calls.tags).toHaveLength(0);
  });

  it('tags the path and captures the exception, then rethrows', async () => {
    const err = new Error('boom');
    const wrapped = instrument(async () => {
      throw err;
    }, { path: 'stripe-webhook' });

    await expect(wrapped()).rejects.toBe(err);
    expect(client.calls.tags).toEqual([['path', 'stripe-webhook']]);
    expect(client.calls.captured).toEqual([err]);
  });

  it('tags tenant_id and correlation_id when extractor provided', async () => {
    const wrapped = instrument(
      async (_input: { tenantId: string; correlationId: string }) => {
        throw new Error('x');
      },
      {
        path: 'execution-worker',
        extractTags: (input) => ({
          tenant_id: input.tenantId,
          correlation_id: input.correlationId,
        }),
      },
    );

    await expect(wrapped({ tenantId: 't-1', correlationId: 'c-1' })).rejects.toThrow();
    expect(client.calls.tags).toEqual(
      expect.arrayContaining([
        ['path', 'execution-worker'],
        ['tenant_id', 't-1'],
        ['correlation_id', 'c-1'],
      ]),
    );
  });

  it('skips undefined tag values returned by extractor', async () => {
    const wrapped = instrument(
      async (_input: { tenantId?: string }) => {
        throw new Error('x');
      },
      {
        path: 'voice',
        extractTags: (input) => ({
          tenant_id: input.tenantId,
        }),
      },
    );

    await expect(wrapped({})).rejects.toThrow();
    // Only `path` tagged; tenant_id should NOT have been set with `undefined`.
    expect(client.calls.tags).toEqual([['path', 'voice']]);
  });

  it('uses the no-op client when no client has been set', async () => {
    resetSentryClient(); // Ensure the registry is empty.
    const wrapped = instrument(async () => {
      throw new Error('silent');
    }, { path: 'no-sentry' });

    // Must still rethrow the error; the no-op client just does nothing.
    await expect(wrapped()).rejects.toThrow('silent');
  });
});
