/**
 * D-044 / #1770 — the real Express app serves a VERIFIED connected domain by
 * Host header, and only that one.
 *
 * Boots createApp() hermetically (in-memory repos, dev auth bypass) with the
 * Railway provider switched on against a stubbed Railway API and a stubbed DNS
 * resolver: the owner connects a domain through the API, the check verifies
 * it, and then "/" under that Host is the tenant page.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

const dnsState = vi.hoisted(() => ({ cnames: {} as Record<string, string[]> }));

vi.mock('../../src/tenant-site/custom-domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tenant-site/custom-domain')>();
  return { ...actual, createNodeDnsResolver: () => ({ resolveCname: async (host: string) => dnsState.cnames[host] ?? [] }) };
});

import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

const BASE = 'sites.example-pages.test';
const DOMAIN = 'www.joesplumbing.test';
const ENV_KEYS = [
  'NODE_ENV',
  'DEV_AUTH_BYPASS',
  'DATABASE_URL',
  'PROCESS_ROLE',
  'TENANT_SITE_BASE_DOMAIN',
  'WEB_URL',
  'RAILWAY_API_TOKEN',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'TENANT_SITE_RAILWAY_SERVICE_ID',
] as const;

describe('connected domain served by Host header', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  let certificateStatus = 'CERTIFICATE_STATUS_TYPE_PENDING';
  const realFetch = globalThis.fetch;
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
    process.env.RAILWAY_API_TOKEN = 'tok';
    process.env.RAILWAY_PROJECT_ID = 'proj';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env';
    process.env.TENANT_SITE_RAILWAY_SERVICE_ID = 'svc';
    delete process.env.DATABASE_URL;
    resetConfig();

    // Railway's GraphQL API, stubbed; everything else passes through.
    vi.stubGlobal('fetch', (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('railway.com')) return realFetch(url as string, init);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const data = query.includes('customDomainCreate')
        ? { customDomainCreate: { id: 'cd-1' } }
        : { customDomain: { status: { certificateStatus } } };
      return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch);

    app = createApp();
    expect((await owner(request(app).put('/api/settings')).send({ businessName: "Joe's Plumbing" })).status).toBe(200);
    expect((await owner(request(app).put('/api/tenant-site/address')).send({ slug: 'joes-plumbing' })).status).toBe(200);
    expect((await owner(request(app).post('/api/tenant-site/publish'))).status).toBe(200);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a claimed domain whose CNAME is missing is not served (the unit test covers the unverified lookup)', async () => {
    const claimed = await owner(request(app).put('/api/tenant-site/domain')).send({ domain: DOMAIN });
    expect(claimed.status).toBe(200);
    expect(claimed.body.data.domain).toMatchObject({ status: 'pending_dns', error: { code: 'dns_missing' } });
    // A different, never-connected host falls through to the app.
    const other = await request(app).get('/health').set('Host', 'www.not-connected.test');
    expect(other.status).toBe(200);
  });

  it('once verified, "/" on that host is the tenant page with its strict CSP; other paths 404', async () => {
    dnsState.cnames[DOMAIN] = [`joes-plumbing.${BASE}`];
    const waiting = await owner(request(app).post('/api/tenant-site/domain/check'));
    expect(waiting.body.data.domain).toMatchObject({ status: 'pending_certificate' });

    certificateStatus = 'CERTIFICATE_STATUS_TYPE_VALID';
    const done = await owner(request(app).post('/api/tenant-site/domain/check'));
    expect(done.body.data.domain).toMatchObject({ status: 'verified', verified: true });

    // The website setting switched to the connected domain.
    const settings = await owner(request(app).get('/api/settings'));
    expect(settings.body.websiteUrl ?? settings.body.data?.websiteUrl).toBe(`https://${DOMAIN}`);

    const res = await request(app).get('/').set('Host', DOMAIN);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Joe&#39;s Plumbing</title>');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    expect((await request(app).get('/api/customers').set('Host', DOMAIN)).status).toBe(404);
    expect((await request(app).post('/').set('Host', DOMAIN)).status).toBe(405);
    // Host matching is exact: a sibling host is not served.
    expect((await request(app).get('/').set('Host', `evil.${DOMAIN}`)).text).not.toContain("Joe&#39;s");
    // The tenant-site address keeps working beside it.
    expect((await request(app).get('/').set('Host', `joes-plumbing.${BASE}`)).status).toBe(200);
  });

  it('unpublishing takes the connected domain down too', async () => {
    await owner(request(app).post('/api/tenant-site/unpublish'));
    // The 30s lookup cache is for hits and misses alike; the page itself is only served when still live.
    const res = await request(app).get('/').set('Host', DOMAIN);
    expect(res.text).not.toContain("Joe&#39;s Plumbing</title>");
  });
});
