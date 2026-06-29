import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_REQUIRED_VARS,
  FULL_REQUIRED_VARS,
  TENANT_VARS,
  checkEnvVar,
  parseBootstrapFlag,
  probeHmacAuth,
  requiredVarSet,
  runDoctor,
} from '../../../../scripts/qa-matrix-doctor';

describe('parseBootstrapFlag', () => {
  it('returns true when --bootstrap is present', () => {
    expect(parseBootstrapFlag(['node', 'script', '--bootstrap'])).toBe(true);
  });

  it('returns false by default', () => {
    expect(parseBootstrapFlag(['node', 'script'])).toBe(false);
  });
});

describe('requiredVarSet', () => {
  it('bootstrap mode requires only URL/DB/HMAC vars', () => {
    const set = requiredVarSet(true);
    expect([...set].sort()).toEqual([...BOOTSTRAP_REQUIRED_VARS].sort());
    for (const name of TENANT_VARS) {
      expect(set.has(name)).toBe(false);
    }
  });

  it('full mode requires all 11 vars', () => {
    const set = requiredVarSet(false);
    expect([...set].sort()).toEqual([...FULL_REQUIRED_VARS].sort());
  });
});

describe('checkEnvVar bootstrap tenant skips', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of TENANT_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of TENANT_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('skips tenant vars in bootstrap mode when unset', async () => {
    const r = await checkEnvVar('E2E_TENANT_A_ID', false, true);
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('qa:setup');
  });

  it('fails tenant vars in full mode when unset', async () => {
    const r = await checkEnvVar('E2E_TENANT_A_ID', true, false);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('not set');
  });
});

describe('checkEnvVar E2E_CLERK_HMAC_SECRET', () => {
  const saved = process.env.E2E_CLERK_HMAC_SECRET;

  afterEach(() => {
    if (saved === undefined) delete process.env.E2E_CLERK_HMAC_SECRET;
    else process.env.E2E_CLERK_HMAC_SECRET = saved;
  });

  it('fails when secret is too short', async () => {
    process.env.E2E_CLERK_HMAC_SECRET = 'short';
    const r = await checkEnvVar('E2E_CLERK_HMAC_SECRET', true, false);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('too short');
  });

  it('passes when secret meets minimum length', async () => {
    process.env.E2E_CLERK_HMAC_SECRET = 'sk_test_' + 'x'.repeat(24);
    const r = await checkEnvVar('E2E_CLERK_HMAC_SECRET', true, false);
    expect(r.status).toBe('OK');
  });
});

describe('probeHmacAuth', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['E2E_CLERK_HMAC_SECRET', 'E2E_TENANT_A_ID', 'E2E_API_URL']) {
      envBackup[key] = process.env[key];
    }
    process.env.E2E_CLERK_HMAC_SECRET = 'sk_test_' + 'a'.repeat(24);
    process.env.E2E_TENANT_A_ID = 'a948cc66-7279-44bd-9718-4ef7721f9422';
    process.env.E2E_API_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('skips when tenant ID is missing', async () => {
    delete process.env.E2E_TENANT_A_ID;
    const r = await probeHmacAuth();
    expect(r.status).toBe('skip');
  });

  it('fails on 401 with CLERK_DEV_HMAC_TOKENS hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401 }),
    );
    const r = await probeHmacAuth();
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('CLERK_DEV_HMAC_TOKENS');
  });

  it('passes on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200 }),
    );
    const r = await probeHmacAuth();
    expect(r.status).toBe('OK');
  });
});

describe('runDoctor', () => {
  it('does not include HMAC probe in bootstrap mode', async () => {
    const results = await runDoctor({ bootstrap: true });
    expect(results.some((r) => r.name === 'HMAC_AUTH_PROBE')).toBe(false);
  });

  it('includes HMAC probe in full mode', async () => {
    const results = await runDoctor({ bootstrap: false });
    expect(results.some((r) => r.name === 'HMAC_AUTH_PROBE')).toBe(true);
  });
});
