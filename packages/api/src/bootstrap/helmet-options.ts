import helmet from 'helmet';

/**
 * D1-3 — helmet hardening options factory.
 *
 * Extracted from app.ts (composition-root decomposition). Exported separately
 * so the middleware test can assert header behaviour without booting the full
 * app (which would require a real Pg pool and a full set of production secrets
 * when NODE_ENV=production).
 *
 * Production behaviour:
 *   - CSP whitelists the production frontend's external deps: Clerk
 *     (auth UI + JS), Stripe Elements, Twilio Voice JS SDK, Sentry browser
 *     SDK.
 *   - HSTS = 1 year, includeSubDomains, preload=false (preload list
 *     submission must be a deliberate human action).
 *   - X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy
 *     no-referrer.
 *   - crossOriginEmbedderPolicy is DISABLED because COEP=require-corp breaks
 *     Stripe Elements (cross-origin frames without CORP headers).
 *
 * Dev/test behaviour:
 *   - CSP disabled so Vite HMR / local tooling keep working. Other helmet
 *     defaults (nosniff, HSTS, frame deny, no-referrer) still apply.
 */
export function buildHelmetOptions(isProd: boolean): Parameters<typeof helmet>[0] {
  return {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              'https://js.stripe.com',
              'https://*.clerk.com',
              'https://*.clerk.accounts.dev',
              'https://clerk.com',
              'https://sdk.twilio.com',
              'https://media.twiliocdn.com',
              // PostHog analytics: posthog-js lazy-loads optional modules
              // (surveys, web-vitals, exception capture) from the assets host.
              'https://us-assets.i.posthog.com',
            ],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              'https://*.clerk.com',
              'https://clerk.com',
            ],
            imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
            connectSrc: [
              "'self'",
              'https://api.stripe.com',
              'https://*.clerk.com',
              'https://clerk.com',
              'https://*.clerk.accounts.dev',
              'wss://*.twilio.com',
              'https://*.twilio.com',
              // Live voice dictation streams mic audio from the browser
              // straight to Deepgram's realtime STT WebSocket (see the web
              // useDeepgramDictation hook — it opens wss://api.deepgram.com/v1/
              // listen with a short-lived grant token). Without this in
              // connect-src, production CSP blocks that WebSocket and the
              // assistant's conversation/dictation mode fails with "Lost the
              // dictation connection. Please try again."
              'wss://api.deepgram.com',
              'https://*.ingest.sentry.io',
              'https://*.ingest.us.sentry.io',
              // PostHog analytics (US cloud): event ingestion + remote config.
              // Without these, posthog-js is silently blocked by CSP in prod
              // and no browser events reach PostHog even with the key set.
              // Matches the default VITE_POSTHOG_HOST (us.i.posthog.com); a
              // custom host would need to be added here too.
              'https://us.i.posthog.com',
              'https://us-assets.i.posthog.com',
            ],
            frameSrc: [
              "'self'",
              'https://js.stripe.com',
              'https://hooks.stripe.com',
              'https://*.clerk.com',
            ],
            workerSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 365,
      includeSubDomains: true,
      preload: false,
    },
    noSniff: true,
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  };
}
