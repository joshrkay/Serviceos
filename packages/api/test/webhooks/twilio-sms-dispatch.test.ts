/**
 * P2-034 — Verify the Twilio inbound-SMS route invokes the keyword
 * dispatcher AFTER markProcessed succeeds, and that handler failures /
 * unmatched messages never cause a 5xx.
 *
 * Twilio signature verification is mocked so the test focuses on dispatch
 * wiring, not crypto. Signature behavior is covered separately by
 * test/routes/webhooks-tenant-binding.route.test.ts and the dedicated
 * twilio-signature unit tests.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/telephony/twilio-signature', async () => {
  const actual = await vi.importActual<typeof import('../../src/telephony/twilio-signature')>(
    '../../src/telephony/twilio-signature',
  );
  return {
    ...actual,
    verifyTwilioSignature: () => true,
    reconstructWebhookUrl: () => 'http://test.local/x',
  };
});

import { createWebhookRouter } from '../../src/webhooks/routes';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  __resetKeywordRegistryForTests,
  registerKeywordHandler,
} from '../../src/sms/inbound-dispatch';
import type { AppConfig } from '../../src/shared/config';

const cfg = {} as AppConfig;

// The recordTwilio handler now rejects a non-UUID :tenantId up front (a
// malformed id would otherwise throw in setTenantContext on the prod audit
// path). This suite exercises dispatch wiring, not id format, so it uses a
// well-formed tenant id.
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(opts: {
  webhookEventRepo: { recordReceipt: ReturnType<typeof vi.fn>; markProcessed: ReturnType<typeof vi.fn> };
  auditRepo?: InMemoryAuditRepository;
}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(
    '/webhooks',
    createWebhookRouter(cfg, {
      integrationResolver: async () => ({
        tenantId: TENANT_ID,
        provider: 'twilio',
        subaccountSid: 'AC-real',
        authTokenPrimary: 'token',
      }),
      // The tsconfig.test.json includes tests so plain `vi.fn()` infers
      // `Mock<any[], unknown>` which doesn't quite line up with the
      // WebhookEventRepo signature in the deps object. The same `as any`
      // escape hatch is used by webhooks-tenant-binding.route.test.ts —
      // the runtime shape is the contract that matters here.
      webhookEventRepo: opts.webhookEventRepo as any,
      auditRepo: opts.auditRepo,
    }),
  );
  return app;
}

const eventRepoOk = () => ({
  recordReceipt: vi.fn().mockResolvedValue({ inserted: true }),
  markProcessed: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  __resetKeywordRegistryForTests();
});

describe('P2-034 — Twilio SMS webhook → keyword dispatcher integration', () => {
  it('invokes dispatcher AFTER markProcessed succeeds and returns 200', async () => {
    const callOrder: string[] = [];
    const repo = {
      recordReceipt: vi.fn(async () => {
        callOrder.push('recordReceipt');
        return { inserted: true } as const;
      }),
      markProcessed: vi.fn(async () => {
        callOrder.push('markProcessed');
      }),
    };

    registerKeywordHandler({
      keywords: ['OUT'],
      handle: vi.fn(async () => {
        callOrder.push('handler');
        return { handled: true, handler: 'tech-status' };
      }),
    });

    const app = buildApp({ webhookEventRepo: repo as any });
    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-1&From=%2B15551234567&Body=OUT');

    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['recordReceipt', 'markProcessed', 'handler']);
  });

  it('does NOT dispatch on a duplicate (inserted=false) — short-circuits with duplicate:true', async () => {
    const handleSpy = vi.fn(async () => ({ handled: true }));
    registerKeywordHandler({ keywords: ['OUT'], handle: handleSpy });

    const repo = {
      recordReceipt: vi.fn().mockResolvedValue({ inserted: false }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({ webhookEventRepo: repo as any });

    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-dup&From=%2B15551234567&Body=OUT');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(handleSpy).not.toHaveBeenCalled();
    expect(repo.markProcessed).not.toHaveBeenCalled();
  });

  it('returns 200 when a handler throws (dispatcher swallows the error)', async () => {
    registerKeywordHandler({
      keywords: ['BOOM'],
      handle: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const audit = new InMemoryAuditRepository();
    const app = buildApp({ webhookEventRepo: eventRepoOk(), auditRepo: audit });

    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-err&From=%2B15550000001&Body=BOOM');

    expect(res.status).toBe(200);

    const events = audit.getAll();
    const dispatchEvent = events.find((e) => e.eventType.startsWith('sms.inbound'));
    expect(dispatchEvent).toBeDefined();
    expect(dispatchEvent!.metadata?.reason).toBe('handler_error');
    // Cross-tenant isolation: audit carries only tenantId + fromE164
    expect(dispatchEvent!.tenantId).toBe(TENANT_ID);
  });

  it('audits unmatched messages and returns 200', async () => {
    // No handlers registered.
    const audit = new InMemoryAuditRepository();
    const app = buildApp({ webhookEventRepo: eventRepoOk(), auditRepo: audit });

    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-unk&From=%2B15550000002&Body=HELLO');

    expect(res.status).toBe(200);
    const unhandled = audit.getAll().find((e) => e.eventType === 'sms.inbound.unhandled');
    expect(unhandled).toBeDefined();
    expect(unhandled!.metadata?.reason).toBe('no_matching_handler');
  });

  it('non-SMS Twilio kinds (voice/status) do not invoke the dispatcher', async () => {
    const handleSpy = vi.fn(async () => ({ handled: true }));
    registerKeywordHandler({ keywords: ['OUT'], handle: handleSpy });

    const app = buildApp({ webhookEventRepo: eventRepoOk() });

    const voice = await request(app)
      .post(`/webhooks/twilio/voice/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&CallSid=CA-1&Body=OUT');
    expect(voice.status).toBe(200);

    const status = await request(app)
      .post(`/webhooks/twilio/status/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-2&Body=OUT');
    expect(status.status).toBe(200);

    expect(handleSpy).not.toHaveBeenCalled();
  });
});

describe('JTBD #4 — Twilio MMS webhook → job-photo ingest', () => {
  function buildMmsApp(mmsPhotoIngest: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      '/webhooks',
      createWebhookRouter(cfg, {
        integrationResolver: async () => ({
          tenantId: TENANT_ID,
          provider: 'twilio',
          subaccountSid: 'AC-real',
          authTokenPrimary: 'token',
        }),
        webhookEventRepo: eventRepoOk() as any,
        mmsPhotoIngest: mmsPhotoIngest as any,
      }),
    );
    return app;
  }

  it('routes an inbound MMS to mmsPhotoIngest (with creds + media) instead of the keyword dispatcher', async () => {
    const keywordSpy = vi.fn(async () => ({ handled: true }));
    registerKeywordHandler({ keywords: ['HENDERSON'], handle: keywordSpy });
    const ingest = vi.fn(async () => ({ handled: true, attached: 1, reason: 'attached' }));

    const app = buildMmsApp(ingest);
    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send(
        'AccountSid=AC-real&MessageSid=MM-1&From=%2B15551230001&Body=Henderson%20before' +
          '&NumMedia=1&MediaUrl0=https%3A%2F%2Fmedia.twiliocdn.com%2Fa&MediaContentType0=image%2Fjpeg',
      );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mms: true, attached: 1 });
    expect(ingest).toHaveBeenCalledTimes(1);
    const ctx = ingest.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.accountSid).toBe('AC-real');
    expect(ctx.authToken).toBe('token');
    expect(ctx.media).toEqual([{ url: 'https://media.twiliocdn.com/a', contentType: 'image/jpeg' }]);
    // The MMS short-circuits the keyword dispatcher.
    expect(keywordSpy).not.toHaveBeenCalled();
  });

  it('a plain SMS (no media) still goes to the keyword dispatcher, not the ingest hook', async () => {
    const keywordSpy = vi.fn(async () => ({ handled: true }));
    registerKeywordHandler({ keywords: ['OUT'], handle: keywordSpy });
    const ingest = vi.fn(async () => ({ handled: true, attached: 0 }));

    const app = buildMmsApp(ingest);
    const res = await request(app)
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .send('AccountSid=AC-real&MessageSid=SM-9&From=%2B15551230001&Body=OUT&NumMedia=0');

    expect(res.status).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
    expect(keywordSpy).toHaveBeenCalledTimes(1);
  });
});
