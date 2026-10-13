/**
 * One object-storage env contract.
 *
 * Before this contract the boot validator (shared/config.ts) demanded the
 * documented R2_* trio while the only storage factory (createStorageProvider)
 * read a different family (STORAGE_*) and never looked at R2_*. Following the
 * documented contract crash-looped boot, and the operator "fix"
 * (STORAGE_ENABLED=false) booted green into DevStorageProvider, whose
 * putObject() is a silent no-op — customer MMS photos / recordings "saved" to
 * nowhere.
 *
 * These tests pin the invariant at the two public seams, with the SAME env
 * object handed to both: the boot validator (`loadConfig`) and the factory
 * (`createStorageProvider`) must agree on every env shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  S3StorageProvider,
  DevStorageProvider,
  createStorageProvider,
} from '../../src/files/storage-provider';
import { loadConfig, resetConfig } from '../../src/shared/config';

/** The documented Cloudflare R2 contract (docs/prod-env-checklist.md). */
const R2_ONLY = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'r2-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
};

/** The set the factory has always read — the live-prod shape. */
const STORAGE_FULL = {
  STORAGE_BUCKET: 'prod-bucket',
  STORAGE_ENDPOINT: 'https://s3.example.com',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'st-key',
  STORAGE_SECRET_ACCESS_KEY: 'st-secret',
};

/**
 * Every OTHER prod/staging gate satisfied and the other feature bundles opted
 * out, so the only thing under test is the object-storage contract.
 */
const PROD_BASE = {
  NODE_ENV: 'prod',
  DATABASE_URL: 'postgres://u:p@h/d',
  CLERK_SECRET_KEY: 'sk_x',
  CLERK_PUBLISHABLE_KEY: 'pk_x',
  CLERK_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe_x',
  AI_PROVIDER_API_KEY: 'ak_x',
  CORS_ORIGIN: 'https://app.example.com',
  WEB_URL: 'https://app.example.com',
  PUBLIC_API_URL: 'https://api.example.com',
  RLS_RUNTIME_ROLE: 'true',
  TENANT_ENCRYPTION_KEY: 'a'.repeat(64),
  TELEPHONY_ENABLED: 'false',
  EMAIL_ENABLED: 'false',
};

