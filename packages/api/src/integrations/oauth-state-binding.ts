/**
 * Binds an OAuth `state` nonce to the browser that started the flow.
 *
 * The provider callbacks (Google Calendar, Google Business, QuickBooks) are
 * unauthenticated: the provider redirects the browser there and no app
 * session travels with it. The oauth_states row says which tenant and user
 * minted a state, but on its own it cannot say that the browser presenting
 * the state is the one that minted it. Without that, a consent link started
 * in one session and approved by someone else's browser links the
 * approver's provider account into the starter's tenant.
 *
 * The authenticated connect route therefore sets a short-lived HttpOnly
 * cookie holding the state it minted, and the callback proceeds only when
 * the browser's cookie for that provider holds exactly the state in the
 * query. The state is a random single-use UUID, so the cookie needs no
 * signature: holding the value is the proof. On an https web origin the
 * cookie uses the `__Host-` prefix (Secure, Path=/, no Domain), so a sibling
 * subdomain cannot plant one.
 *
 * Topology: the connect POST goes through the web origin (the SPA calls
 * relative `/api/...` and the web edge proxies it), so the cookie lives on
 * the web host, while the provider's redirect URI is on the API origin
 * (`PUBLIC_API_URL`). A callback that arrives without the cookie on a host
 * other than the web host is redirected once to the same path on the web
 * origin, whose `/api/` proxy forwards it here with the cookie attached. The
 * relay marker stops a second hop, so a browser without the cookie is
 * refused rather than bounced.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { ForbiddenError } from '../shared/errors';

/** The OAuth flows whose callbacks are bound; one cookie per flow. */
export type OAuthBindingProvider = 'google' | 'google_business' | 'quickbooks';

/** Query marker added to a relayed callback so it is relayed at most once. */
export const OAUTH_RELAY_PARAM = 'oauth_relay';

/** Outlives the 5-minute oauth_states expiry; the state, not the cookie, decides. */
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

const UNBOUND_MESSAGE =
  'This connection was started in a different browser or has expired. ' +
  'Start it again from Settings in this browser.';

function isHttpsOrigin(webOrigin: string | undefined): boolean {
  if (!webOrigin) return false;
  try {
    return new URL(webOrigin).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `__Host-` needs Secure, which an http dev origin cannot carry. */
export function oauthStateCookieName(
  provider: OAuthBindingProvider,
  webOrigin: string | undefined,
): string {
  const base = `rivet_oauth_${provider}`;
  return isHttpsOrigin(webOrigin) ? `__Host-${base}` : base;
}

function cookieOptions(webOrigin: string | undefined) {
  return {
    httpOnly: true,
    secure: isHttpsOrigin(webOrigin),
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** Called by the authenticated connect route right after minting `state`. */
export function setOAuthStateCookie(
  res: Response,
  provider: OAuthBindingProvider,
  state: string,
  webOrigin: string | undefined,
): void {
  res.cookie(oauthStateCookieName(provider, webOrigin), state, {
    ...cookieOptions(webOrigin),
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

/** Called by the callback once the state has been spent. */
export function clearOAuthStateCookie(
  res: Response,
  provider: OAuthBindingProvider,
  webOrigin: string | undefined,
): void {
  res.clearCookie(oauthStateCookieName(provider, webOrigin), cookieOptions(webOrigin));
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function relayLocation(req: Request, webOrigin: string): string | undefined {
  const path = req.originalUrl;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return undefined;
  let web: URL;
  let target: URL;
  try {
    web = new URL(webOrigin);
    target = new URL(path, web);
  } catch {
    return undefined;
  }
  if (target.origin !== web.origin) return undefined;
  if (req.hostname === web.hostname) return undefined;
  target.searchParams.set(OAUTH_RELAY_PARAM, '1');
  return target.toString();
}

export type OAuthStateBinding =
  | { kind: 'bound' }
  | { kind: 'unbound' }
  | { kind: 'relay'; location: string };

/**
 * Pure decision for a callback presenting `state`: bound when this browser's
 * cookie for `provider` holds exactly `state`; otherwise a one-time relay to
 * the web origin when the request is on another host; otherwise unbound.
 */
export function checkOAuthStateBinding(
  req: Request,
  provider: OAuthBindingProvider,
  state: string,
  webOrigin: string | undefined,
): OAuthStateBinding {
  if (!state) return { kind: 'unbound' };
  const held = readCookie(req, oauthStateCookieName(provider, webOrigin));
  if (held !== undefined && sameValue(held, state)) return { kind: 'bound' };
  if (req.query[OAUTH_RELAY_PARAM] !== undefined || !webOrigin) return { kind: 'unbound' };
  const location = relayLocation(req, webOrigin);
  return location ? { kind: 'relay', location } : { kind: 'unbound' };
}

/**
 * Callback guard, run BEFORE the state is consumed so a refusal leaves it
 * usable by the browser that started the flow. Returns true when it has
 * already answered with the relay redirect (the caller returns); throws
 * ForbiddenError when the state is not bound to this browser; returns false
 * when the callback may proceed.
 */
export function relayOrRefuseUnboundOAuthState(
  req: Request,
  res: Response,
  provider: OAuthBindingProvider,
  state: string,
  webOrigin: string | undefined,
): boolean {
  const binding = checkOAuthStateBinding(req, provider, state, webOrigin);
  if (binding.kind === 'bound') return false;
  if (binding.kind === 'relay') {
    res.redirect(binding.location);
    return true;
  }
  throw new ForbiddenError(UNBOUND_MESSAGE);
}
