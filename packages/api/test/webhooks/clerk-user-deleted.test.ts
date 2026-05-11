/**
 * Tests for the Clerk user.deleted webhook handler (QA 16.22–16.24).
 *
 * 16.22 — subsequent API requests with the deleted user's token return 401
 *         (handled by Clerk JWT invalidation + verifyRs256Token in middleware;
 *         NOT our responsibility here — but we verify the webhook returns 200
 *         so Clerk does not retry endlessly).
 *
 * 16.23 — Postgres tenant data is NOT deleted by user deletion.
 *
 * 16.24 — Twilio subaccount is NOT released by user deletion.
 *
 * This test suite exercises the route-level behaviour: correct response code,
 * audit event emitted, pool soft-delete called, and no tenant/Twilio purge.
 */

import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import type { AppConfig } from '../../src/shared/config';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Pool } from 'pg';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ=';

function signPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const hexKey = secretBytes.toString('hex');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', hexKey)
    .update(`${svixTimestamp}.${signedContent}`)
    .digest('hex');
  return { rawBody, signature: `v1,${sig}` };
}

function userDeletedPayload(userId: string) {
  return { type: 'user.deleted', data: { id: userId } };
}

/** Minimal pool stub that tracks UPDATE calls. */
function makePoolStub(rows: { id: string; tenant_id: string }[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    connect: vi.fn(),
  } as unknown as Pool;
}

function buildApp(pool?: Pool, auditRepo?: InMemoryAuditRepository) {
  const app = express();
  app.use(express.json());
  const config = {
    CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CLERK_SECRET_KEY: undefined,
  } as unknown as AppConfig;
  app.use('/webhooks', createWebhookRouter(config, { pool, auditRepo }));
  return app;
}

describe('user.deleted webhook (16.22–16.24)', () => {
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    auditRepo = new InMemoryAuditRepository();
  });

  it('returns 200 when a user row is found and soft-deleted', async () => {
    const pool = makePoolStub([{ id: 'users-uuid-1', tenant_id: 'tenant-uuid-1' }]);
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_del_1');
    const { signature } = signPayload(payload, svixId, ts);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
  });

  it('calls pool.query with soft-delete UPDATE for the clerk_user_id', async () => {
    const pool = makePoolStub([{ id: 'uid-1', tenant_id: 'tid-1' }]);
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_2';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_42');
    const { signature } = signPayload(payload, svixId, ts);

    await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    // Must have issued an UPDATE…SET deleted_at on the users table.
    const updateCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const sql = String(args[0]);
        return sql.includes('UPDATE users') && sql.includes('deleted_at');
      },
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // The clerk_user_id must be passed as a parameter.
    const params = updateCalls[0][1] as unknown[];
    expect(params).toContain('clerk_user_42');
  });

  it('emits a user.deleted audit event for each matched users row', async () => {
    const pool = makePoolStub([{ id: 'uid-99', tenant_id: 'tid-99' }]);
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_audit';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_audit');
    const { signature } = signPayload(payload, svixId, ts);

    await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'user.deleted');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe('tid-99');
    expect(events[0].entityId).toBe('uid-99');
    expect(events[0].metadata).toMatchObject({ clerkUserId: 'clerk_user_audit' });
  });

  it('16.23 — does NOT issue DELETE on tenants table', async () => {
    const pool = makePoolStub([{ id: 'uid-1', tenant_id: 'tid-1' }]);
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_nodelete';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_nodelete');
    const { signature } = signPayload(payload, svixId, ts);

    await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    const deleteCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const sql = String(args[0]);
        return sql.includes('DELETE') && sql.toLowerCase().includes('tenant');
      },
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('16.24 — does NOT call Twilio subaccount release API', async () => {
    // The pool stub has no Twilio API calls; just verify no fetch to Twilio
    // API.twilio.com is issued. We rely on the absence of a fetch call via
    // globalThis.fetch being unpatched in test env (vitest doesn't shim it).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const pool = makePoolStub([{ id: 'uid-1', tenant_id: 'tid-1' }]);
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_notwilio';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_notwilio');
    const { signature } = signPayload(payload, svixId, ts);

    await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    const twilioApiCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('api.twilio.com'),
    );
    expect(twilioApiCalls).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('returns 200 even when pool.query throws (graceful degradation)', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB down')),
      connect: vi.fn(),
    } as unknown as Pool;
    const app = buildApp(pool, auditRepo);

    const svixId = 'evt_del_dberr';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_dberr');
    const { signature } = signPayload(payload, svixId, ts);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    // Must not 500 — Clerk would retry indefinitely on 5xx.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
  });

  it('returns 200 when no pool is configured (backward compat)', async () => {
    const app = buildApp(undefined, auditRepo);

    const svixId = 'evt_del_nopool';
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = userDeletedPayload('clerk_user_nopool');
    const { signature } = signPayload(payload, svixId, ts);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
  });
});
