/**
 * Public origins — the one place the API decides where "the web app" and
 * "this API" live on the public internet.
 *
 * Every emailed / texted link a human opens (Stripe return, invitation,
 * lifecycle CTAs, OAuth return) must use the WEB origin; every URL a machine
 * calls back (Twilio webhooks, media-stream socket, OAuth redirect_uri) must
 * use the API origin. Before this seam existed, ~40 call sites each decoded
 * APP_PUBLIC_URL / PUBLIC_API_URL / WEB_URL with their own fallback chain, and
 * in production APP_PUBLIC_URL held the API host, so invitation links and
 * email CTAs pointed at serviceosapi-production… instead of the app domain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';

describe('publicOrigins — resolved once by loadConfig()', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('resolves web, api and marketing origins from the canonical variables', () => {
    const config = loadConfig({
      NODE_ENV: 'dev',
      WEB_URL: 'https://app.example.com',
      PUBLIC_API_URL: 'https://api.example.com',
      MARKETING_SITE_URL: 'https://www.example.com',
    });
    expect(config.publicOrigins).toEqual({
      web: 'https://app.example.com',
      api: 'https://api.example.com',
      marketing: 'https://www.example.com',
    });
  });

  it('APP_PUBLIC_URL (deprecated) fills only the web origin and is reported as a boot warning', () => {
    const config = loadConfig({
      NODE_ENV: 'dev',
      APP_PUBLIC_URL: 'https://app.example.com',
    });
    expect(config.publicOrigins.web).toBe('https://app.example.com');
    // It must never leak into the API role: half the old call sites read it as
    // the API host, which is the confusion this seam exists to end.
    expect(config.publicOrigins.api).toBe('http://localhost:3000');
    expect(config.warnings).toEqual([
      expect.stringMatching(/APP_PUBLIC_URL is deprecated.*WEB_URL/),
    ]);
  });

  it('WEB_URL wins over the alias when both are set', () => {
    const config = loadConfig({
      NODE_ENV: 'dev',
      WEB_URL: 'https://app.example.com',
      APP_PUBLIC_URL: 'https://api.example.com',
    });
    expect(config.publicOrigins.web).toBe('https://app.example.com');
  });

  describe('values are origins', () => {
    it('strips a trailing slash so callers can append paths safely', () => {
      const config = loadConfig({
        NODE_ENV: 'dev',
        WEB_URL: 'https://app.example.com/',
        PUBLIC_API_URL: 'https://api.example.com/',
      });
      expect(config.publicOrigins.web).toBe('https://app.example.com');
      expect(config.publicOrigins.api).toBe('https://api.example.com');
    });

    it('rejects a path segment — nothing deploys under a prefix, and a prefix makes every join ambiguous', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'dev', WEB_URL: 'https://app.example.com/app' }),
      ).toThrow(/WEB_URL[\s\S]*origin[\s\S]*no path/);
    });
  });

  describe('production / staging', () => {
    // Everything else validateProductionConfig requires, so a failure here is
    // about the origins and nothing else.
    const prodBase = {
      NODE_ENV: 'prod',
      DATABASE_URL: 'postgres://u:p@h/d',
      CLERK_SECRET_KEY: 'sk_x',
      CLERK_PUBLISHABLE_KEY: 'pk_x',
      CLERK_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_stripe_x',
      AI_PROVIDER_API_KEY: 'ak_x',
      CORS_ORIGIN: 'https://app.example.com',
      TELEPHONY_ENABLED: 'false',
      EMAIL_ENABLED: 'false',
      STORAGE_ENABLED: 'false',
      RLS_RUNTIME_ROLE: 'true',
      TENANT_ENCRYPTION_KEY: 'a'.repeat(64),
    };

    it('refuses to boot when WEB_URL or PUBLIC_API_URL is missing, naming both', () => {
      expect(() => loadConfig(prodBase)).toThrow(/WEB_URL[\s\S]*PUBLIC_API_URL/);
    });

    it('refuses to boot when the web and API origins are the same host', () => {
      // The 2026-09 prod state: APP_PUBLIC_URL held the API host, so every
      // invitation link and email CTA pointed at serviceosapi-production….
      expect(() =>
        loadConfig({
          ...prodBase,
          WEB_URL: 'https://api.example.com',
          PUBLIC_API_URL: 'https://api.example.com',
        }),
      ).toThrow(/WEB_URL[\s\S]*same origin[\s\S]*PUBLIC_API_URL/);
    });

    it('requires https for both origins', () => {
      expect(() =>
        loadConfig({
          ...prodBase,
          WEB_URL: 'http://app.example.com',
          PUBLIC_API_URL: 'https://api.example.com',
        }),
      ).toThrow(/WEB_URL[\s\S]*https/);
    });

    it('boots with both origins set, and the alias only adds a warning', () => {
      const config = loadConfig({
        ...prodBase,
        APP_PUBLIC_URL: 'https://app.example.com',
        PUBLIC_API_URL: 'https://api.example.com',
      });
      expect(config.publicOrigins).toEqual({
        web: 'https://app.example.com',
        api: 'https://api.example.com',
        marketing: 'https://therivetapp.com',
      });
      expect(config.warnings).toHaveLength(1);
    });
  });
});
