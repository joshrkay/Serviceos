/**
 * D-044 / #1763 — GET /api/get-found-online derives the checklist from the
 * real repos the Google Business flow writes; POST /dismiss hides it only
 * when every item is done.
 */
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetFoundOnlineRouter } from '../../src/routes/get-found-online';
import { InMemoryGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import { InMemoryReviewPollStateRepository } from '../../src/reputation/poll-state';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryGetFoundOnlineDismissalRepository } from '../../src/onboarding/get-found-online-dismissal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-gfo-1';
const REVIEW = 'https://g.page/r/review-999';

describe('/api/get-found-online', () => {
  let originalKey: string | undefined;
  let integrationRepo: InMemoryGoogleBusinessIntegrationRepository;
  let pollStateRepo: InMemoryReviewPollStateRepository;
  let settingsRepo: InMemorySettingsRepository;
  let dismissalRepo: InMemoryGetFoundOnlineDismissalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    integrationRepo = new InMemoryGoogleBusinessIntegrationRepository();
    pollStateRepo = new InMemoryReviewPollStateRepository();
    settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.upsertIdentityFields(TENANT, { businessName: 'Acme' });
    dismissalRepo = new InMemoryGetFoundOnlineDismissalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function app(role: NonNullable<AuthenticatedRequest['auth']>['role'] = 'owner') {
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT, role };
      next();
    });
    a.use(
      '/api/get-found-online',
      createGetFoundOnlineRouter({ integrationRepo, pollStateRepo, settingsRepo, dismissalRepo, auditRepo }),
    );
    return a;
  }

  async function connectListing() {
    await integrationRepo.upsert({
      tenantId: TENANT,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      selection: {
        accountId: '123',
        locationId: '999',
        placeId: 'ChIJ',
        reviewUrl: REVIEW,
        locationTitle: 'Acme',
      },
      locationCount: 1,
    });
    await settingsRepo.update(TENANT, { googleReviewUrl: REVIEW });
  }

  it('a fresh tenant sees both items open', async () => {
    const res = await request(app()).get('/api/get-found-online');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        { id: 'google_listing', status: 'current', reason: 'not_connected' },
        { id: 'review_link', status: 'pending', reason: 'missing' },
      ],
      allDone: false,
      visible: true,
    });
  });

  it('reads the connected listing, the review link and a poll paused by rejected credentials', async () => {
    await connectListing();
    expect((await request(app()).get('/api/get-found-online')).body.data.allDone).toBe(true);

    // Google throttling clears on its own: no "reconnect" error.
    await pollStateRepo.recordQuotaError(TENANT, 3600);
    expect((await request(app()).get('/api/get-found-online')).body.data.allDone).toBe(true);

    // A backoff recorded before the reason existed may be either: no error.
    const untagged = await pollStateRepo.getPollState(TENANT);
    vi.spyOn(pollStateRepo, 'getPollState').mockResolvedValueOnce({ ...untagged!, backoffReason: null });
    expect((await request(app()).get('/api/get-found-online')).body.data.allDone).toBe(true);

    // Rejected credentials need the owner.
    await pollStateRepo.recordQuotaError(TENANT, 3600, 'auth');
    const paused = await request(app()).get('/api/get-found-online');
    expect(paused.body.data.items[0]).toEqual({
      id: 'google_listing',
      status: 'error',
      reason: 'polling_paused',
    });
  });

  it('dismiss is refused while an item is open', async () => {
    const res = await request(app()).post('/api/get-found-online/dismiss');
    expect(res.status).toBe(400);
    expect(await dismissalRepo.getDismissedAt(TENANT)).toBeNull();
  });

  it('dismiss hides a finished checklist, audits, and a disconnect brings it back', async () => {
    await connectListing();
    const res = await request(app()).post('/api/get-found-online/dismiss');
    expect(res.status).toBe(200);
    expect(res.body.data.visible).toBe(false);
    expect((await request(app()).get('/api/get-found-online')).body.data.visible).toBe(false);
    const events = await auditRepo.findByEntity(TENANT, 'tenant_settings', TENANT);
    expect(events.map((e) => e.eventType)).toEqual(['get_found_online.dismissed']);

    await integrationRepo.disconnect(TENANT);
    const reopened = (await request(app()).get('/api/get-found-online')).body.data;
    expect(reopened.visible).toBe(true);
    expect(reopened.items[0].status).toBe('current');
  });

  it('is owner-only: a technician gets 403 on both endpoints', async () => {
    expect((await request(app('technician')).get('/api/get-found-online')).status).toBe(403);
    expect((await request(app('technician')).post('/api/get-found-online/dismiss')).status).toBe(403);
  });
});
