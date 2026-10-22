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
    expect(res.body).toEqual({
      presencePath: null,
      items: [],
      allDone: false,
      callRouting: { line: 'none', forwardingMode: 'missed_calls' },
    });
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

  it('PUT /forwarding-mode stores the mode, audits it, and a real change voids the last forwarding check', async () => {
    await request(app).put('/api/get-found/presence-path').send({ presencePath: 'google_only' });
    await pool.query(
      `UPDATE tenant_settings
          SET forwarding_source_number = '+16025550100', forwarding_mode = 'missed_calls',
              forwarding_verified_at = '2026-10-22T15:00:00Z', forwarding_generation = 3
        WHERE tenant_id = $1`,
      [current.tenantId],
    );

    // Re-saving the same mode keeps the check: nothing about the line changed.
    const same = await request(app).put('/api/get-found/forwarding-mode').send({ forwardingMode: 'missed_calls' });
    expect(same.status).toBe(200);
    expect(same.body.items).toContainEqual({ id: 'call_routing', status: 'done', checkedAt: '2026-10-22T15:00:00.000Z' });

    const changed = await request(app).put('/api/get-found/forwarding-mode').send({ forwardingMode: 'all_calls' });
    expect(changed.status).toBe(200);
    expect(changed.body.items).toContainEqual({ id: 'call_routing', status: 'pending' });
    expect(await rawColumn<string>('forwarding_mode')).toBe('all_calls');
    expect(await rawColumn<Date | null>('forwarding_verified_at')).toBeNull();
    expect(await rawColumn<number>('forwarding_generation')).toBe(4);
    expect((await auditEvents()).filter((e) => e.eventType === 'get_found.forwarding_mode.set')).toEqual([
      expect.objectContaining({ metadata: { forwardingMode: 'all_calls', previous: 'missed_calls' } }),
    ]);
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

  it('re-saving the same presence path is a no-op with no audit row', async () => {
    await request(app).put('/api/get-found/presence-path').send({ presencePath: 'neither' });

    const again = await request(app).put('/api/get-found/presence-path').send({ presencePath: 'neither' });

    expect(again.status).toBe(200);
    expect(again.body.presencePath).toBe('neither');
    expect((await auditEvents()).map((e) => e.eventType)).toEqual(['get_found.presence_path.set']);
  });
});
