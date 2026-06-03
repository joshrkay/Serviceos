import crypto from 'node:crypto';

/**
 * Result of the /metrics auth pre-check. `ok: true` means the route should
 * render metrics; any other value is the HTTP response to send instead.
 *
 * Exported so a focused unit test can assert the auth contract without
 * booting the full app (which requires Pg in prod/staging).
 */
export type MetricsAuthResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, string>; headers?: Record<string, string> };

/**
 * Gate the /metrics endpoint behind a shared bearer token.
 *
 *  - `METRICS_TOKEN` unset + dev/test → unauthenticated scrape allowed
 *    (so local Prometheus and ad-hoc curl keep working).
 *  - `METRICS_TOKEN` unset + prod/staging → 503; refuse rather than
 *    silently degrade to open access on a public hostname.
 *  - `METRICS_TOKEN` set → require an `Authorization: Bearer <token>`
 *    that matches under `crypto.timingSafeEqual`. Anything else → 401
 *    with `WWW-Authenticate: Bearer`.
 *
 * Why a shared token (vs a real OIDC/JWT flow): the scraper is a service,
 * not a user, and the value rotates with the deploy. A token in the
 * Railway env + the matching value in the Prometheus scrape config is the
 * smallest moving piece that still closes the public-enumeration hole.
 *
 * Extracted from app.ts (composition-root decomposition).
 */
export function checkMetricsAuth(
  authorizationHeader: string | undefined,
  envToken: string | undefined,
  nodeEnv: string | undefined,
): MetricsAuthResult {
  const isProdEnv =
    nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging';

  if (!envToken) {
    if (isProdEnv) {
      return {
        ok: false,
        status: 503,
        body: {
          error: 'METRICS_AUTH_NOT_CONFIGURED',
          message: 'METRICS_TOKEN must be set when NODE_ENV is prod/staging.',
        },
      };
    }
    return { ok: true };
  }

  const presented =
    typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')
      ? authorizationHeader.slice('Bearer '.length).trim()
      : '';
  const expectedBuf = Buffer.from(envToken, 'utf8');
  const presentedBuf = Buffer.from(presented, 'utf8');
  // crypto.timingSafeEqual throws when buffers differ in length, so we
  // gate it on a same-length pre-check.
  const tokenOk =
    presentedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(presentedBuf, expectedBuf);

  if (!tokenOk) {
    return {
      ok: false,
      status: 401,
      body: { error: 'UNAUTHORIZED', message: 'Invalid or missing bearer token.' },
      headers: { 'WWW-Authenticate': 'Bearer realm="metrics"' },
    };
  }
  return { ok: true };
}
