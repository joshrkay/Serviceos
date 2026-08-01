/**
 * Postgres integration — owner membership row on signup
 * (QUALITY-2026-07-12 WS4).
 *
 * DB-authoritative authorization rejects a caller with no `users` row, so the
 * Clerk `user.created` → bootstrap path MUST now create the owner's membership
 * row (historically it created only the tenant + Clerk metadata). This drives
 * the REAL `/webhooks/clerk` route against a real Postgres and asserts the owner
 * row lands with role='owner', and that a replay does not duplicate it.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import type { AppConfig } from '../../src/shared/config';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('Postgres integration — Clerk owner membership bootstrap', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const config = {
      CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CLERK_SECRET_KEY: undefined,
    } as unknown as AppConfig;
    app = express();
    app.use(express.json());
    app.use(
      '/webhooks',
      createWebhookRouter(config, {
        tenantRepo: new PgTenantRepository(pool),
        pool,
        webhookRepo: new InMemoryWebhookRepository(),
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates an owner users row (role=owner) and does not duplicate on replay', async () => {
    const clerkUserId = `user_owner_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    const payload = {
      type: 'user.created',
      data: { id: clerkUserId, email_addresses: [{ email_address: email }] },
    };
    const svixId = `evt_${crypto.randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signSvixPayload(payload, svixId, ts))
      .send(payload);
    expect(res.status).toBe(200);

    const rows = await pool.query(
      `SELECT role, status, deleted_at FROM users WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].role).toBe('owner');
    expect(rows.rows[0].status).toBe('active');
    expect(rows.rows[0].deleted_at).toBeNull();

    // Replay the SAME event id (fresh timestamp): event-id idempotency short-
    // circuits before bootstrap, and even if it didn't the WHERE NOT EXISTS
    // guard keeps exactly one owner row.
    const ts2 = String(Math.floor(Date.now() / 1000));
    const replay = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts2)
      .set('svix-signature', signSvixPayload(payload, svixId, ts2))
      .send(payload);
    expect(replay.status).toBe(200);

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    expect(after.rows[0].n).toBe(1);
  });
});
