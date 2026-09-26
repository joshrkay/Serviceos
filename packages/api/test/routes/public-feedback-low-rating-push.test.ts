/**
 * #1071 — a low rating (≤3★) on the public post-job feedback form is routed
 * to the owner privately via the shared owner-notification push seam
 * (`notifyOwner` → OwnerNotificationService), the same path every other owner
 * alert uses. 4–5★ is not pushed (those customers are shown the public review
 * links instead).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPublicFeedbackRouter } from '../../src/routes/public-feedback';
import {
  InMemoryFeedbackRequestRepository,
  createFeedbackRequest,
} from '../../src/feedback/feedback-request';
import { InMemoryFeedbackResponseRepository } from '../../src/feedback/feedback-response';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  NOTIFICATION_DESCRIPTORS,
  OwnerNotificationService,
} from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const TOKEN_A = 'ExponentPushToken[owner-a]';
const TOKEN_B = 'ExponentPushToken[owner-b]';

describe('POST /public/feedback/:token — low-rating owner push (#1071)', () => {
  let requestRepo: InMemoryFeedbackRequestRepository;
  let provider: InMemoryPushDeliveryProvider;
  let app: express.Express;

  beforeEach(async () => {
    requestRepo = new InMemoryFeedbackRequestRepository();
    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({ tenantId: TENANT_A, userId: 'owner-a', expoPushToken: TOKEN_A, platform: 'ios' });
    await tokenRepo.register({ tenantId: TENANT_B, userId: 'owner-b', expoPushToken: TOKEN_B, platform: 'ios' });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }));

    app = express();
    app.use(express.json());
    app.use(
      '/public/feedback',
      createPublicFeedbackRouter(
        requestRepo,
        new InMemoryFeedbackResponseRepository(),
        new InMemorySettingsRepository(),
        new InMemoryAuditRepository(),
      ),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  async function mint(tenantId: string, jobId = 'job-1'): Promise<string> {
    const req = await requestRepo.create(createFeedbackRequest({ tenantId, jobId }));
    return req.token;
  }

  it('pushes the owner when a 1★ rating arrives, deep-linking to the job', async () => {
    const token = await mint(TENANT_A, 'job-42');
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 1, comment: 'Late and messy' });
    expect(res.status).toBe(201);

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.to).toBe(TOKEN_A);
    expect(msg.title).toContain('1★');
    expect(msg.body).toContain('Late and messy');
    expect(msg.data).toMatchObject({ type: 'low_rating_feedback', screen: '/jobs/job-42', entityId: 'job-42' });
  });

  it('pushes the owner at the boundary: exactly 3★', async () => {
    const token = await mint(TENANT_A);
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 3 });
    expect(res.status).toBe(201);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data).toMatchObject({ type: 'low_rating_feedback' });
  });

  it.each([4, 5])('does NOT push the owner for a %i★ rating', async (rating) => {
    const token = await mint(TENANT_A);
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating });
    expect(res.status).toBe(201);
    expect(provider.sent).toHaveLength(0);
  });

  it("notifies only the submitting tenant's owner — another tenant's devices get nothing", async () => {
    const token = await mint(TENANT_B);
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 2 });
    expect(res.status).toBe(201);
    expect(provider.sent.map((m) => m.to)).toEqual([TOKEN_B]);
  });
});

describe('low_rating_feedback push copy (#1071)', () => {
  const build = NOTIFICATION_DESCRIPTORS.low_rating_feedback.build;

  it('without a comment, names the rating and asks the owner to reach out', () => {
    const built = build({ jobId: 'j', rating: 2, comment: null });
    expect(built.title).toBe('Unhappy customer — 2★');
    expect(built.body).toMatch(/2★/);
  });

  it('truncates a long comment to a short preview', () => {
    const built = build({ jobId: 'j', rating: 1, comment: 'x'.repeat(500) });
    expect(built.body.length).toBeLessThanOrEqual(122);
    expect(built.body.endsWith('…"')).toBe(true);
  });

  it('is gated on the same permission as the owner feedback page', () => {
    expect(NOTIFICATION_DESCRIPTORS.low_rating_feedback.permission).toBe('settings:view');
  });
});
