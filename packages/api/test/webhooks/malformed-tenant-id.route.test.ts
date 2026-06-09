/**
 * Regression for the malformed-tenant-id path on the public Twilio/SendGrid
 * webhook routes.
 *
 * A non-UUID `:tenantId` must be rejected with 403 BEFORE any tenant-scoped
 * work — neither the integration resolver nor the rejectBound audit write may
 * run, because both flow through setTenantContext, which throws on a malformed
 * UUID. recordTwilio is void-dispatched, so such a throw would surface as an
 * unhandled rejection rather than a response. (Codex review on PR #493.)
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AppConfig } from '../../src/shared/config';

const cfg = {} as AppConfig;

function buildApp() {
  const auditRepo = new InMemoryAuditRepository();
  const auditCreate = vi.spyOn(auditRepo, 'create');
  const integrationResolver = vi.fn();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(
    '/webhooks',
    createWebhookRouter(cfg, {
      integrationResolver: integrationResolver as any,
      auditRepo,
    }),
  );
  return { app, auditCreate, integrationResolver };
}

describe('webhook routes — malformed :tenantId', () => {
  const malformed = 'not-a-uuid';

  for (const path of [
    `/webhooks/twilio/sms/${malformed}`,
    `/webhooks/twilio/voice/${malformed}`,
    `/webhooks/twilio/status/${malformed}`,
    `/webhooks/sendgrid/${malformed}`,
  ]) {
    it(`returns 403 without resolver or audit work: ${path}`, async () => {
      const { app, auditCreate, integrationResolver } = buildApp();
      const res = await request(app).post(path).send({ From: '+15551112222', Body: 'hi' });

      expect(res.status).toBe(403);
      expect(integrationResolver).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });
  }

  it('a well-formed tenant id still reaches the resolver', async () => {
    const { app, integrationResolver } = buildApp();
    // Resolver returns null → handler answers 403 via the !integration branch,
    // but the point is that the guard let us through to call it.
    integrationResolver.mockResolvedValue(null);
    const valid = '11111111-1111-1111-1111-111111111111';

    const res = await request(app).post(`/webhooks/twilio/sms/${valid}`).send({ Body: 'hi' });

    expect(res.status).toBe(403);
    expect(integrationResolver).toHaveBeenCalledWith(valid, 'twilio');
  });
});
