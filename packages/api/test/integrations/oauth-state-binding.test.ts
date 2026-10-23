import express, { Request, Response } from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import {
  checkOAuthStateBinding,
  clearOAuthStateCookie,
  oauthStateCookieName,
  OAUTH_RELAY_PARAM,
  relayOrRefuseUnboundOAuthState,
  setOAuthStateCookie,
  type OAuthBindingProvider,
} from '../../src/integrations/oauth-state-binding';
import { ForbiddenError } from '../../src/shared/errors';

const WEB = 'https://app.example.com';
const STATE = '7b0a2f8e-3c55-4b8e-9d0e-2a1f6c3b9e41';

function fakeReq(opts: { hostname: string; cookie?: string; originalUrl?: string; relayed?: boolean }): Request {
  const query: Record<string, string> = { code: 'c', state: STATE };
  if (opts.relayed) query[OAUTH_RELAY_PARAM] = '1';
  return {
    hostname: opts.hostname,
    headers: opts.cookie === undefined ? {} : { cookie: opts.cookie },
    originalUrl:
      opts.originalUrl ??
      `/api/calendar-integrations/google/callback?code=c&state=${STATE}${opts.relayed ? `&${OAUTH_RELAY_PARAM}=1` : ''}`,
    query,
  } as unknown as Request;
}

describe('oauthStateCookieName', () => {
  it('uses the __Host- prefix when the web origin is https', () => {
    expect(oauthStateCookieName('google', WEB)).toBe('__Host-rivet_oauth_google');
    expect(oauthStateCookieName('quickbooks', WEB)).toBe('__Host-rivet_oauth_quickbooks');
  });
  it('drops the prefix (which requires Secure) for an http dev origin or none', () => {
    expect(oauthStateCookieName('google_business', 'http://localhost:5173')).toBe(
      'rivet_oauth_google_business',
    );
    expect(oauthStateCookieName('google', undefined)).toBe('rivet_oauth_google');
  });
});

