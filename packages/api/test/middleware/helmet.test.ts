/**
 * D1-3 — helmet middleware hardening.
 *
 * The pre-launch security audit (docs/pre-launch-hardening-2026-05-16.md)
 * flagged the API as missing CSP / HSTS / X-Frame-Options / nosniff /
 * referrer-policy headers. `buildHelmetOptions()` (in src/app.ts) is the
 * single source of truth for those headers and is wired in `createApp()`
 * via `app.use(helmet(buildHelmetOptions(isProd)))`.
 *
 * These tests assert the contract that audit cares about:
 *
 *  - In production, every response carries CSP + HSTS + nosniff + frame-DENY.
 *  - In dev/test, CSP is suppressed so Vite HMR / local tooling keep working,
 *    but the rest of the hardening headers still apply.
 *
 * We mount the middleware on a stand-alone express app (not `createApp()`)
 * because the full app requires a real Pg pool + a full set of production
 * secrets when NODE_ENV=production, which is out of scope for a header test.
 */
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildHelmetOptions } from '../../src/app';

function makeApp(isProd: boolean): express.Express {
  const app = express();
  app.use(helmet(buildHelmetOptions(isProd)));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

describe('D1-3 — helmet hardening headers', () => {
  describe('production (NODE_ENV=production)', () => {
    const app = makeApp(true);

    it('emits a Content-Security-Policy header', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      // Spot-check a handful of directives the audit explicitly required.
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain('https://js.stripe.com');
      expect(csp).toContain('https://*.clerk.com');
      expect(csp).toContain('https://api.stripe.com');
      // 2026-10 hardening sweep: sources the web app never loads stay OUT
      // of the allowlist (and keep this CSP identical to the nginx edge's).
      expect(csp).not.toContain('sentry.io');
      expect(csp).not.toContain('twilio');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      // PostHog analytics — without these in connect-src (and the assets host
      // in script-src) posthog-js is silently CSP-blocked in prod and NO
      // browser events reach PostHog even with the key configured.
      expect(csp).toContain('https://us.i.posthog.com');
      expect(csp).toContain('https://us-assets.i.posthog.com');
    });

    it('allows PostHog ingestion in connect-src (else browser events are CSP-blocked)', async () => {
      const res = await request(app).get('/health');
      const csp = res.headers['content-security-policy'] ?? '';
      const connectDirective =
        csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
      expect(connectDirective).toContain('https://us.i.posthog.com');
      expect(connectDirective).toContain('https://us-assets.i.posthog.com');
    });

    it('allows the production Clerk Frontend API host + Turnstile origins (else /login and /signup render blank)', async () => {
      // The pk_live_ publishable key encodes the Frontend API host
      // clerk.therivetapp.com — a custom domain, so neither *.clerk.com nor
      // *.clerk.accounts.dev matches it. clerk-js itself is loaded from that
      // host (/npm/@clerk/clerk-js@…), so a script-src miss blanks every auth
      // page. Sign-up bot protection is Cloudflare Turnstile (script + iframe).
      const res = await request(app).get('/health');
      const csp = res.headers['content-security-policy'] ?? '';
      const directive = (name: string) =>
        csp.split(';').find((d) => d.trim().startsWith(name)) ?? '';
      expect(directive('script-src')).toContain('https://clerk.therivetapp.com');
      expect(directive('connect-src')).toContain('https://clerk.therivetapp.com');
      expect(directive('script-src')).toContain('https://challenges.cloudflare.com');
      expect(directive('frame-src')).toContain('https://challenges.cloudflare.com');
      expect(directive('script-src')).toContain('https://*.protect.clerk.com');
      expect(directive('connect-src')).toContain('https://*.protect.clerk.com:*');
      expect(directive('frame-src')).toContain('https://*.protect.clerk.com');
    });

    it('allows the Deepgram STT WebSocket in connect-src (else in-app voice dictation is CSP-blocked)', async () => {
      // The browser streams mic audio straight to wss://api.deepgram.com/v1/
      // listen (useDeepgramDictation). connect-src governs WebSocket targets,
      // so without this the assistant's conversation/dictation mode fails in
      // production even with DEEPGRAM_API_KEY configured server-side.
      const res = await request(app).get('/health');
      const csp = res.headers['content-security-policy'] ?? '';
      const connectDirective =
        csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
      expect(connectDirective).toContain('wss://api.deepgram.com');
    });

    it('emits Strict-Transport-Security = 1 year + includeSubDomains, no preload', async () => {
      const res = await request(app).get('/health');
      const hsts = res.headers['strict-transport-security'];
      expect(hsts).toBeTruthy();
      // 1 year in seconds = 31536000
      expect(hsts).toContain('max-age=31536000');
      expect(hsts).toContain('includeSubDomains');
      expect(hsts).not.toContain('preload');
    });

    it('emits X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('emits X-Frame-Options: DENY', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('emits Referrer-Policy: no-referrer', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('does NOT emit Cross-Origin-Embedder-Policy (would break Stripe Elements)', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    });
  });

  describe('development (NODE_ENV !== production)', () => {
    const app = makeApp(false);

    it('does NOT emit a Content-Security-Policy header (Vite HMR-friendly)', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('still emits the other hardening headers (HSTS / nosniff / frame DENY / no-referrer)', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['strict-transport-security']).toBeTruthy();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });
});

describe('D1-3 — static frontend is served behind helmet', () => {
  // createApp() needs a live Pg pool + prod secrets, so pin the mount
  // order in source: express.static mounted before helmet() serves `/`
  // and index.html with no CSP / frame-ancestors / HSTS.
  it('mounts express.static(frontendPath) after helmet()', () => {
    const src = readFileSync(join(__dirname, '../../src/app.ts'), 'utf8');
    const helmetAt = src.indexOf('app.use(helmet(buildHelmetOptions(isProd)))');
    const staticAt = src.indexOf('app.use(express.static(frontendPath))');
    expect(helmetAt).toBeGreaterThan(-1);
    expect(staticAt).toBeGreaterThan(helmetAt);
  });
});

describe('D1-3 — API CSP covers the SPA shell it serves', () => {
  // The API serves packages/web/dist (index.html + assets) behind helmet, so
  // every source the nginx edge allows for the SPA (e.g. the Pendo loader's
  // inline-script hash and CDN) must be allowed here too, or those pages
  // break only when served from the API host.
  it('allows every source the web edge CSP (security-headers.conf) allows', () => {
    const conf = readFileSync(join(__dirname, '../../../web/security-headers.conf'), 'utf8');
    const edge = conf.match(/Content-Security-Policy "([^"]+)"/)?.[1];
    expect(edge).toBeTruthy();
    const directives = (buildHelmetOptions(true) as any).contentSecurityPolicy.directives as Record<
      string,
      string[]
    >;
    const api = new Map(
      Object.entries(directives).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v]),
    );
    const missing: string[] = [];
    for (const part of edge!.split(';').map((p) => p.trim()).filter(Boolean)) {
      const [name, ...sources] = part.split(/\s+/);
      for (const src of sources) {
        if (!(api.get(name) ?? []).includes(src)) missing.push(`${name} ${src}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
