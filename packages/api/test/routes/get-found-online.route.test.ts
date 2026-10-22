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
import { InMemoryCallForwardingRepository } from '../../src/onboarding/call-forwarding';
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
  let forwardingRepo: InMemoryCallForwardingRepository;
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
    forwardingRepo = new InMemoryCallForwardingRepository();
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
      createGetFoundOnlineRouter({
        integrationRepo,
        pollStateRepo,
        settingsRepo,
        dismissalRepo,
        forwardingRepo,
        getRivetNumber: async () => '+15125550123',
        auditRepo,
      }),
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
    await forwardingRepo.save(TENANT, { carrier: 'att', mode: 'all' });
    await forwardingRepo.recordCheckPassed(TENANT, new Date('2026-10-20T15:00:00Z'));
  }

  it('a fresh tenant sees every item open', async () => {
    const res = await request(app()).get('/api/get-found-online');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        { id: 'google_listing', status: 'current', reason: 'not_connected' },
        { id: 'review_link', status: 'pending', reason: 'missing' },
        { id: 'call_forwarding', status: 'pending', reason: 'not_set_up' },
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
    await pollStateRepo.recordAuthFailure(TENANT, 3600, (await pollStateRepo.getPollState(TENANT))?.authGeneration ?? 0);
    const paused = await request(app()).get('/api/get-found-online');
    expect(paused.body.data.items[0]).toEqual({
      id: 'google_listing',
      status: 'error',
      reason: 'polling_paused',
    });
  });

  it('#1764: waiting on Google until a location appears, then a pick, then done', async () => {
    await integrationRepo.upsert({
      tenantId: TENANT,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      locationCount: 0,
    });
    const item = async () => (await request(app()).get('/api/get-found-online')).body.data.items[0];
    expect(await item()).toEqual({ id: 'google_listing', status: 'waiting', reason: 'no_location' });

    // The re-check lists locations again and records the count.
    await integrationRepo.recordLocationCount(TENANT, 2);
    expect(await item()).toEqual({ id: 'google_listing', status: 'current', reason: 'needs_pick' });

    await integrationRepo.selectLocation(TENANT, {
      accountId: '123',
      locationId: '999',
      placeId: 'ChIJ',
      reviewUrl: REVIEW,
      locationTitle: 'Acme',
    });
    expect(await item()).toEqual({ id: 'google_listing', status: 'done' });
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

  it('saves carrier and mode (default missed), audits, and a change reopens a passed check', async () => {
    await connectListing();
    expect((await request(app()).get('/api/get-found-online')).body.data.allDone).toBe(true);

    const res = await request(app()).put('/api/get-found-online/forwarding').send({ carrier: 'verizon' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      carrier: 'verizon',
      mode: 'missed',
      checkPassedAt: null,
      rivetNumber: '+15125550123',
    });
    const reopened = (await request(app()).get('/api/get-found-online')).body.data;
    expect(reopened.allDone).toBe(false);
    expect(reopened.items[2]).toEqual({ id: 'call_forwarding', status: 'current', reason: 'not_checked' });

    const events = await auditRepo.findByEntity(TENANT, 'tenant_settings', TENANT);
    expect(events.map((e) => e.eventType)).toEqual(['call_forwarding.configured']);
    expect(events[0].metadata).toMatchObject({
      carrier: 'verizon',
      mode: 'missed',
      previousCarrier: 'att',
      previousMode: 'all',
      reopenedCheck: true,
    });
    expect((await request(app()).get('/api/get-found-online/forwarding')).body.data.carrier).toBe('verizon');
  });

  it('re-saving the same choice keeps a passed check', async () => {
    await connectListing();
    await request(app()).put('/api/get-found-online/forwarding').send({ carrier: 'att', mode: 'all' });
    expect((await request(app()).get('/api/get-found-online')).body.data.allDone).toBe(true);
  });

  it('rejects an unknown carrier or mode', async () => {
    const bad = await request(app()).put('/api/get-found-online/forwarding').send({ carrier: 'sprint' });
    expect(bad.status).toBe(400);
    const badMode = await request(app())
      .put('/api/get-found-online/forwarding')
      .send({ carrier: 'att', mode: 'sometimes' });
    expect(badMode.status).toBe(400);
    expect(await forwardingRepo.get(TENANT)).toBeNull();
  });

  it('is owner-only: a technician gets 403 on every endpoint', async () => {
    expect((await request(app('technician')).get('/api/get-found-online')).status).toBe(403);
    expect((await request(app('technician')).post('/api/get-found-online/dismiss')).status).toBe(403);
    expect((await request(app('technician')).get('/api/get-found-online/forwarding')).status).toBe(403);
    expect(
      (await request(app('technician')).put('/api/get-found-online/forwarding').send({ carrier: 'att' })).status,
    ).toBe(403);
  });
});
