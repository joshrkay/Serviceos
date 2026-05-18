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

describe('P7-026 runGoogleReviewsSweep', () => {
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
      proposalsEmitted: 0,
      proposalEmissionFailed: 0,
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
      proposalsEmitted: 0,
      proposalEmissionFailed: 0,
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
    // Retry-After=30s equals the exponential base of 30s — GREATEST
    // picks either; the resulting backoff is the same.
    expect(state?.backoffUntil?.getTime()).toBe(
      NOW.getTime() + REVIEW_BACKOFF_BASE_MS,
    );
  });

  it('honors a long Retry-After (600s) over the small exponential base', async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response('quota exceeded', {
        status: 429,
        headers: { 'Retry-After': '600' },
      });

    await runGoogleReviewsSweep({
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

    const state = await pollStateRepo.getPollState('t1');
    // Header asks for 600s; exponential at count=1 is only 30s. The
    // worker must honor the longer wait Google requested.
    expect(state?.backoffUntil?.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + 600_000,
    );
  });

  it('continues to next tenant when a response fails schema validation (GoogleBusinessApiError)', async () => {
    const fetchFn = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('locations/L1')) {
        // Malformed: starRating is an unexpected enum value Google
        // never sends. The Zod schema must reject it.
        return jsonResponse({
          reviews: [
            {
              name: 'accounts/A/locations/L1/reviews/r1',
              starRating: 'SIX_STARS',
              createTime: '2026-05-17T10:00:00Z',
              updateTime: '2026-05-17T10:00:00Z',
            },
          ],
        });
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

    // t1 fails on the schema; t2 succeeds. Critically: t1 must NOT be
    // counted as throttled (GoogleBusinessApiError is distinct from
    // GoogleBusinessQuotaError) and the loop must continue.
    expect(result.tenants).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.throttled).toBe(0);
    expect(result.persisted).toBe(1);
    // And the failed tenant's poll-state must NOT have a backoff
    // (which would have been the bug if we'd treated it as quota).
    const t1State = await pollStateRepo.getPollState('t1');
    expect(t1State?.backoffUntil ?? null).toBeNull();
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

// ─── P7-026 ingestion → proposal bridge ───────────────────────────────────
//
// Verifies the final-wiring gap: a newly-inserted review must create a
// draft `review_response_proposal`, and the bridge must be failure-soft
// (a single bad review never breaks the per-tenant loop).
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { BuildReviewResponseProposalDeps } from '../../src/reputation/build-proposal';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { NoopBrandVoiceLoader } from '../../src/reputation/brand-voice';
import type {
  CustomerCandidate,
  CustomerLoader,
} from '../../src/reputation/match-customer';
import type { ServiceCreditRepository } from '../../src/reputation/service-credit';

class StubCustomerLoader implements CustomerLoader {
  async findRecentCustomersWithName(): Promise<CustomerCandidate[]> {
    return [];
  }
}

class StubServiceCreditRepo
  implements Pick<ServiceCreditRepository, 'sumIssuedInLast12Months' | 'create'>
{
  async sumIssuedInLast12Months(): Promise<number> {
    return 0;
  }
  async create(): Promise<never> {
    throw new Error('not used in the bridge tests');
  }
}

function stubLLMGateway(): LLMGateway {
  // The proposal-emission path here matches every reviewer to nobody
  // (the StubCustomerLoader returns []), so the only LLM call that
  // fires is the praise-classifier fallback for ambiguous reviews —
  // and the regex layer handles "Great" (the test review body) at
  // confidence 1.0 without invoking the LLM. We still provide a
  // throwing gateway so any accidental LLM call surfaces as a clear
  // test failure rather than a hang.
  return {
    async complete() {
      throw new Error('LLM gateway should not be called in this test');
    },
  } as unknown as LLMGateway;
}

function makeEmissionDeps(): {
  proposalRepo: InMemoryProposalRepository;
  buildProposalDeps: BuildReviewResponseProposalDeps;
} {
  return {
    proposalRepo: new InMemoryProposalRepository(),
    buildProposalDeps: {
      llmGateway: stubLLMGateway(),
      customerLoader: new StubCustomerLoader(),
      brandVoiceLoader: new NoopBrandVoiceLoader(),
      serviceCreditRepo: new StubServiceCreditRepo(),
      // Inject a deterministic public-response composer so the test
      // doesn't depend on prompt drift in the production composer.
      draftPublic: async () => 'Thanks for the review!',
    },
  };
}

describe('P7-026 runGoogleReviewsSweep — ingestion → proposal bridge', () => {
  let reviewRepo: InMemoryReviewRepository;
  let pollStateRepo: InMemoryReviewPollStateRepository;

  beforeEach(() => {
    reviewRepo = new InMemoryReviewRepository();
    pollStateRepo = new InMemoryReviewPollStateRepository(() => NOW);
  });

  it('emits a draft review_response_proposal for each newly-inserted review when emission deps are wired', async () => {
    const emission = makeEmissionDeps();
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({
        reviews: [makeReviewJson('r1', '2026-05-17T10:00:00Z')],
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
      proposalEmission: emission,
    });

    expect(result.persisted).toBe(1);
    expect(result.proposalsEmitted).toBe(1);
    expect(result.proposalEmissionFailed).toBe(0);

    const proposals = await emission.proposalRepo.findByTenant('t1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('review_response_proposal');
    expect(proposals[0].status).toBe('draft');
    expect(proposals[0].targetEntityType).toBe('review');
    expect(proposals[0].idempotencyKey).toMatch(/^review-response:/);
  });

  it('still ingests but skips emission when emission deps are absent', async () => {
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({
        reviews: [makeReviewJson('r1', '2026-05-17T10:00:00Z')],
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
      // No proposalEmission — simulates partial wiring.
    });

    expect(result.persisted).toBe(1);
    expect(result.proposalsEmitted).toBe(0);
    expect(result.proposalEmissionFailed).toBe(0);
  });

  it('catches buildReviewResponseProposal failures, logs them, and continues the loop', async () => {
    const emission = makeEmissionDeps();
    // Force the public-response composer to throw for one review while
    // a second review succeeds. The worker must finish both reviews.
    let calls = 0;
    emission.buildProposalDeps.draftPublic = async () => {
      calls++;
      if (calls === 1) throw new Error('LLM down');
      return 'Thanks!';
    };

    const fetchFn = async (): Promise<Response> =>
      jsonResponse({
        reviews: [
          makeReviewJson('r1', '2026-05-17T11:00:00Z'),
          makeReviewJson('r2', '2026-05-17T10:00:00Z'),
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
      proposalEmission: emission,
    });

    // Both reviews persisted; one emission failed, one succeeded.
    expect(result.persisted).toBe(2);
    expect(result.proposalsEmitted).toBe(1);
    expect(result.proposalEmissionFailed).toBe(1);
    // Worker did NOT mark the tenant as failed — emission failure is
    // logged but separate from the per-tenant failure counter.
    expect(result.failed).toBe(0);

    const proposals = await emission.proposalRepo.findByTenant('t1');
    expect(proposals).toHaveLength(1);
  });

  it('re-running a sweep does not re-emit (idempotent via inserted=false)', async () => {
    const emission = makeEmissionDeps();
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
      proposalEmission: emission,
    };

    const first = await runGoogleReviewsSweep(deps);
    expect(first.proposalsEmitted).toBe(1);

    const second = await runGoogleReviewsSweep(deps);
    // Re-upsert returns inserted=false, so emission is skipped.
    expect(second.proposalsEmitted).toBe(0);

    const proposals = await emission.proposalRepo.findByTenant('t1');
    expect(proposals).toHaveLength(1);
  });
});
