/**
 * D-044 / #1768 — serves a published tenant site by Host header
 * (`<slug>.<TENANT_SITE_BASE_DOMAIN>`), ahead of the SPA static files and
 * catch-all. Hosts outside the tenant-site domain fall straight through, so the
 * app domain is untouched. Mounted only when TENANT_SITE_BASE_DOMAIN is set.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TenantSiteRepository } from './tenant-site';
import { matchTenantSiteHost } from './slug';
import { renderTenantSiteNotFound, renderTenantSitePage } from './render';
import type { TenantSiteView } from './render';

export interface TenantSiteHostDeps {
  baseDomain: string;
  siteRepo: Pick<TenantSiteRepository, 'findPublishedBySlug'>;
  /** The page view for a tenant, or null when it cannot be built. */
  loadView: (tenantId: string) => Promise<TenantSiteView | null>;
  /** Optional per-IP limiter for the unauthenticated lookups. */
  limiter?: RequestHandler | undefined;
}

/**
 * A page that loads no scripts, fonts or images, posts nothing and cannot be
 * framed. Replaces the app's CSP, which is written for the SPA.
 */
const SITE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res: Response, status: number, body: string, cache: string): void {
  res.status(status);
  res.setHeader('Content-Security-Policy', SITE_CSP);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(body);
}

export function createTenantSiteHostMiddleware(deps: TenantSiteHostDeps): RequestHandler {
  const { baseDomain, siteRepo, loadView } = deps;

  async function serve(req: Request, res: Response, slug: string | null): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).end();
      return;
    }
    if (req.path === '/robots.txt') {
      res.type('text/plain').send('User-agent: *\nAllow: /\n');
      return;
    }
    if (slug === null || req.path !== '/') {
      send(res, 404, renderTenantSiteNotFound(), 'no-store');
      return;
    }
    const site = await siteRepo.findPublishedBySlug(slug);
    const view = site ? await loadView(site.tenantId) : null;
    if (!view) {
      send(res, 404, renderTenantSiteNotFound(), 'no-store');
      return;
    }
    send(res, 200, renderTenantSitePage(view), 'public, max-age=60');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const match = matchTenantSiteHost(req.hostname ?? '', baseDomain);
    if (match.kind === 'other') {
      next();
      return;
    }
    const run = () => {
      serve(req, res, match.kind === 'site' ? match.slug : null).catch(next);
    };
    if (deps.limiter && match.kind === 'site') {
      deps.limiter(req, res, (err?: unknown) => (err ? next(err) : run()));
      return;
    }
    run();
  };
}
