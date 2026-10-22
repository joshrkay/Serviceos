/**
 * D-044 / #1768 — serves a published tenant site by Host header
 * (`<slug>.<TENANT_SITE_BASE_DOMAIN>`), ahead of the SPA static files and
 * catch-all. Hosts outside the tenant-site domain fall straight through, so the
 * app domain is untouched. Mounted only when TENANT_SITE_BASE_DOMAIN is set.
 *
 * #1770 — a VERIFIED connected domain (the owner's own, CNAMEd to their site
 * address) is served the same way. Other hosts are looked up once per
 * `domainCacheMs` (misses only, capped), and the app's own hostnames never
 * are, so ordinary app traffic costs no query.
 */
import { isIP } from 'net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TenantSite, TenantSiteRepository } from './tenant-site';
import { matchTenantSiteHost } from './slug';
import { renderTenantSiteNotFound, renderTenantSitePage } from './render';
import type { TenantSiteView } from './render';

export interface TenantSiteHostDeps {
  baseDomain: string;
  siteRepo: Pick<TenantSiteRepository, 'findPublishedBySlug' | 'findPublishedByDomain'>;
  /** The page view for a tenant, or null when it cannot be built. */
  loadView: (tenantId: string) => Promise<TenantSiteView | null>;
  /** Optional per-IP limiter for the unauthenticated lookups. */
  limiter?: RequestHandler | undefined;
  /** The app's own hostnames (web, API): never looked up as connected domains. */
  appHosts?: readonly string[];
  /** How long a "not a connected domain" lookup is remembered. Default 30s; 0 disables. */
  domainCacheMs?: number;
  now?: () => number;
}

/**
 * A page that loads no scripts, fonts or images, posts nothing and cannot be
 * framed. Replaces the app's CSP, which is written for the SPA.
 */
const SITE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const DOMAIN_CACHE_MAX = 500;

function send(res: Response, status: number, body: string, cache: string): void {
  res.status(status);
  res.setHeader('Content-Security-Policy', SITE_CSP);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(body);
}

type FindSite = () => Promise<TenantSite | null>;

export function createTenantSiteHostMiddleware(deps: TenantSiteHostDeps): RequestHandler {
  const { baseDomain, siteRepo, loadView } = deps;
  const appHosts = new Set((deps.appHosts ?? []).map((h) => h.toLowerCase()));
  const cacheMs = deps.domainCacheMs ?? 30_000;
  const clock = deps.now ?? Date.now;
  // Only MISSES are remembered: a live site is read fresh every request (so
  // unpublishing or disconnecting takes effect at once, like the slug lookup),
  // while hosts that are not connected domains cost one query per window.
  const missCache = new Map<string, number>();

  async function lookupDomain(host: string): Promise<TenantSite | null> {
    const missUntil = missCache.get(host);
    if (missUntil !== undefined && missUntil > clock()) return null;
    const site = await siteRepo.findPublishedByDomain(host);
    if (!site && cacheMs > 0) {
      // Host headers are caller-chosen, so the cache is bounded.
      if (missCache.size >= DOMAIN_CACHE_MAX) missCache.clear();
      missCache.set(host, clock() + cacheMs);
    }
    return site;
  }

  /** `find` resolves the live site; null means the host can never name one. */
  async function serve(req: Request, res: Response, find: FindSite | null): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).end();
      return;
    }
    if (req.path === '/robots.txt') {
      res.type('text/plain').send('User-agent: *\nAllow: /\n');
      return;
    }
    if (find === null || req.path !== '/') {
      send(res, 404, renderTenantSiteNotFound(), 'no-store');
      return;
    }
    const site = await find();
    const view = site ? await loadView(site.tenantId) : null;
    if (!view) {
      send(res, 404, renderTenantSiteNotFound(), 'no-store');
      return;
    }
    send(res, 200, renderTenantSitePage(view), 'public, max-age=60');
  }

  /** The request's host when it might be a connected domain, or null when it cannot be. */
  function connectedDomainHost(hostname: string): string | null {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || isIP(host) !== 0 || appHosts.has(host)) return null;
    return host;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const hostname = req.hostname ?? '';
    const match = matchTenantSiteHost(hostname, baseDomain);

    const limit = (run: () => void): void => {
      if (deps.limiter) deps.limiter(req, res, (err?: unknown) => (err ? next(err) : run()));
      else run();
    };

    if (match.kind === 'other') {
      const host = connectedDomainHost(hostname);
      if (host === null) {
        next();
        return;
      }
      // Neither the app's nor under the tenant-site domain: ours only if it is a verified connected
      // domain. The limiter comes after the lookup so other hosts' app traffic is never throttled.
      lookupDomain(host)
        .then((site) => {
          if (!site) return next();
          limit(() => {
            serve(req, res, async () => site).catch(next);
          });
        })
        .catch(next);
      return;
    }

    const find: FindSite | null = match.kind === 'site' ? () => siteRepo.findPublishedBySlug(match.slug) : null;
    const run = () => {
      serve(req, res, find).catch(next);
    };
    if (match.kind === 'site') limit(run);
    else run();
  };
}
