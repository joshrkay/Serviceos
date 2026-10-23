/**
 * P2-030 — a shadow comparison is evaluation telemetry. Its save must never
 * fail, delay or roll back the primary call it rides on.
 *
 * `ShadowComparisonGateway.complete` used to `await store.save(result)` after
 * the primary response had already come back, so any save error (the
 * 'system' tenant id failing `withTenant`'s UUID check, a missing table, a
 * dangling ai_run_id) rejected a call that had succeeded. And because the
 * Pg store's `withTenant` reuses the request transaction's client when the
 * tenant matches, a failed INSERT also aborted the caller's whole request
 * transaction. The save now runs detached from the request's tenant context
 * (its own short transaction) and a failure is logged at warn — without the
 * response text — instead of thrown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const warn = vi.fn();
vi.mock('../../../src/logging/logger', async (orig) => {
  const real = await orig<typeof import('../../../src/logging/logger')>();
  return {
    ...real,
    createLogger: (opts: Parameters<typeof real.createLogger>[0]) => {
      const l = real.createLogger(opts);
      return { ...l, warn: (...a: unknown[]) => warn(...a) };
    },
  };
});

import {
  ShadowComparisonGateway,
  type ShadowComparisonResult,
  type ShadowComparisonStore,
} from '../../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../../src/ai/gateway/providers';
import { currentTenantContext, tenantContextStore } from '../../../src/middleware/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRIMARY_TEXT = 'primary answer for jo@example.com';
const SHADOW_TEXT = 'shadow answer for jo@example.com';

class ScriptedStore implements ShadowComparisonStore {
  saved: ShadowComparisonResult[] = [];
  contextAtSave: Array<ReturnType<typeof currentTenantContext>> = [];
  constructor(private readonly behaviour: 'ok' | 'reject' | 'throw' = 'ok') {}

  save(result: ShadowComparisonResult): Promise<ShadowComparisonResult> {
    this.contextAtSave.push(currentTenantContext());
    if (this.behaviour === 'throw') throw new Error('store exploded synchronously');
    if (this.behaviour === 'reject') return Promise.reject(new Error('relation "shadow_comparisons" does not exist'));
    this.saved.push(result);
    return Promise.resolve(result);
  }

  async listForTenant() {
    return { comparisons: [], nextCursor: null };
  }
}

function gatewayWith(store: ShadowComparisonStore): ShadowComparisonGateway {
  const primary = new StubProvider('primary');
  primary.setResponse({ content: PRIMARY_TEXT });
  const shadow = new StubProvider('shadow');
  shadow.setResponse({ content: SHADOW_TEXT });
  return new ShadowComparisonGateway(primary, shadow, store, {
    enabled: true,
    samplingRate: 1,
    shadowProvider: 'shadow',
    sampleFn: () => 0,
  });
}

const request = { taskType: 'draft_estimate', messages: [{ role: 'user' as const, content: 'hello' }], tenantId: TENANT };

/** Let the detached save (and its catch) settle. */
const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => warn.mockClear());

describe('ShadowComparisonGateway — the shadow save is best-effort', () => {
  it.each(['reject', 'throw'] as const)(
    'a store that %ss leaves the primary response intact and logs a warn without the response text',
    async (behaviour) => {
      const store = new ScriptedStore(behaviour);

      const response = await gatewayWith(store).complete(request);
      await settle();

      expect(response.content).toBe(PRIMARY_TEXT);
      expect(response.provider).toBe('primary');
      expect(store.contextAtSave).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toMatch(/shadow comparison save failed/i);
      expect(meta).toMatchObject({ taskType: 'draft_estimate', tenantId: TENANT });
      expect(String(meta.error)).not.toBe('');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(PRIMARY_TEXT);
      expect(logged).not.toContain(SHADOW_TEXT);
      expect(logged).not.toContain('jo@example.com');
    },
  );

  it('a store that succeeds logs nothing and keeps the comparison', async () => {
    const store = new ScriptedStore('ok');
    const gateway = gatewayWith(store);

    await gateway.complete(request);
    await settle();

    expect(store.saved).toHaveLength(1);
    expect(gateway.getComparisonCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('saves outside the request transaction the call was made in', async () => {
    const store = new ScriptedStore('ok');
    const requestClient = { query: vi.fn() } as unknown as PoolClient;

    const response = await tenantContextStore.run({ client: requestClient, tenantId: TENANT }, async () => {
      // Sanity: the call itself is inside the request's tenant context.
      expect(currentTenantContext()?.client).toBe(requestClient);
      return gatewayWith(store).complete(request);
    });
    await settle();

    expect(response.content).toBe(PRIMARY_TEXT);
    expect(store.contextAtSave).toEqual([undefined]);
    expect(requestClient.query).not.toHaveBeenCalled();
  });
});
