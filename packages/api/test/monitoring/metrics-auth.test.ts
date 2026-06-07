/**
 * Blocker — /metrics auth.
 *
 * The /metrics endpoint exposes tenant ids, request volumes, and pool
 * counts. Pre-fix it was anonymous on a public hostname. `checkMetricsAuth`
 * is the gate; this suite asserts the three branches:
 *
 *   1. Token unset in dev/test → allowed (so local Prometheus keeps working).
 *   2. Token unset in prod/staging → 503 (refuse rather than degrade).
 *   3. Token set → require `Authorization: Bearer <token>` matching under
 *      `crypto.timingSafeEqual`. Wrong/missing/length-mismatched tokens →
 *      401 with `WWW-Authenticate: Bearer`.
 */

import { describe, it, expect } from 'vitest';
import { checkMetricsAuth } from '../../src/app';

describe('checkMetricsAuth', () => {
  describe('METRICS_TOKEN unset', () => {
    it('allows the scrape in development', () => {
      expect(checkMetricsAuth(undefined, undefined, 'development')).toEqual({ ok: true });
    });

    it('allows the scrape in test', () => {
      expect(checkMetricsAuth(undefined, undefined, 'test')).toEqual({ ok: true });
    });

    it('refuses with 503 in production', () => {
      const result = checkMetricsAuth(undefined, undefined, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(503);
      expect(result.body.error).toBe('METRICS_AUTH_NOT_CONFIGURED');
    });

    it('refuses with 503 when NODE_ENV is the short prod alias', () => {
      const result = checkMetricsAuth(undefined, undefined, 'prod');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(503);
    });

    it('refuses with 503 in staging too', () => {
      const result = checkMetricsAuth(undefined, undefined, 'staging');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(503);
    });
  });

  describe('METRICS_TOKEN set', () => {
    const TOKEN = 'super-secret-prom-token';

    it('accepts a matching Authorization: Bearer header', () => {
      expect(checkMetricsAuth(`Bearer ${TOKEN}`, TOKEN, 'production')).toEqual({ ok: true });
    });

    it('rejects a missing Authorization header (401 + WWW-Authenticate)', () => {
      const result = checkMetricsAuth(undefined, TOKEN, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
      expect(result.headers?.['WWW-Authenticate']).toBe('Bearer realm="metrics"');
    });

    it('rejects a non-Bearer scheme (e.g. Basic)', () => {
      const result = checkMetricsAuth('Basic ZGV2OnBhc3M=', TOKEN, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
    });

    it('rejects a wrong token of the same length', () => {
      const wrong = TOKEN.replace(/./, 'X'); // first char changed, same length
      expect(wrong.length).toBe(TOKEN.length);
      const result = checkMetricsAuth(`Bearer ${wrong}`, TOKEN, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
    });

    it('rejects a token of different length (avoids timingSafeEqual throw)', () => {
      const result = checkMetricsAuth(`Bearer ${TOKEN}-extra`, TOKEN, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
    });

    it('rejects an empty bearer payload', () => {
      const result = checkMetricsAuth('Bearer ', TOKEN, 'production');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
    });

    it('still requires the token in dev when set (no accidental backdoor)', () => {
      const result = checkMetricsAuth('Bearer wrong', TOKEN, 'development');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
    });
  });
});
