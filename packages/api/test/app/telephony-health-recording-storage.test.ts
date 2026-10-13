/**
 * Object-storage contract, app wiring: GET /api/telephony/health reports
 * `capabilities.recording` from the storage the app ACTUALLY resolved (the
 * same resolver the boot validator and the factory use), not from a
 * third-hand read of STORAGE_BUCKET. A documented R2_* environment used to
 * report `recording: false` while uploads worked, and an env that only set
 * STORAGE_BUCKET reported `recording: true` while writes went to the dev
 * provider's no-op. Hermetic boot (no DATABASE_URL → InMemory repos).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

const KEYS = [
  'NODE_ENV',
  'DEV_AUTH_BYPASS',
  'DATABASE_URL',
  'PROCESS_ROLE',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'STORAGE_ENABLED',
  'STORAGE_BUCKET',
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
];

describe('telephony health reports recording from the resolved storage config', () => {
  let app: AppWithLifecycle | undefined;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    resetConfig();
  });

  afterEach(async () => {
    await app?.gracefulDrain('test-cleanup');
    app = undefined;
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is true for the documented R2_* alias (STORAGE_BUCKET unset)', async () => {
    process.env.R2_ACCOUNT_ID = 'acct123';
    process.env.R2_ACCESS_KEY_ID = 'r2-key';
    process.env.R2_SECRET_ACCESS_KEY = 'r2-secret';
    app = createApp();

    const res = await request(app).get('/api/telephony/health');

    expect(res.status).toBe(200);
    expect(res.body.capabilities.recording).toBe(true);
    expect(res.body.warnings.join('\n')).not.toMatch(/Recording disabled/);
  });

  it('is false when only STORAGE_BUCKET is set (incomplete config: writes go to the dev no-op)', async () => {
    process.env.STORAGE_BUCKET = 'prod-bucket';
    app = createApp();

    const res = await request(app).get('/api/telephony/health');

    expect(res.body.capabilities.recording).toBe(false);
    expect(res.body.warnings.join('\n')).toMatch(/Recording disabled/);
  });
});
