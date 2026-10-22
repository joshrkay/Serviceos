/**
 * #1770 — the Host middleware's connected-domain path: the app's own hosts and
 * IPs are never looked up, misses are cached briefly, live sites are not, and
 * the limiter applies only once a host is a connected domain.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createTenantSiteHostMiddleware } from '../../src/tenant-site/host-middleware';
import type { TenantSite } from '../../src/tenant-site/tenant-site';
import type { TenantSiteView } from '../../src/tenant-site/render';

const BASE = 'sites.example-pages.test';
const DOMAIN = 'www.joesplumbing.test';

const site = { tenantId: 't1', slug: 'joes' } as TenantSite;
const view: TenantSiteView = {
  businessName: "Joe's Plumbing",
  services: [],
  serviceArea: null,
  hoursSummary: null,
  phone: null,
  aboutText: null,
  requestUrl: 'https://app.example.test/intake?t=t1',
  bookUrl: 'https://app.example.test/book?t=t1',
};

function build(opts: { live?: () => TenantSite | null; limiter?: express.RequestHandler; domainCacheMs?: number; now?: () => number } = {}) {
  const findPublishedByDomain = vi.fn(async (_host: string) => (opts.live ?? (() => null))());
  const app = express();
  app.use(
    createTenantSiteHostMiddleware({
      baseDomain: BASE,
      siteRepo: { findPublishedBySlug: async () => null, findPublishedByDomain },
      loadView: async () => view,
      appHosts: ['app.example.test'],
      ...(opts.limiter ? { limiter: opts.limiter } : {}),
      ...(opts.domainCacheMs !== undefined ? { domainCacheMs: opts.domainCacheMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );
  app.use((_req, res) => res.status(200).send('app'));
  return { app, findPublishedByDomain };
}

describe('connected-domain host lookup', () => {
  it('serves a live connected domain and falls through for anything else', async () => {
    const { app } = build({ live: () => site });
    const res = await request(app).get('/').set('Host', DOMAIN);
    expect(res.text).toContain('Joe&#39;s Plumbing');
    const none = build();
    expect((await request(none.app).get('/').set('Host', DOMAIN)).text).toBe('app');
  });

  it('never looks up the app host, IPs or single-label hosts', async () => {
    const { app, findPublishedByDomain } = build({ live: () => site });
    for (const host of ['app.example.test', '127.0.0.1', 'localhost']) {
      expect((await request(app).get('/').set('Host', host)).text, host).toBe('app');
    }
    expect(findPublishedByDomain).not.toHaveBeenCalled();
  });

  it('remembers a miss for the window but reads a live site fresh every time', async () => {
    let clock = 1_000;
    let live: TenantSite | null = null;
    const { app, findPublishedByDomain } = build({ live: () => live, now: () => clock });
    await request(app).get('/').set('Host', DOMAIN);
    await request(app).get('/').set('Host', DOMAIN);
    expect(findPublishedByDomain).toHaveBeenCalledTimes(1); // second miss was cached

    clock += 31_000;
    live = site;
    expect((await request(app).get('/').set('Host', DOMAIN)).text).toContain('Joe&#39;s');
    await request(app).get('/').set('Host', DOMAIN);
    expect(findPublishedByDomain).toHaveBeenCalledTimes(3); // hits are not cached
    live = null;
    expect((await request(app).get('/').set('Host', DOMAIN)).text).toBe('app'); // down at once
  });

  it('rate-limits only connected-domain traffic, not other hosts that fall through', async () => {
    const limiter = vi.fn<express.RequestHandler>((_req, res) => {
      res.status(429).send('slow down');
    });
    const { app } = build({ live: () => site, limiter });
    expect((await request(app).get('/').set('Host', DOMAIN)).status).toBe(429);

    const miss = build({ limiter });
    expect((await request(miss.app).get('/').set('Host', 'alias.up.railway.test')).text).toBe('app');
    expect(limiter).toHaveBeenCalledTimes(1);
  });
});
