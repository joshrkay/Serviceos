/**
 * D-044 / #1768 — the real Express app serves a published tenant site by Host
 * header, ahead of the SPA, and leaves the app domain alone.
 *
 * Boots createApp() hermetically (in-memory repos, dev auth bypass) with
 * TENANT_SITE_BASE_DOMAIN set, publishes through the owner API, then requests
 * "/" under different Host headers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

const BASE = 'sites.example-pages.test';
const ENV_KEYS = ['NODE_ENV', 'DEV_AUTH_BYPASS', 'DATABASE_URL', 'PROCESS_ROLE', 'TENANT_SITE_BASE_DOMAIN', 'WEB_URL'] as const;

describe('tenant site served by Host header', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const auth = `Bearer ${unsignedJwt({
    sub: 'hermetic_dev_owner',
    sid: 'hermetic-session',
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  const owner = (r: request.Test) => r.set('Authorization', auth);

  beforeAll(async () => {
    prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.TENANT_SITE_BASE_DOMAIN = BASE;
    process.env.WEB_URL = 'https://app.example.test';
    delete process.env.DATABASE_URL;
    resetConfig();
    app = createApp();

    // The owner names the business, picks an address and previews it (still unpublished).
    const name = await owner(request(app).put('/api/settings')).send({ businessName: "Joe's Plumbing" });
    expect(name.status).toBe(200);
    const picked = await owner(request(app).put('/api/tenant-site/address')).send({ slug: 'joes-plumbing' });
    expect(picked.status).toBe(200);
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('an unpublished site is a 404 that names no business', async () => {
    const res = await request(app).get('/').set('Host', `joes-plumbing.${BASE}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Joe's Plumbing");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a published site is the server-rendered page, with its own strict CSP', async () => {
    const published = await owner(request(app).post('/api/tenant-site/publish'));
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ slug: 'joes-plumbing', published: true });

    const res = await request(app).get('/').set('Host', `joes-plumbing.${BASE}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain("<title>Joe&#39;s Plumbing</title>");
    expect(res.text).toMatch(/href="https:\/\/app\.example\.test\/intake\?t=/);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    // Publishing filled the checklist's Website item in.
    const settings = await owner(request(app).get('/api/settings'));
    expect(settings.body.websiteUrl ?? settings.body.data?.websiteUrl).toBe(`https://joes-plumbing.${BASE}`);
  });

  it('the page follows the settings with nothing to re-publish', async () => {
    await owner(request(app).put('/api/settings')).send({ businessName: "Joe's Plumbing & Heating" });
    const res = await request(app).get('/').set('Host', `joes-plumbing.${BASE}`);
    expect(res.text).toContain('Joe&#39;s Plumbing &amp; Heating');
  });

  it('an unknown address, the base domain and nested hosts are 404s', async () => {
    for (const host of [`nobody.${BASE}`, BASE, `a.b.${BASE}`, `www.${BASE}`]) {
      const res = await request(app).get('/').set('Host', host);
      expect(res.status, host).toBe(404);
      expect(res.text).not.toContain("Joe's");
    }
  });

  it('only the page is served: other paths 404, writes 405', async () => {
    expect((await request(app).get('/api/customers').set('Host', `joes-plumbing.${BASE}`)).status).toBe(404);
    expect((await request(app).get('/intake').set('Host', `joes-plumbing.${BASE}`)).status).toBe(404);
    const post = await request(app).post('/').set('Host', `joes-plumbing.${BASE}`);
    expect(post.status).toBe(405);
    expect((await request(app).get('/robots.txt').set('Host', `joes-plumbing.${BASE}`)).status).toBe(200);
  });

  it('the app domain is unaffected', async () => {
    const health = await request(app).get('/health').set('Host', 'app.example.test');
    expect(health.status).toBe(200);
    // "/" on the app host is whatever the SPA fallback does, never a tenant page.
    const root = await request(app).get('/').set('Host', 'app.example.test');
    expect(root.text).not.toContain("Joe&#39;s");
    expect(root.headers['content-security-policy'] ?? '').not.toContain("default-src 'none'");
    // A host that merely ends the same way is not the tenant-site domain.
    const lookalike = await request(app).get('/health').set('Host', `evil${BASE}`);
    expect(lookalike.status).toBe(200);
  });

  it('unpublishing takes the site down and clears the website URL it filled in', async () => {
    const down = await owner(request(app).post('/api/tenant-site/unpublish'));
    expect(down.status).toBe(200);
    expect((await request(app).get('/').set('Host', `joes-plumbing.${BASE}`)).status).toBe(404);
    const settings = await owner(request(app).get('/api/settings'));
    expect(settings.body.websiteUrl ?? settings.body.data?.websiteUrl ?? null).toBeNull();
  });
});
