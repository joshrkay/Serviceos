/**
 * Review of #1677, M1 — the Google Business client's 10 s default only helps
 * if the production call sites reach it. They passed the bare global `fetch`
 * explicitly, so these tests go through the REAL call sites as production
 * composes them (no fetch injected): the OAuth callback route, the poll
 * worker, the shared refresh-on-401 helper and the reply resolver. A Google
 * endpoint that never answers must end in each site's existing failure.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleBusinessOAuthCallbackRouter } from '../../src/routes/googlebusiness-integrations';
import {
  InMemoryGoogleBusinessIntegrationRepository,
  callWithGoogleBusinessAuthRetry,
} from '../../src/reputation/google-business-integration';
import { GoogleBusinessAuthError } from '../../src/reputation/google-business-client';
import { PgGoogleBusinessReplyResolver } from '../../src/reputation/pg-google-business-reply-resolver';
import { InMemoryOAuthStateRepository } from '../../src/integrations/calendar-integration';
import { InMemoryReviewPollStateRepository } from '../../src/reputation/poll-state';
import { InMemoryReviewRepository } from '../../src/reputation/review';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { createLogger } from '../../src/logging/logger';
import type { CredentialRow } from '../../src/integrations/credentials';
import { hangingFetch, settleWithin, settleWithinIo, useProviderClock } from '../helpers/hanging-fetch';

const TENANT = 'tenant-gbp-bounds';
const CONFIG = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://api.example.com/cb' };
const credentials = (creds: Record<string, unknown>) => ({
  async getCredential(): Promise<CredentialRow> {
    return { tenant_id: TENANT, provider: 'google_business', credentials: creds, credential_version: 1 };
  },
  async close() {},
});

describe('Google Business call sites — bounded at 10 s as production composes them', () => {
  let originalKey: string | undefined;
  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });
  beforeEach(() => {
    useProviderClock();
    vi.stubGlobal('fetch', hangingFetch());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('OAuth callback: a token exchange that never answers fails the callback instead of hanging it', async () => {
    const stateRepo = new InMemoryOAuthStateRepository();
    const { id: state } = await stateRepo.create({ tenantId: TENANT, userId: 'u-1', provider: 'google_business' });
    const app = express();
    app.use(
      '/api/googlebusiness-integrations',
      createGoogleBusinessOAuthCallbackRouter({
        integrationRepo: new InMemoryGoogleBusinessIntegrationRepository(),
        stateRepo,
        googleConfig: CONFIG,
        appBaseUrl: 'https://app.example.com',
      }),
    );

    const outcome = await settleWithinIo(
      request(app).get('/api/googlebusiness-integrations/google/callback').query({ code: 'c', state }).then((r) => r),
      12_000,
    );

    expect(outcome.status).toBe('fulfilled');
    expect((outcome as { value: { status: number } }).value.status).toBe(500);
  });

  it('poll worker: a reviews page that never answers counts the tenant as failed and the sweep finishes', async () => {
    const sweep = runGoogleReviewsSweep({
      reviewRepo: new InMemoryReviewRepository(),
      pollStateRepo: new InMemoryReviewPollStateRepository(() => new Date()),
      credentialResolver: credentials({ accessToken: 'at', providerData: { accountId: 'A', locationId: 'L' } }),
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    });

    const outcome = await settleWithin(sweep, 10_000);

    expect(outcome).toMatchObject({ status: 'fulfilled', value: { failed: 1 } });
  });

  it('refresh-on-401: a token refresh that never answers fails like a network failure', async () => {
    const call = callWithGoogleBusinessAuthRetry({
      tenantId: TENANT,
      tokens: { accessToken: 'at-dead', refreshToken: 'rt', expiresAt: null },
      config: CONFIG,
      store: null,
      call: async () => {
        throw new GoogleBusinessAuthError('401');
      },
    });

    const outcome = await settleWithin(call, 10_000);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.name).toBe('TimeoutError');
  });

  it('reply resolver: a token refresh that never answers yields "no context" (the visible failure path)', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    const now = new Date();
    await reviewRepo.upsert({
      id: 'review-1', tenantId: TENANT, externalReviewId: 'accounts/A/locations/L/reviews/r1',
      locationId: 'accounts/A/locations/L', reviewerDisplayName: 'Al', reviewerProfileUrl: null, rating: 5,
      commentText: 'Great', createTime: now, updateTime: now, firstFetchedAt: now, lastFetchedAt: now,
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentials({
        accessToken: 'at-expired',
        refreshToken: 'rt',
        accessTokenExpiresAt: new Date(now.getTime() - 3600_000).toISOString(),
        providerData: { accountId: 'A', locationId: 'L' },
      }),
      'enc-key-unused',
      { googleConfig: CONFIG },
    );

    const outcome = await settleWithin(resolver.resolve(TENANT, 'review-1'), 10_000);

    expect(outcome).toEqual({ status: 'fulfilled', value: null });
  });
});
