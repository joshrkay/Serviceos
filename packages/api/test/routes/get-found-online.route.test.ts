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
import {
  ForwardingCheckService,
  InMemoryForwardingCheckRepository,
} from '../../src/onboarding/forwarding-check';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
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
  let checkFetch: ReturnType<typeof vi.fn>;
  let checkService: ForwardingCheckService;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

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
    checkFetch = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ sid: 'CA1' }) }));
    checkService = new ForwardingCheckService({
      repo: new InMemoryForwardingCheckRepository(),
      forwardingRepo,
      getBusinessPhone: async () => '(512) 555-0999',
      getCreds: async () => ({
        accountSid: 'ACtest',
        authToken: 'tok',
        messagingServiceSid: null,
        phoneE164: '+15125550123',
        credentialVersion: 1,
      }),
      auditRepo: undefined,
      fetchImpl: checkFetch as unknown as typeof fetch,
    });
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
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
        forwardingCheck: checkService,
        proposalRepo,
        webOrigin: 'https://app.example.com',
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
    await settingsRepo.update(TENANT, { googleReviewUrl: REVIEW, websiteUrl: 'https://joes.sites.example.com' });
    await integrationRepo.recordListingWebsite(TENANT, '999', 'https://joes.sites.example.com');
    await forwardingRepo.save(TENANT, { carrier: 'att', mode: 'all' });
    await forwardingRepo.recordCheckPassed(TENANT, new Date('2026-10-20T15:00:00Z'), '+15125550123');
  }

  it('a fresh tenant sees every item open', async () => {
    const res = await request(app()).get('/api/get-found-online');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        { id: 'google_listing', status: 'current', reason: 'not_connected' },
        { id: 'review_link', status: 'pending', reason: 'missing' },
        { id: 'call_forwarding', status: 'pending', reason: 'not_set_up' },
        { id: 'website', status: 'pending', reason: 'missing' },
        { id: 'google_website', status: 'pending', reason: 'not_connected' },
      ],
      allDone: false,
      visible: true,
    });
  });

  it('reads the connected listing, the review link, the website and a poll paused by rejected credentials', async () => {
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

  describe('#1771 POST /google-website/draft', () => {
    const draft = () => request(app()).post('/api/get-found-online/google-website/draft');
    const pending = async () => [
      ...(await proposalRepo.findByStatus(TENANT, 'draft')),
      ...(await proposalRepo.findByStatus(TENANT, 'ready_for_review')),
    ].filter((p) => p.proposalType === 'update_google_listing_website');

    async function connectOnly(websiteUrl: string | null) {
      await integrationRepo.upsert({
        tenantId: TENANT,
        accessToken: 'AT',
        refreshToken: 'RT',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        selection: { accountId: '123', locationId: '999', placeId: 'ChIJ', reviewUrl: REVIEW, locationTitle: 'Acme' },
        locationCount: 1,
      });
      if (websiteUrl) await settingsRepo.update(TENANT, { websiteUrl });
    }

    it('drafts a manual-class card with the website and the public booking page, and audits it', async () => {
      await connectOnly('https://joesplumbing.com');
      const res = await draft();
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        websiteUri: 'https://joesplumbing.com',
        bookingUri: `https://app.example.com/book?t=${TENANT}`,
      });
      const [proposal] = await pending();
      expect(proposal).toMatchObject({ status: 'draft', payload: { websiteUri: 'https://joesplumbing.com' } });
      const events = await auditRepo.findByEntity(TENANT, 'google_business_listing', (await integrationRepo.get(TENANT))!.id);
      expect(events.map((e) => e.eventType)).toEqual(['google_listing.website_drafted']);
    });

    it('a new draft replaces the old one', async () => {
      await connectOnly('https://joesplumbing.com');
      await draft();
      await settingsRepo.update(TENANT, { websiteUrl: 'https://joes-new.com' });
      await draft();
      const open = await pending();
      expect(open).toHaveLength(1);
      expect(open[0]!.payload.websiteUri).toBe('https://joes-new.com');
    });

    it('makes no proposal when the listing is not connected', async () => {
      await settingsRepo.update(TENANT, { websiteUrl: 'https://joesplumbing.com' });
      expect((await draft()).status).toBe(400);
      expect(await pending()).toHaveLength(0);
    });

    it('makes no proposal when a location is not chosen yet', async () => {
      await integrationRepo.upsert({
        tenantId: TENANT,
        accessToken: 'AT',
        refreshToken: 'RT',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        locationCount: 2,
      });
      await settingsRepo.update(TENANT, { websiteUrl: 'https://joesplumbing.com' });
      expect((await draft()).status).toBe(400);
      expect(await pending()).toHaveLength(0);
    });

    it('makes no proposal when the website is empty', async () => {
      await connectOnly(null);
      const res = await draft();
      expect(res.status).toBe(400);
      expect(res.body.message ?? res.body.error).toMatch(/website/i);
      expect(await pending()).toHaveLength(0);
    });

    it('a failed approval surfaces Google\'s reason on the checklist item', async () => {
      await connectOnly('https://joesplumbing.com');
      const { body } = await draft();
      const failed = await proposalRepo.findById(TENANT, body.data.proposalId);
      await proposalRepo.updateStatus(TENANT, failed!.id, 'approved');
      await proposalRepo.updateStatus(TENANT, failed!.id, 'executing');
      await proposalRepo.updateStatus(TENANT, failed!.id, 'execution_failed', {
        executionError: 'Google no longer accepts the connection.',
      });
      const item = (await request(app()).get('/api/get-found-online')).body.data.items.find(
        (i: { id: string }) => i.id === 'google_website',
      );
      expect(item).toEqual({
        id: 'google_website',
        status: 'error',
        reason: 'failed',
        failureReason: 'Google no longer accepts the connection.',
      });
    });

    it('is owner-only', async () => {
      await connectOnly('https://joesplumbing.com');
      expect((await request(app('technician')).post('/api/get-found-online/google-website/draft')).status).toBe(403);
      expect(await pending()).toHaveLength(0);
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

  it('POST /forwarding/check places the test call; GET reports it pending', async () => {
    await forwardingRepo.save(TENANT, { carrier: 'att', mode: 'missed' });
    const started = await request(app()).post('/api/get-found-online/forwarding/check');
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ status: 'pending' });
    expect(started.body.data.guidance).toMatch(/ring out/i);
    expect(checkFetch).toHaveBeenCalledTimes(1);

    const latest = await request(app()).get('/api/get-found-online/forwarding/check');
    expect(latest.body.data.status).toBe('pending');
  });

  it('POST /forwarding/check explains what is missing instead of calling', async () => {
    const res = await request(app()).post('/api/get-found-online/forwarding/check');
    expect(res.status).toBe(400);
    expect(res.body.message ?? res.body.error).toMatch(/carrier/i);
    expect(checkFetch).not.toHaveBeenCalled();
  });

  it('the check endpoints are owner-only and rate-limited per tenant', async () => {
    expect((await request(app('technician')).post('/api/get-found-online/forwarding/check')).status).toBe(403);
    expect((await request(app('technician')).get('/api/get-found-online/forwarding/check')).status).toBe(403);

    await forwardingRepo.save(TENANT, { carrier: 'att', mode: 'missed' });
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await request(a).post('/api/get-found-online/forwarding/check')).status);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
    expect(checkFetch).toHaveBeenCalledTimes(5);
  });
});
