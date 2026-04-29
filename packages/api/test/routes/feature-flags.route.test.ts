/**
 * P7-015 — admin routes for feature flag CRUD.
 * P0-034 — feature-flag admin gates on cross-tenant `platform_admins`,
 *          NOT the per-tenant owner role. Tenant owners (without a
 *          platform_admins row) MUST be rejected.
 *
 * Proves:
 *  - Tenant owner without a platform_admins row -> 403 on every admin route.
 *  - Tenant owner with a platform_admins row    -> 200/204 as appropriate.
 *  - The sync store stays in sync with the async repository after writes.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { createFeatureFlagsRouter } from '../../src/routes/feature-flags';
import {
  InMemoryFeatureFlagRepository,
  InMemoryFeatureFlagStore,
  isFeatureEnabled,
} from '../../src/flags/feature-flags';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import { InMemoryPlatformAdminChecker } from '../../src/auth/platform-admin';

interface BuildOpts {
  role?: Role;
  userId?: string;
  /** Seed the platform_admins table with these user ids. */
  platformAdmins?: string[];
}

function buildApp(opts: BuildOpts = {}): {
  app: Express;
  repo: InMemoryFeatureFlagRepository;
  store: InMemoryFeatureFlagStore;
  checker: InMemoryPlatformAdminChecker;
} {
  const role: Role = opts.role ?? 'owner';
  const userId = opts.userId ?? 'user-1';

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId,
      sessionId: 's',
      tenantId: 'tenant-1',
      role,
    };
    next();
  });

  const repo = new InMemoryFeatureFlagRepository();
  const store = new InMemoryFeatureFlagStore();
  const checker = new InMemoryPlatformAdminChecker(opts.platformAdmins ?? []);
  app.use(
    '/api/admin/feature-flags',
    createFeatureFlagsRouter(repo, store, { platformAdminChecker: checker })
  );
  return { app, repo, store, checker };
}

describe('P0-034 — feature-flags admin gates on platform-admin', () => {
  describe('GET /api/admin/feature-flags', () => {
    it('platform admin sees the full list', async () => {
      const { app, repo } = buildApp({ platformAdmins: ['user-1'] });
      await repo.upsert({ name: 'voice_actions', enabled: true });

      const res = await request(app).get('/api/admin/feature-flags');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('voice_actions');
    });

    it('tenant owner without platform_admins row -> 403', async () => {
      const { app } = buildApp({ role: 'owner', platformAdmins: [] });
      const res = await request(app).get('/api/admin/feature-flags');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('platform_admin_required');
    });

    it('dispatcher role without platform_admins row -> 403', async () => {
      const { app } = buildApp({ role: 'dispatcher', platformAdmins: [] });
      const res = await request(app).get('/api/admin/feature-flags');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/admin/feature-flags/:name', () => {
    it('platform admin can fetch a single flag', async () => {
      const { app, repo } = buildApp({ platformAdmins: ['user-1'] });
      await repo.upsert({ name: 'voice_actions', enabled: true });
      const res = await request(app).get('/api/admin/feature-flags/voice_actions');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('voice_actions');
    });

    it('tenant owner without platform_admins row -> 403 on detail GET', async () => {
      const { app } = buildApp({ role: 'owner', platformAdmins: [] });
      const res = await request(app).get('/api/admin/feature-flags/voice_actions');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/admin/feature-flags/:name', () => {
    it('platform admin upsert -> 200 and the sync store mirrors the repo', async () => {
      const { app, repo, store } = buildApp({ platformAdmins: ['user-1'] });

      const res = await request(app)
        .put('/api/admin/feature-flags/voice_actions')
        .send({ enabled: true, environments: ['prod'], description: 'Voice capture' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('voice_actions');
      expect(res.body.enabled).toBe(true);

      const inRepo = await repo.get('voice_actions');
      expect(inRepo?.enabled).toBe(true);

      const inStore = store.getFlag('voice_actions');
      expect(inStore?.enabled).toBe(true);

      expect(
        isFeatureEnabled(store, 'voice_actions', { environment: 'prod', tenantId: 'tenant-1' })
      ).toBe(true);
    });

    it('tenant owner without platform_admins row -> 403 on PUT', async () => {
      const { app, repo } = buildApp({ role: 'owner', platformAdmins: [] });
      const res = await request(app)
        .put('/api/admin/feature-flags/voice_actions')
        .send({ enabled: true });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('platform_admin_required');
      expect(await repo.get('voice_actions')).toBeNull();
    });

    it('returns 400 when the body fails validation (platform admin)', async () => {
      const { app } = buildApp({ platformAdmins: ['user-1'] });
      const res = await request(app)
        .put('/api/admin/feature-flags/bad')
        .send({ enabled: 'not-a-boolean' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/admin/feature-flags/:name', () => {
    it('platform admin DELETE -> 204 and removes from both repo and store', async () => {
      const { app, repo, store } = buildApp({ platformAdmins: ['user-1'] });
      await repo.upsert({ name: 'to_remove', enabled: true });
      store.setFlag({ name: 'to_remove', enabled: true });

      const res = await request(app).delete('/api/admin/feature-flags/to_remove');
      expect(res.status).toBe(204);
      expect(await repo.get('to_remove')).toBeNull();
      expect(store.getFlag('to_remove')).toBeUndefined();
    });

    it('tenant owner without platform_admins row -> 403 on DELETE', async () => {
      const { app, repo } = buildApp({ role: 'owner', platformAdmins: [] });
      await repo.upsert({ name: 'to_remove', enabled: true });

      const res = await request(app).delete('/api/admin/feature-flags/to_remove');
      expect(res.status).toBe(403);
      // The flag is NOT removed.
      expect(await repo.get('to_remove')).not.toBeNull();
    });

    it('returns 404 when the flag does not exist (platform admin)', async () => {
      const { app } = buildApp({ platformAdmins: ['user-1'] });
      const res = await request(app).delete('/api/admin/feature-flags/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('JWT cannot forge platform-admin', () => {
    // The gate consults the database via the checker; even an authenticated
    // user with role='owner' (a per-tenant role) is rejected unless the
    // checker has them in its set.
    it('owner role + missing platform_admins row = 403 (no JWT bypass)', async () => {
      const { app } = buildApp({ role: 'owner', platformAdmins: [] });
      const res = await request(app)
        .put('/api/admin/feature-flags/x')
        .send({ enabled: true });
      expect(res.status).toBe(403);
    });
  });
});
