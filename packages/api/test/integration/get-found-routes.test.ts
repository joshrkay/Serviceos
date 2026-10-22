/**
 * #1750 slice 1 — the Get-found checklist routes at REAL Postgres.
 *
 * Every write is read back from the `tenant_settings` column it claims to
 * move, and its audit row through the real `PgAuditRepository` (a settings
 * write whose column or audit row never lands is the silent-200 failure mode
 * settings-owner-toggles.test.ts guards). Runs under the RLS runtime role in
 * PR CI (`npm run test:integration`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createGetFoundRouter } from '../../src/get-found/get-found-router';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

/** Twilio numbers are unique across tenants, and every integration file shares one DB. */
const uniqueE164 = () => `+1602${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

describe('Get-found routes (real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let auditRepo: PgAuditRepository;
  let current: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-get-found',
        tenantId: current.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/get-found',
      createGetFoundRouter({ pool, settingsRepo: new PgSettingsRepository(pool), auditRepo }),
    );
  });

  beforeEach(async () => {
    current = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function rawColumn<T>(column: string): Promise<T> {
    const { rows } = await pool.query(
      `SELECT ${column} AS v FROM tenant_settings WHERE tenant_id = $1`,
      [current.tenantId],
    );
    return rows[0]?.v as T;
  }

  const auditEvents = () => auditRepo.findByEntity(current.tenantId, 'get_found', current.tenantId);

  it('GET returns an empty checklist until the presence path is answered', async () => {
    const res = await request(app).get('/api/get-found');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ presencePath: null, items: [], allDone: false });
  });

  it('PUT /presence-path stores the answer, audits it, and returns the re-derived checklist', async () => {
    const res = await request(app).put('/api/get-found/presence-path').send({ presencePath: 'neither' });

    expect(res.status).toBe(200);
    expect(res.body.presencePath).toBe('neither');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['google_profile', 'review_link', 'call_routing']);
    expect(await rawColumn<string>('presence_path')).toBe('neither');
    expect(await auditEvents()).toEqual([
      expect.objectContaining({
        eventType: 'get_found.presence_path.set',
        actorId: current.userId,
        metadata: { presencePath: 'neither', previous: null },
      }),
    ]);
  });

  it('PUT /call-routing-mode stores the mode, audits it, and Rivet-number-only ticks once a number is live', async () => {
    await pool.query(
      `INSERT INTO tenant_integrations (id, tenant_id, provider, status, provider_data)
       VALUES (gen_random_uuid(), $1, 'twilio', 'full_readiness', $2::jsonb)`,
      [current.tenantId, JSON.stringify({ phoneE164: uniqueE164() })],
    );
    await request(app).put('/api/get-found/presence-path').send({ presencePath: 'google_only' });

    const res = await request(app).put('/api/get-found/call-routing-mode').send({ callRoutingMode: 'rivet_only' });

    expect(res.status).toBe(200);
    expect(res.body.items).toContainEqual({ id: 'call_routing', status: 'done' });
    expect(await rawColumn<string>('call_routing_mode')).toBe('rivet_only');
    expect(await auditEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'get_found.call_routing_mode.set',
        metadata: { callRoutingMode: 'rivet_only', previous: null },
      }),
    );
  });

  it('skipping an item folds it away, un-skipping brings it back, and both are audited', async () => {
    await request(app).put('/api/get-found/presence-path').send({ presencePath: 'own_website' });

    const skipped = await request(app).put('/api/get-found/items/call_routing/skip');
    expect(skipped.status).toBe(200);
    expect(skipped.body.items).toContainEqual({ id: 'call_routing', status: 'skipped' });
    expect(await rawColumn<string[]>('get_found_skipped_items')).toEqual(['call_routing']);

    // Idempotent: a second skip does not duplicate the id.
    await request(app).put('/api/get-found/items/call_routing/skip');
    expect(await rawColumn<string[]>('get_found_skipped_items')).toEqual(['call_routing']);

    const unskipped = await request(app).delete('/api/get-found/items/call_routing/skip');
    expect(unskipped.status).toBe(200);
    expect(unskipped.body.items).toContainEqual({ id: 'call_routing', status: 'pending' });
    expect(await rawColumn<string[]>('get_found_skipped_items')).toEqual([]);

    // Only the writes that changed something are audited: the repeat skip was a no-op.
    const types = (await auditEvents()).map((e) => e.eventType);
    expect(types.filter((t) => t === 'get_found.item.skipped')).toHaveLength(1);
    expect(types.filter((t) => t === 'get_found.item.unskipped')).toHaveLength(1);
  });

  it('un-skipping an item that was never skipped succeeds without an audit row', async () => {
    await request(app).put('/api/get-found/presence-path').send({ presencePath: 'neither' });

    const res = await request(app).delete('/api/get-found/items/google_profile/skip');

    expect(res.status).toBe(200);
    expect((await auditEvents()).map((e) => e.eventType)).toEqual(['get_found.presence_path.set']);
  });

  it('refuses an unknown item or an invalid answer with a 400 and writes nothing', async () => {
    const unknownItem = await request(app).put('/api/get-found/items/blog/skip');
    expect(unknownItem.status).toBe(400);
    expect(unknownItem.body.details.fields).toHaveProperty('id');
    expect((await request(app).put('/api/get-found/presence-path').send({ presencePath: 'tiktok' })).status).toBe(400);
    expect(await auditEvents()).toEqual([]);
  });
});
