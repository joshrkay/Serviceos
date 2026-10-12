/**
 * Signup attribution through the Clerk user.created webhook: the marketing
 * first touch arrives as browser-controlled `unsafe_metadata.signupAttribution`,
 * is re-validated server-side, persisted write-once on the tenant, and rides
 * along on the `signup_completed` funnel event and the bootstrap audit row.
 * Attribution problems must never fail the signup.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SignupAttribution } from '@ai-service-os/shared';

const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { createWebhookRouter } from '../../src/webhooks/routes';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AppConfig } from '../../src/shared/config';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

class FakeTenantRepository implements TenantRepository {
  private byOwner = new Map<string, Tenant>();
  attribution = new Map<string, SignupAttribution>();
  setCalls: Array<{ tenantId: string; attribution: SignupAttribution }> = [];
  failSet = false;

  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }
  async findById(): Promise<Tenant | null> {
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    const tenant: Tenant = {
      id: `11111111-1111-1111-1111-11111111111${this.byOwner.size + 1}`,
      ...data,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
  // Mirrors PgTenantRepository's write-once guard.
  async setSignupAttribution(tenantId: string, attribution: SignupAttribution): Promise<boolean> {
    this.setCalls.push({ tenantId, attribution });
    if (this.failSet) throw new Error('db down');
    if (this.attribution.has(tenantId)) return false;
    this.attribution.set(tenantId, attribution);
    return true;
  }
}

function sign(body: object, svixId: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', secretBytes).update(`${svixId}.${ts}.${rawBody}`).digest('base64');
  return { ts, rawBody, signature: `v1,${sig}` };
}

function userCreated(userId: string, unsafeMetadata?: unknown) {
  return {
    type: 'user.created',
    data: {
      id: userId,
      email_addresses: [{ email_address: `${userId}@shop.com` }],
      ...(unsafeMetadata === undefined ? {} : { unsafe_metadata: unsafeMetadata }),
    },
  };
}

describe('Clerk user.created → signup attribution', () => {
  let tenantRepo: FakeTenantRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(() => {
    recordFunnelEventMock.mockClear();
    tenantRepo = new FakeTenantRepository();
    auditRepo = new InMemoryAuditRepository();
    app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, { tenantRepo, auditRepo }));
  });

  function post(body: object, svixId: string) {
    const { ts, rawBody, signature } = sign(body, svixId);
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody);
  }

  const bootstrapAudits = () =>
    auditRepo.getAll().filter((e) => e.eventType === 'tenant.signup.bootstrap.completed');

  it('re-validates client metadata, persists it, and adds it to the funnel event + audit', async () => {
    const res = await post(
      userCreated('user_attr_1', {
        signupAttribution: {
          utmSource: 'google',
          utmCampaign: 'x'.repeat(300),
          ref: 'https://www.google.com/search?q=secret#frag',
          landing: 'not-a-path',
          firstTouchAt: '2026-10-01',
          injected: 'dropped',
        },
      }),
      'msg_attr_1',
    );
    expect(res.status).toBe(200);

    const expected = {
      utmSource: 'google',
      utmCampaign: 'x'.repeat(200),
      ref: 'https://www.google.com/search',
      firstTouchAt: '2026-10-01',
    };
    expect(tenantRepo.setCalls).toEqual([{ tenantId: expect.any(String), attribution: expected }]);
    const tenantId = tenantRepo.setCalls[0].tenantId;
    expect(tenantRepo.attribution.get(tenantId)).toEqual(expected);

    expect(recordFunnelEventMock).toHaveBeenCalledWith({
      distinctId: 'user_attr_1',
      event: 'signup_completed',
      properties: {
        tenantId,
        emailDomain: 'shop.com',
        utm_source: 'google',
        utm_campaign: 'x'.repeat(200),
        signup_referrer_host: 'www.google.com',
        signup_first_touch_at: '2026-10-01',
      },
    });
    expect(bootstrapAudits()).toHaveLength(1);
    expect(bootstrapAudits()[0].metadata).toMatchObject({ signupAttribution: expected });
  });

  it('does not overwrite the first touch, re-fire the funnel event, or re-audit on redelivery', async () => {
    const first = { signupAttribution: { utmSource: 'google' } };
    expect((await post(userCreated('user_attr_2', first), 'msg_attr_2a')).status).toBe(200);
    // Distinct svix id, same Clerk user → bootstrapTenant returns created=false.
    const second = { signupAttribution: { utmSource: 'bing' } };
    expect((await post(userCreated('user_attr_2', second), 'msg_attr_2b')).status).toBe(200);

    // Attempted on both deliveries (write-once lives in the repository), but
    // the stored first touch is the original.
    expect(tenantRepo.setCalls).toHaveLength(2);
    const tenantId = tenantRepo.setCalls[0].tenantId;
    expect(tenantRepo.attribution.get(tenantId)).toEqual({ utmSource: 'google' });
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
    expect(bootstrapAudits()).toHaveLength(1);
  });

  it('skips persistence and adds no funnel properties when attribution is absent or invalid', async () => {
    for (const [i, meta] of [undefined, null, 'str', { signupAttribution: { landing: 'x', ref: 'ftp://x' } }].entries()) {
      const res = await post(userCreated(`user_none_${i}`, meta), `msg_none_${i}`);
      expect(res.status).toBe(200);
    }
    expect(tenantRepo.setCalls).toEqual([]);
    for (const [call] of recordFunnelEventMock.mock.calls) {
      expect(Object.keys((call as { properties: object }).properties).sort()).toEqual(['emailDomain', 'tenantId']);
    }
    expect(bootstrapAudits().every((e) => e.metadata.signupAttribution === null)).toBe(true);
  });

  it('never fails the signup when persisting attribution throws', async () => {
    tenantRepo.failSet = true;
    const res = await post(userCreated('user_fail', { signupAttribution: { utmSource: 'google' } }), 'msg_fail');
    expect(res.status).toBe(200);
    expect(tenantRepo.setCalls).toHaveLength(1);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'signup_completed',
        properties: expect.objectContaining({ utm_source: 'google' }),
      }),
    );
    expect(bootstrapAudits()).toHaveLength(1);
  });
});
