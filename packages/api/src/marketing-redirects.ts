import type { Express } from 'express';

/**
 * Canonical marketing site. The public marketing/legal pages moved off the
 * app domain (app.therivetapp.com) to their own standalone site; the app
 * only serves the product + auth + customer-facing token pages now.
 */
export const MARKETING_SITE_URL = 'https://therivetapp.com';

/**
 * Paths that used to be rendered by the in-app marketing surface (the
 * standalone marketing/legal SPA routes). They now live on the marketing
 * site, so the app permanently forwards them there path-for-path
 * (app.therivetapp.com/pricing → therivetapp.com/pricing). This keeps any
 * stray inbound links, bookmarks, and search-indexed URLs working and
 * consolidates them onto the canonical domain.
 *
 * 302 (not 301) on purpose: the destination pages are managed on a separate
 * deploy, so a temporary redirect avoids browsers permanently caching a
 * target we don't control. Promote to 301 once the marketing site's pages
 * are confirmed live and stable.
 */
export const MARKETING_REDIRECT_PATHS = [
  '/features',
  '/pricing',
  '/about',
  '/download',
  '/privacy',
  '/terms',
] as const;

/**
 * Register the marketing-path redirects. Must be mounted BEFORE the SPA
 * catch-all (`app.get('*')`) so these paths forward to the marketing site
 * instead of falling through to index.html. None of these collide with an
 * API route, so an unconditional GET redirect is safe.
 */
export function registerMarketingRedirects(app: Express): void {
  for (const path of MARKETING_REDIRECT_PATHS) {
    app.get(path, (req, res) => {
      // Redirect with the full original URI (path + query string) so campaign
      // / attribution params (utm_*, gclid, …) survive the hop. The
      // destination host is fixed, so appending untrusted query data can't
      // become an open redirect. Matches the nginx edge, which uses
      // $request_uri.
      res.redirect(302, `${MARKETING_SITE_URL}${req.originalUrl}`);
    });
  }
}