describe('setOAuthStateCookie / clearOAuthStateCookie', () => {
  function appWith(fn: (res: Response) => void) {
    const app = express();
    app.get('/x', (_req, res) => {
      fn(res);
      res.json({ ok: true });
    });
    return app;
  }

  it('sets a host-only HttpOnly, Secure, SameSite=Lax cookie holding the state, valid for 10 minutes', async () => {
    const res = await request(appWith((r) => setOAuthStateCookie(r, 'google', STATE, WEB))).get('/x');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`__Host-rivet_oauth_google=${STATE}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('omits Secure for an http dev origin', async () => {
    const res = await request(
      appWith((r) => setOAuthStateCookie(r, 'google', STATE, 'http://localhost:5173')),
    ).get('/x');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`rivet_oauth_google=${STATE}`);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('clears the cookie with the same name and attributes', async () => {
    const res = await request(appWith((r) => clearOAuthStateCookie(r, 'quickbooks', WEB))).get('/x');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('__Host-rivet_oauth_quickbooks=;');
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookie).toMatch(/Path=\//);
  });
});

describe('checkOAuthStateBinding', () => {
  const name = (p: OAuthBindingProvider) => oauthStateCookieName(p, WEB);

  it('is bound when this browser holds the cookie for exactly this state', () => {
    const req = fakeReq({ hostname: 'app.example.com', cookie: `other=1; ${name('google')}=${STATE}` });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'bound' });
  });

  it('is bound on the callback host too when the cookie reaches it (single-host deploys)', () => {
    const req = fakeReq({ hostname: 'api.example.com', cookie: `${name('google')}=${STATE}` });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'bound' });
  });

  it("is unbound when the browser's cookie names a different state (another user's flow)", () => {
    const req = fakeReq({
      hostname: 'app.example.com',
      cookie: `${name('google')}=0e1d2c3b-4a59-4687-9a0b-c1d2e3f4a5b6`,
    });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'unbound' });
  });

  it("does not accept another provider's cookie", () => {
    const req = fakeReq({ hostname: 'app.example.com', cookie: `${name('google_business')}=${STATE}` });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'unbound' });
  });

  it('is unbound with no cookie on the web host', () => {
    expect(checkOAuthStateBinding(fakeReq({ hostname: 'app.example.com' }), 'google', STATE, WEB)).toEqual({
      kind: 'unbound',
    });
  });

  it('relays a cookie-less callback from the API host to the same path on the web origin, once', () => {
    const binding = checkOAuthStateBinding(fakeReq({ hostname: 'api.example.com' }), 'google', STATE, WEB);
    expect(binding.kind).toBe('relay');
    const location = new URL((binding as { location: string }).location);
    expect(location.origin).toBe(WEB);
    expect(location.pathname).toBe('/api/calendar-integrations/google/callback');
    expect(location.searchParams.get('code')).toBe('c');
    expect(location.searchParams.get('state')).toBe(STATE);
    expect(location.searchParams.get(OAUTH_RELAY_PARAM)).toBe('1');
  });

  it('does not relay a second time (no loop when the host still differs)', () => {
    const req = fakeReq({ hostname: 'api.example.com', relayed: true });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'unbound' });
  });

  it('never relays off the web origin', () => {
    const req = fakeReq({ hostname: 'api.example.com', originalUrl: `//evil.example/x?state=${STATE}` });
    expect(checkOAuthStateBinding(req, 'google', STATE, WEB)).toEqual({ kind: 'unbound' });
  });

  it('does not relay when no web origin is configured', () => {
    expect(checkOAuthStateBinding(fakeReq({ hostname: 'api.example.com' }), 'google', STATE, undefined)).toEqual(
      { kind: 'unbound' },
    );
  });

  it('is unbound for an empty state or a malformed cookie header', () => {
    expect(
      checkOAuthStateBinding(
        fakeReq({ hostname: 'app.example.com', cookie: `${name('google')}=` }),
        'google',
        '',
        WEB,
      ),
    ).toEqual({ kind: 'unbound' });
    expect(
      checkOAuthStateBinding(
        fakeReq({ hostname: 'app.example.com', cookie: `${name('google')}=%E0%A4%A` }),
        'google',
        STATE,
        WEB,
      ),
    ).toEqual({ kind: 'unbound' });
  });
});

describe('relayOrRefuseUnboundOAuthState', () => {
  function fakeRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }
  const cookie = `${oauthStateCookieName('quickbooks', WEB)}=${STATE}`;

  it('lets a bound callback proceed without answering', () => {
    const { res, redirect } = fakeRes();
    const req = fakeReq({ hostname: 'api.example.com', cookie });
    expect(relayOrRefuseUnboundOAuthState(req, res, 'quickbooks', STATE, WEB)).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers a relayable callback with the redirect and tells the caller to stop', () => {
    const { res, redirect } = fakeRes();
    const req = fakeReq({ hostname: 'api.example.com' });
    expect(relayOrRefuseUnboundOAuthState(req, res, 'quickbooks', STATE, WEB)).toBe(true);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(new URL(redirect.mock.calls[0][0] as string).origin).toBe(WEB);
  });

  it('throws a 403 for an unbound callback, with copy that tells the owner what to do', () => {
    const { res, redirect } = fakeRes();
    const req = fakeReq({ hostname: 'app.example.com' });
    let thrown: unknown;
    try {
      relayOrRefuseUnboundOAuthState(req, res, 'quickbooks', STATE, WEB);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as ForbiddenError).statusCode).toBe(403);
    expect((thrown as ForbiddenError).message).toMatch(/Start it again from Settings/);
    expect((thrown as ForbiddenError).message).not.toMatch(/\b(AI|proposal|agent|verify|provisioning)\b/i);
    expect(redirect).not.toHaveBeenCalled();
  });
});
