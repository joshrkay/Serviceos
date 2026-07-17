/**
 * SEC-40 / SEC-41 — webhook raw-body middleware ordering.
 *
 * These guard the invariant that provider webhooks verify their signature over
 * the EXACT raw request bytes, which only holds when the per-provider
 * express.raw() parser is mounted BEFORE the global express.json() in app.ts.
 *
 *   SEC-40: /webhooks/sendgrid was omitted from the raw-mount list, so global
 *           json() consumed + reparsed the body and the handler's
 *           JSON.stringify() fallback re-serialized a different byte sequence —
 *           verifySendGridSignature then rejected every genuine signed delivery.
 *
 *   SEC-41: the /api/webhooks alias was mounted WITHOUT the raw middleware, so
 *           /api/webhooks/stripe|vapi reached the handler with a parsed body.
 *           The alias is now removed (canonical surface is /webhooks/*).
 *
 * The behavioral SendGrid cases mirror the real app wiring (raw before router).
 * The alias + mount-order cases assert against the app.ts source directly, the
 * same technique as test/app/wiring.test.ts (booting createApp() needs Pg + a
 * full prod secret set, which is out of scope for a wiring assertion).
 */
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AppConfig } from '../../src/shared/config';

const TENANT = '33333333-3333-3333-3333-333333333333';

let publicKeyPem: string;
let privateKey: crypto.KeyObject;

function sign(timestamp: string, payload: Buffer): string {
  const signer = crypto.createSign('sha256');
  signer.update(timestamp);
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey).toString('base64');
}

beforeAll(() => {
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  privateKey = priv;
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

/**
 * Build an app that mirrors app.ts: raw() for /webhooks/sendgrid mounted
 * BEFORE global express.json(), then the webhook router. When `withRawMount`
 * is false we drop the raw mount to reproduce the SEC-40 bug (json() wins).
 */
function buildApp(withRawMount: boolean) {
  const auditRepo = new InMemoryAuditRepository();
  const integrationResolver = async (tenantId: string, provider: 'twilio' | 'sendgrid') => {
    if (provider !== 'sendgrid') return null;
    return {
      tenantId,
      provider: 'sendgrid' as const,
      sendgridPublicKeyPem: publicKeyPem,
    };
  };

  const app = express();
  if (withRawMount) {
    app.use('/webhooks/sendgrid', express.raw({ type: 'application/json' }));
  }
  app.use(express.json({ limit: '1mb' }));
  app.use('/webhooks', createWebhookRouter({} as AppConfig, { auditRepo, integrationResolver }));
  return app;
}

function postSendGrid(app: express.Express, rawBody: string, timestamp: string, signature: string) {
  return request(app)
    .post(`/webhooks/sendgrid/${TENANT}`)
    .set('content-type', 'application/json')
    .set('x-twilio-email-event-webhook-timestamp', timestamp)
    .set('x-twilio-email-event-webhook-signature', signature)
    .send(rawBody);
}

describe('SEC-40 — /webhooks/sendgrid raw-body signature verification', () => {
  const timestamp = '1716422400';
  // Deliberately NOT the compact JSON.stringify() form: SendGrid signs its own
  // wire bytes (spacing / key order we don't control). Signing these exact bytes
  // means the handler only verifies if it sees the raw buffer — re-serializing
  // the parsed object (the SEC-40 fallback) produces the compact form and fails.
  const rawBody = '[ {"event": "delivered", "sg_event_id": "evt-1"} ]';

  it('accepts a correctly-signed payload when raw() is mounted before json()', async () => {
    const app = buildApp(true);
    const signature = sign(timestamp, Buffer.from(rawBody));
    const res = await postSendGrid(app, rawBody, timestamp, signature);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('rejects a tampered/bad signature with 403', async () => {
    const app = buildApp(true);
    const forged = sign(timestamp, Buffer.from('[{"event":"open"}]'));
    const res = await postSendGrid(app, rawBody, timestamp, forged);
    expect(res.status).toBe(403);
  });

  it('regression: WITHOUT the raw mount, a genuine signature fails (this is the SEC-40 bug)', async () => {
    // json() consumes the body; the handler re-serializes req.body, whose byte
    // sequence differs from what was signed, so verification fails closed.
    const app = buildApp(false);
    const signature = sign(timestamp, Buffer.from(rawBody));
    const res = await postSendGrid(app, rawBody, timestamp, signature);
    expect(res.status).toBe(403);
  });
});

describe('SEC-41 — /api/webhooks alias removed; canonical raw mounts intact', () => {
  const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

  it('app.ts no longer mounts the /api/webhooks router alias', () => {
    expect(src).not.toMatch(/app\.use\(\s*['"]\/api\/webhooks['"]\s*,\s*createWebhookRouter/);
  });

  it('app.ts no longer registers /api/webhooks/* raw-body middleware', () => {
    expect(src).not.toMatch(/app\.use\(\s*['"]\/api\/webhooks\//);
  });

  it('canonical /webhooks router mount is preserved', () => {
    expect(src).toMatch(/app\.use\(\s*['"]\/webhooks['"]\s*,\s*createWebhookRouter/);
  });

  it('SEC-40: /webhooks/sendgrid raw mount exists and precedes global express.json()', () => {
    const rawIdx = src.indexOf("app.use('/webhooks/sendgrid', express.raw(");
    const jsonIdx = src.indexOf("app.use(express.json(");
    expect(rawIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeLessThan(jsonIdx);
  });
});
