/**
 * P7-015 — admin routes for feature flag CRUD.
 *
 * Proves that the owner role can list/get/upsert/delete flags, non-owner
 * roles are rejected, and the sync store stays in sync with the async
 * repository after each mutation.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
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

function buildApp(role: Role): {
  app: Express;
  repo: InMemoryFeatureFlagRepository;
  store: InMemoryFeatureFlagStore;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 's',
      tenantId: 'tenant-1',
      role,
    };
    next();
  });
  const repo = new InMemoryFeatureFlagRepository();
  const store = new InMemoryFeatureFlagStore();
  app.use('/api/admin/feature-flags', createFeatureFlagsRouter(repo, store));
  return { app, repo, store };
}

describe('GET /api/admin/feature-flags', () => {
  it('owner sees the full list', async () => {
    const { app, repo } = buildApp('owner');
    await repo.upsert({ name: 'voice_actions', enabled: true });

    const res = await request(app).get('/api/admin/feature-flags');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('voice_actions');
  });

  it('dispatcher role is forbidden', async () => {
    const { app } = buildApp('dispatcher');
    const res = await request(app).get('/api/admin/feature-flags');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/admin/feature-flags/:name', () => {
  it('persists to the repo and updates the sync store', async () => {
    const { app, repo, store } = buildApp('owner');

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

  it('returns 400 when the body fails validation', async () => {
    const { app } = buildApp('owner');
    const res = await request(app)
      .put('/api/admin/feature-flags/bad')
      .send({ enabled: 'not-a-boolean' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/feature-flags/:name', () => {
  it('removes the flag from both repo and store', async () => {
    const { app, repo, store } = buildApp('owner');
    await repo.upsert({ name: 'to_remove', enabled: true });
    store.setFlag({ name: 'to_remove', enabled: true });

    const res = await request(app).delete('/api/admin/feature-flags/to_remove');
    expect(res.status).toBe(204);
    expect(await repo.get('to_remove')).toBeNull();
    expect(store.getFlag('to_remove')).toBeUndefined();
  });

  it('returns 404 when the flag does not exist', async () => {
    const { app } = buildApp('owner');
    const res = await request(app).delete('/api/admin/feature-flags/nonexistent');
    expect(res.status).toBe(404);
  });
});
