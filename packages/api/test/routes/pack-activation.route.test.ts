import * as crypto from 'crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import type { Express } from 'express';

const TEST_SECRET = 'dev-secret-key';

function createAuthToken(tenantId: string, role: 'owner' | 'dispatcher' | 'technician' = 'owner'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    sub: 'user-test-1',
    sid: 'session-test-1',
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signatureInput = `${header}.${body}`;
  const sig = crypto
    .createHmac('sha256', TEST_SECRET)
    .update(signatureInput)
    .digest('base64url');

  return `${header}.${body}.${sig}`;
}

function withAuth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Pack activation routes', () => {
  let app: Express;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = TEST_SECRET;
    app = createApp();
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
  });

  it('activates HVAC pack for the authenticated tenant', async () => {
    const token = createAuthToken('tenant-a', 'owner');

    const activateRes = await request(app)
      .put('/api/settings/packs/hvac-v1/activate')
      .set(withAuth(token));

    expect(activateRes.status).toBe(201);
    expect(activateRes.body.tenantId).toBe('tenant-a');
    expect(activateRes.body.packId).toBe('hvac-v1');
    expect(activateRes.body.status).toBe('active');

    const listRes = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].packId).toBe('hvac-v1');
  });

  it('activates plumbing pack for the authenticated tenant', async () => {
    const token = createAuthToken('tenant-a', 'owner');

    const activateRes = await request(app)
      .put('/api/settings/packs/plumbing-v1/activate')
      .set(withAuth(token));

    expect(activateRes.status).toBe(201);
    expect(activateRes.body.packId).toBe('plumbing-v1');

    const listRes = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body.map((p: { packId: string }) => p.packId)).toEqual(['plumbing-v1']);
  });

  it('activates both canonical packs and lists both for the tenant', async () => {
    const token = createAuthToken('tenant-a', 'owner');

    const hvacRes = await request(app)
      .put('/api/settings/packs/hvac-v1/activate')
      .set(withAuth(token));
    const plumbingRes = await request(app)
      .put('/api/settings/packs/plumbing-v1/activate')
      .set(withAuth(token));

    expect(hvacRes.status).toBe(201);
    expect(plumbingRes.status).toBe(201);

    const listRes = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body.map((p: { packId: string }) => p.packId).sort()).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('deactivates a previously activated pack', async () => {
    const token = createAuthToken('tenant-a', 'owner');

    await request(app)
      .put('/api/settings/packs/hvac-v1/activate')
      .set(withAuth(token));

    const deactivateRes = await request(app)
      .delete('/api/settings/packs/hvac-v1')
      .set(withAuth(token));

    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.status).toBe('deactivated');

    const listRes = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(0);
  });

  it('enforces tenant scope when retrieving active packs', async () => {
    const tenantAToken = createAuthToken('tenant-a', 'owner');
    const tenantBToken = createAuthToken('tenant-b', 'owner');

    await request(app)
      .put('/api/settings/packs/hvac-v1/activate')
      .set(withAuth(tenantAToken));

    const tenantAList = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(tenantAToken));

    const tenantBList = await request(app)
      .get('/api/settings/packs')
      .set(withAuth(tenantBToken));

    expect(tenantAList.status).toBe(200);
    expect(tenantAList.body).toHaveLength(1);
    expect(tenantAList.body[0].tenantId).toBe('tenant-a');

    expect(tenantBList.status).toBe(200);
    expect(tenantBList.body).toHaveLength(0);
  });

  it('rejects unauthorized attempts (missing auth and missing settings:update permission)', async () => {
    const noAuthRes = await request(app)
      .put('/api/settings/packs/hvac-v1/activate');

    expect(noAuthRes.status).toBe(401);

    const dispatcherToken = createAuthToken('tenant-a', 'dispatcher');
    const insufficientPermissionRes = await request(app)
      .put('/api/settings/packs/hvac-v1/activate')
      .set(withAuth(dispatcherToken));

    expect(insufficientPermissionRes.status).toBe(403);
    expect(insufficientPermissionRes.body.error).toBe('FORBIDDEN');
  });
});
