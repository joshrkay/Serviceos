import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  registerMarketingRedirects,
  MARKETING_REDIRECT_PATHS,
  MARKETING_SITE_URL,
} from '../src/marketing-redirects';

function makeApp() {
  const app = express();
  registerMarketingRedirects(app);
  // Stand-in for the real SPA catch-all so we can prove the redirects win
  // over index.html for the retired marketing paths.
  app.get('*', (_req, res) => res.status(200).send('SPA_INDEX'));
  return app;
}

describe('marketing redirects', () => {
  it('302-redirects every retired marketing path to the marketing site path-for-path', async () => {
    const app = makeApp();
    for (const path of MARKETING_REDIRECT_PATHS) {
      const res = await request(app).get(path);
      expect(res.status, `${path} should redirect`).toBe(302);
      expect(res.headers.location, `${path} should preserve its path`).toBe(
        `${MARKETING_SITE_URL}${path}`,
      );
    }
  });

  it('preserves the query string so attribution params survive the hop', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/pricing?utm_source=google&utm_campaign=spring&gclid=abc123',
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${MARKETING_SITE_URL}/pricing?utm_source=google&utm_campaign=spring&gclid=abc123`,
    );
  });

  it('does not intercept unrelated paths (they fall through to the SPA)', async () => {
    const app = makeApp();
    const res = await request(app).get('/jobs');
    expect(res.status).toBe(200);
    expect(res.text).toBe('SPA_INDEX');
  });

  it('leaves the app root for the SPA (root is auth-gated client-side, not redirected here)', async () => {
    const app = makeApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('SPA_INDEX');
  });
});
