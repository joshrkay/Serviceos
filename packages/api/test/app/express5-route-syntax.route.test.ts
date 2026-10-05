/**
 * #1555 — Express 5 / path-to-regexp v8 route syntax.
 *
 * path-to-regexp v8 rejects Express 4 path syntax AT REGISTRATION: an
 * unnamed `*` wildcard, a `:param?` optional, or regex characters in a
 * string path throw while the router is built, so one stale path takes the
 * whole createApp() down. Wildcards must be named (`/*splat`, which needs
 * at least one segment, or `/{*splat}`, which also matches the bare
 * prefix) and optionals use braces (`{/:param}`).
 *
 * Pinned here through public seams:
 *   - the SPA catch-all at the bottom of createApp() still answers the
 *     root path AND deep client-side paths;
 *   - the dev storage receiver's wildcard still captures a multi-segment
 *     object key (PUT then GET round-trip);
 *   - no router/app path in src/ uses the Express-4-only syntax.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
import { createDevStorageRouter } from '../../src/routes/files';
import { signDevStorageToken } from '../../src/files/storage-provider';

const FRONTEND_UNAVAILABLE = { error: 'INTERNAL_ERROR', message: 'Frontend assets unavailable' };

describe('Express 5 route syntax (#1555)', () => {
  describe('SPA catch-all in createApp()', () => {
    let app: AppWithLifecycle;
    let prev: Record<string, string | undefined>;

    beforeAll(() => {
      prev = {
        NODE_ENV: process.env.NODE_ENV,
        DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
        DATABASE_URL: process.env.DATABASE_URL,
        PROCESS_ROLE: process.env.PROCESS_ROLE,
      };
      process.env.NODE_ENV = 'dev';
      process.env.DEV_AUTH_BYPASS = 'true';
      process.env.PROCESS_ROLE = 'web';
      delete process.env.DATABASE_URL;
      resetConfig();
      app = createApp();
    });

    afterAll(async () => {
      await app.gracefulDrain('test-cleanup');
      resetConfig();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    // packages/web/dist is not built in tests, so the catch-all's documented
    // answer is the "Frontend assets unavailable" 500 — reaching it at all
    // is what proves the wildcard matched.
    it('answers a deep client-side route', async () => {
      const res = await request(app).get('/jobs/abc/edit');
      expect(res.status).toBe(500);
      expect(res.body).toEqual(FRONTEND_UNAVAILABLE);
    });

    it('answers the bare root path', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(500);
      expect(res.body).toEqual(FRONTEND_UNAVAILABLE);
    });
  });

  it('dev storage wildcard captures a multi-segment object key', async () => {
    const secret = 'route-syntax-secret';
    const app = express();
    app.use('/storage-dev', createDevStorageRouter(secret));
    const key = 'tenant-1/uploads/2026/voice.webm';

    const put = await request(app)
      .put(`/storage-dev/${key}?token=${signDevStorageToken(secret, 'PUT', key)}`)
      .set('content-type', 'audio/webm')
      .send('raw-bytes');
    expect(put.status).toBe(200);

    const get = await request(app).get(
      `/storage-dev/${key}?token=${signDevStorageToken(secret, 'GET', key)}`,
    );
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('audio/webm');
    expect(Buffer.from(get.body).toString()).toBe('raw-bytes');
  });

  it('no router/app path in src/ uses Express-4-only syntax', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);

    const routeCall = /\.(?:get|post|put|patch|delete|all|use|route|options|head)\(\s*(['"`])([^'"`]*)\1/g;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(routeCall)) {
        const path = m[2];
        if (!path.startsWith('/') && path !== '*') continue;
        const unnamedWildcard = /\*(?![A-Za-z_])/.test(path);
        const legacyOptional = /:[A-Za-z_]+\?/.test(path);
        const regexChars = /[()+]/.test(path);
        if (unnamedWildcard || legacyOptional || regexChars) {
          offenders.push(`${file.slice(srcDir.length + 1)}: ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