describe('object-storage env contract (validator and factory agree)', () => {
  beforeEach(() => {
    resetConfig();
  });

  describe('slice 1 — the documented R2_* contract', () => {
    it('resolves to a real S3 provider against the R2 endpoint in production', async () => {
      const { provider, bucket, mode, devStorageSecret } = createStorageProvider({
        NODE_ENV: 'production',
        ...R2_ONLY,
      });

      expect(mode).toBe('s3');
      expect(provider).toBeInstanceOf(S3StorageProvider);
      expect(devStorageSecret).toBeUndefined();
      // R2_BUCKET is not part of the documented trio; the schema default
      // (shared/config.ts R2_BUCKET) is the bucket name.
      expect(bucket).toBe('serviceos-uploads');

      const url = new URL(await provider.generateUploadUrl(bucket, 'tenant-1/a.webm', 'audio/webm', 10));
      expect(url.host).toBe('acct123.r2.cloudflarestorage.com');
      expect(url.pathname).toBe('/serviceos-uploads/tenant-1/a.webm');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(
        /^r2-key\/\d{8}\/auto\/s3\/aws4_request$/
      );
    });

    it('is also accepted by the boot validator', () => {
      expect(() => loadConfig({ ...PROD_BASE, ...R2_ONLY })).not.toThrow();
    });
  });

  describe('slice 2 — the STORAGE_* set the factory has always read (live-prod shape)', () => {
    it('resolves to a real S3 provider with exactly those values', async () => {
      const { provider, bucket, mode } = createStorageProvider({
        NODE_ENV: 'production',
        ...STORAGE_FULL,
      });

      expect(mode).toBe('s3');
      expect(provider).toBeInstanceOf(S3StorageProvider);
      expect(bucket).toBe('prod-bucket');
      const url = new URL(await provider.generateUploadUrl(bucket, 'k.webm', 'audio/webm', 10));
      expect(url.host).toBe('s3.example.com');
      expect(url.pathname).toBe('/prod-bucket/k.webm');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(
        /^st-key\/\d{8}\/us-east-1\/s3\/aws4_request$/
      );
    });

    it('is accepted by the boot validator without any R2_* variable', () => {
      expect(() => loadConfig({ ...PROD_BASE, ...STORAGE_FULL })).not.toThrow();
    });

    it('is not overridden by R2_* when both families are set (regression guard for prod configs that boot today)', async () => {
      const both = {
        NODE_ENV: 'production',
        ...STORAGE_FULL,
        ...R2_ONLY,
        R2_BUCKET: 'r2-bucket-should-lose',
      };
      const { provider, bucket, mode } = createStorageProvider(both);

      expect(mode).toBe('s3');
      expect(bucket).toBe('prod-bucket');
      const url = new URL(await provider.generateUploadUrl(bucket, 'k.webm', 'audio/webm', 10));
      expect(url.host).toBe('s3.example.com');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^st-key\//);
      expect(() => loadConfig({ ...PROD_BASE, ...both })).not.toThrow();
    });
  });

  describe('slice 3 — nothing (or a partial set) configured and no opt-out', () => {
    const failsBoot = (env: Record<string, string>): string => {
      try {
        loadConfig({ ...PROD_BASE, ...env });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected loadConfig to throw');
    };
    const factoryFails = (env: Record<string, string>): string => {
      try {
        createStorageProvider({ NODE_ENV: 'production', ...env });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected createStorageProvider to throw');
    };

    it('boot validation names every canonical variable, its R2 alias, and the opt-out', () => {
      const msg = failsBoot({});
      expect(msg).toMatch(
        /STORAGE_BUCKET[\s\S]*STORAGE_ENDPOINT[\s\S]*STORAGE_REGION[\s\S]*STORAGE_ACCESS_KEY_ID[\s\S]*STORAGE_SECRET_ACCESS_KEY/
      );
      expect(msg).toMatch(/R2_ACCOUNT_ID[\s\S]*R2_ACCESS_KEY_ID[\s\S]*R2_SECRET_ACCESS_KEY/);
      expect(msg).toContain('STORAGE_ENABLED=false');
    });

    it('the factory fails with the same names (validator and factory cannot disagree)', () => {
      const msg = factoryFails({});
      expect(msg).toMatch(/Storage configuration missing/);
      expect(msg).toMatch(
        /STORAGE_BUCKET[\s\S]*STORAGE_ENDPOINT[\s\S]*STORAGE_REGION[\s\S]*STORAGE_ACCESS_KEY_ID[\s\S]*STORAGE_SECRET_ACCESS_KEY/
      );
    });

    it('a partial STORAGE_* set names only what is still missing', () => {
      const partial = { STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'https://s3.example.com' };
      for (const msg of [failsBoot(partial), factoryFails(partial)]) {
        expect(msg).toMatch(/STORAGE_REGION/);
        expect(msg).toMatch(/STORAGE_ACCESS_KEY_ID/);
        expect(msg).toMatch(/STORAGE_SECRET_ACCESS_KEY/);
        expect(msg).not.toMatch(/STORAGE_BUCKET|STORAGE_ENDPOINT/);
      }
    });

    it('an R2 account id alone names only the missing key pair', () => {
      const msg = failsBoot({ R2_ACCOUNT_ID: 'acct123' });
      expect(msg).toMatch(/STORAGE_ACCESS_KEY_ID/);
      expect(msg).toMatch(/STORAGE_SECRET_ACCESS_KEY/);
      expect(msg).not.toMatch(/STORAGE_BUCKET|STORAGE_ENDPOINT|STORAGE_REGION|R2_ACCOUNT_ID/);
    });
  });

  describe('slice 4 — STORAGE_ENABLED=false (explicit opt-out) is loud, not silent', () => {
    const optOut = { STORAGE_ENABLED: 'false' };

    it('still returns the DevStorageProvider, and emits exactly one WARN saying nothing is persisted', () => {
      const warn = vi.fn();
      const { provider, mode } = createStorageProvider(
        { NODE_ENV: 'production', ...optOut },
        { logger: { warn } }
      );

      expect(mode).toBe('dev');
      expect(provider).toBeInstanceOf(DevStorageProvider);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain('STORAGE_ENABLED=false');
      expect(message).toMatch(/uploads/i);
      expect(message).toMatch(/recordings/i);
      expect(message).toMatch(/MMS/);
      expect(message).toMatch(/not persisted/i);
    });

    it.each(['prod', 'production', 'staging'])('warns in NODE_ENV=%s', (nodeEnv) => {
      const warn = vi.fn();
      createStorageProvider({ NODE_ENV: nodeEnv, ...optOut }, { logger: { warn } });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('stays quiet in dev, where the dev provider is the expected backend', () => {
      const warn = vi.fn();
      createStorageProvider({ NODE_ENV: 'development' }, { logger: { warn } });
      createStorageProvider({ NODE_ENV: 'development', ...optOut }, { logger: { warn } });
      expect(warn).not.toHaveBeenCalled();
    });

    it('stays quiet when a complete STORAGE_* set resolves, even with the flag still set', () => {
      // The factory has always let a complete STORAGE_* set win over the
      // flag; live prod may be running exactly this. It must keep resolving
      // to S3 and must not claim that nothing is persisted.
      const warn = vi.fn();
      const { mode } = createStorageProvider(
        { NODE_ENV: 'production', ...optOut, ...STORAGE_FULL },
        { logger: { warn } }
      );
      expect(mode).toBe('s3');
      expect(warn).not.toHaveBeenCalled();
    });

    it('is authoritative over the R2_* alias: an opted-out env that still carries R2_* does not silently flip to real writes', () => {
      // The documented failure scenario leaves operators with R2_* set AND
      // STORAGE_ENABLED=false. That env boots on the dev provider today;
      // honouring the alias here would change live behaviour on deploy.
      const warn = vi.fn();
      const { mode, provider } = createStorageProvider(
        { NODE_ENV: 'production', ...optOut, ...R2_ONLY },
        { logger: { warn } }
      );
      expect(mode).toBe('dev');
      expect(provider).toBeInstanceOf(DevStorageProvider);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('the boot validator accepts the opt-out with nothing configured', () => {
      expect(() => loadConfig({ ...PROD_BASE, ...optOut })).not.toThrow();
    });
  });
});

// (imports used by every slice)
void DevStorageProvider;
void vi;
