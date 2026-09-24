/**
 * Public URL builder — the one way to turn a role + path into an absolute
 * URL. Origins are resolved once by loadConfig() (config.publicOrigins):
 *
 *   web        where humans open the SPA (Stripe return, invitations,
 *              lifecycle-email CTAs, OAuth return, /e /pay /feedback links)
 *   api        where machines call this API back (Twilio webhooks and
 *              signature checks, media-stream socket, OAuth redirect_uri)
 *   marketing  the standalone marketing site
 *
 * Callers never concatenate origins or hand-roll `?a=b` strings; the joining
 * and query encoding live here.
 */
import { loadConfig, type PublicOrigins } from './config';

export type PublicOriginRole = keyof PublicOrigins;

export type PublicUrlQuery = Record<string, string | number | boolean | null | undefined>;

export function publicUrl(role: PublicOriginRole, path: string, query?: PublicUrlQuery): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    // A relative path would resolve against whatever the caller happened to
    // pass; a protocol-relative one (`//host/x`) would REPLACE the origin.
    // Either way the link no longer points where the role says it does.
    throw new Error(`publicUrl: path must start with "/" and not "//"; got ${JSON.stringify(path)}`);
  }
  const origin = loadConfig().publicOrigins[role];
  const url = new URL(path, origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
