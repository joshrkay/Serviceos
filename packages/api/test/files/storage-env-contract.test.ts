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
});

// Referenced by later slices; imported here so each slice only adds `it`s.
void DevStorageProvider;
void vi;
