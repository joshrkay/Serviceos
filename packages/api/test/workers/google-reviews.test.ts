import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { InMemoryReviewRepository } from '../../src/reputation/review';
import {
  InMemoryReviewPollStateRepository,
  REVIEW_BACKOFF_BASE_MS,
} from '../../src/reputation/poll-state';
import type {
  CredentialResolver,
  CredentialRow,
} from '../../src/integrations/credentials';

const logger = createLogger({
  service: 'test',
  environment: 'test',
  level: 'error',
});
const NOW = new Date('2026-05-17T12:00:00Z');

interface MockResolverOpts {
  credentials: Record<string, CredentialRow | null>;
}

function makeResolver(opts: MockResolverOpts): CredentialResolver {
  return {
    async getCredential(tenantId, _provider) {
      return opts.credentials[tenantId] ?? null;
    },
    async close() {},
  };
}

function makeCredRow(
  tenantId: string,
  overrides: Partial<CredentialRow> = {},
): CredentialRow {
  return {
    tenant_id: tenantId,
    provider: 'google_business',
    credentials: {
      accessToken: 'at-' + tenantId,
      providerData: { accountId: 'A', locationId: 'L' },
    },
    credential_version: 1,
    ...overrides,
  };
}

function makeReviewJson(id: string, isoTime: string) {
  return {
    name: `accounts/A/locations/L/reviews/${id}`,
    reviewer: { displayName: 'Alice' },
    starRating: 'FIVE' as const,
    comment: 'Great',
    createTime: isoTime,
    updateTime: isoTime,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('runGoogleReviewsSweep', () => {
  let reviewRepo: InMemoryReviewRepository;
  let pollStateRepo: InMemoryReviewPollStateRepository;

  beforeEach(() => {
    reviewRepo = new InMemoryReviewRepository();
    pollStateRepo = new InMemoryReviewPollStateRepository(() => NOW);
  });

  it('no-ops cleanly when enabled=false', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({ credentials: {} }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      enabled: false,
    });
    expect(result).toEqual({
      tenants: 0,
      fetched: 0,
      persisted: 0,
      throttled: 0,
      failed: 0,
    });
  });

  it('no-ops when credentialResolver is null (pool unset)', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: null,
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
    });
    expect(result.tenants).toBe(0);
  });

  it('returns zeros when listTenantIds throws', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({ credentials: {} }),
      listTenantIds: async () => {
        throw new Error('registry down');
      },
      logger,
      now: () => NOW,
    });
    expect(result.tenants).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('silently skips tenants with no google_business integration', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({ credentials: {} }),
      listTenantIds: async () => ['t1', 't2'],
      logger,
      now: () => NOW,
      fetchFn: async () => jsonResponse({ reviews: [] }),
    });
    expect(result).toEqual({
      tenants: 2,
      fetched: 0,
      persisted: 0,
      throttled: 0,
      failed: 0,
    });
  });

  it('persists fetched reviews and updates poll cursor', async () => {
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({
        reviews: [
          makeReviewJson('r1', '2026-05-17T10:00:00Z'),
          makeReviewJson('r2', '2026-05-17T11:00:00Z'),
        ],
      });

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: { t1: makeCredRow('t1') },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn,
    });

    expect(result.tenants).toBe(1);
    expect(result.fetched).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.failed).toBe(0);

    const state = await pollStateRepo.getPollState('t1');
    expect(state?.cursor).toBe('2026-05-17T11:00:00.000Z');
    expect(state?.consecutive429Count).toBe(0);
  });

  it('upsert is idempotent — re-running a sweep persists nothing new', async () => {
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({
        reviews: [makeReviewJson('r1', '2026-05-17T10:00:00Z')],
      });
    const deps = {
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: { t1: makeCredRow('t1') },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn,
    };

    const first = await runGoogleReviewsSweep(deps);
    expect(first.persisted).toBe(1);

    const second = await runGoogleReviewsSweep(deps);
    // The cursor short-circuit means we never even fetch the row a
    // second time; the watermark filter trips on a strictly-less
    // comparison so the equal-time row is re-upserted but persists=0.
    expect(second.persisted).toBe(0);
  });

  it('records a quota error and skips the tenant on 429', async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response('quota exceeded', {
        status: 429,
        headers: { 'Retry-After': '30' },
      });

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: { t1: makeCredRow('t1') },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn,
    });

    expect(result.throttled).toBe(1);
    expect(result.persisted).toBe(0);
    const state = await pollStateRepo.getPollState('t1');
    expect(state?.consecutive429Count).toBe(1);
    expect(state?.backoffUntil?.getTime()).toBe(
      NOW.getTime() + REVIEW_BACKOFF_BASE_MS,
    );
  });

  it('skips throttled tenants entirely', async () => {
    // Pre-throttle t1.
    await pollStateRepo.recordQuotaError('t1');

    let fetchCalled = false;
    const fetchFn = async (): Promise<Response> => {
      fetchCalled = true;
      return jsonResponse({ reviews: [] });
    };

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: { t1: makeCredRow('t1') },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn,
    });

    expect(fetchCalled).toBe(false);
    expect(result.throttled).toBe(1);
    expect(result.fetched).toBe(0);
  });

  it('one tenant failure does not stop the loop', async () => {
    const fetchFn = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      // t1 → 500, t2 → success
      const urlStr = url.toString();
      if (urlStr.includes('locations/L1')) {
        return new Response('boom', { status: 500 });
      }
      return jsonResponse({
        reviews: [makeReviewJson('r1', '2026-05-17T10:00:00Z')],
      });
    };

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: {
          t1: makeCredRow('t1', {
            credentials: {
              accessToken: 'at-t1',
              providerData: { accountId: 'A', locationId: 'L1' },
            },
          }),
          t2: makeCredRow('t2', {
            credentials: {
              accessToken: 'at-t2',
              providerData: { accountId: 'A', locationId: 'L2' },
            },
          }),
        },
      }),
      listTenantIds: async () => ['t1', 't2'],
      logger,
      now: () => NOW,
      fetchFn,
    });

    expect(result.tenants).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.persisted).toBe(1);
  });

  it('paginates via nextPageToken until exhausted', async () => {
    let call = 0;
    const fetchFn = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      call++;
      const urlStr = url.toString();
      if (!urlStr.includes('pageToken')) {
        return jsonResponse({
          reviews: [makeReviewJson('r1', '2026-05-17T10:00:00Z')],
          nextPageToken: 'tok-2',
        });
      }
      return jsonResponse({
        reviews: [makeReviewJson('r2', '2026-05-17T11:00:00Z')],
      });
    };

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: { t1: makeCredRow('t1') },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn,
    });

    expect(call).toBe(2);
    expect(result.persisted).toBe(2);
  });

  it('fails the tenant when access token is missing', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: {
          t1: {
            tenant_id: 't1',
            provider: 'google_business',
            credentials: {
              providerData: { accountId: 'A', locationId: 'L' },
            },
            credential_version: 1,
          },
        },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn: async () => jsonResponse({ reviews: [] }),
    });
    expect(result.failed).toBe(1);
    expect(result.persisted).toBe(0);
  });

  it('fails the tenant when accountId/locationId are missing', async () => {
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: makeResolver({
        credentials: {
          t1: {
            tenant_id: 't1',
            provider: 'google_business',
            credentials: { accessToken: 'at' },
            credential_version: 1,
          },
        },
      }),
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      fetchFn: async () => jsonResponse({ reviews: [] }),
    });
    expect(result.failed).toBe(1);
  });
});
