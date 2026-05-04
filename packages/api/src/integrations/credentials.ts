import type { Pool } from 'pg';

export interface TenantTwilioCreds {
  tenantId: string;
  credentialVersion: string;
  accountSid: string;
  authTokenPrimary: string;
  authTokenSecondary?: string;
  fromNumber: string;
}

export interface TenantSendGridCreds {
  tenantId: string;
  credentialVersion: string;
  apiKey: string;
  fromEmail: string;
  fromName?: string;
  replyToEmail?: string;
}

type RuntimeEnv = 'production' | 'non-production';

interface CacheEntry<T> { key: string; value: T }

class LruCache<T> {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, T>();
  constructor(maxEntries = 512) { this.maxEntries = Math.max(1, maxEntries); }
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key); this.entries.set(key, hit);
    return hit;
  }
  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
  }
  deleteByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); }
}

interface TenantIntegrationRow {
  tenant_id: string;
  provider: 'twilio' | 'sendgrid';
  credential_version: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface TenantCredentialResolver {
  getTenantTwilioCreds(tenantId: string): Promise<TenantTwilioCreds>;
  getTenantSendGridCreds(tenantId: string): Promise<TenantSendGridCreds>;
  invalidateTenant(tenantId: string): void;
  close(): Promise<void>;
}

export function createTenantCredentialResolver(pool: Pool, options?: { env?: RuntimeEnv; cacheSize?: number }): TenantCredentialResolver {
  const env: RuntimeEnv = options?.env ?? (process.env.NODE_ENV === 'production' ? 'production' : 'non-production');
  const twilioCache = new LruCache<TenantTwilioCreds>(options?.cacheSize ?? 512);
  const sendGridCache = new LruCache<TenantSendGridCreds>(options?.cacheSize ?? 512);

  async function loadRow(tenantId: string, provider: 'twilio' | 'sendgrid'): Promise<TenantIntegrationRow | null> {
    const res = await pool.query<TenantIntegrationRow>(
      `SELECT tenant_id, provider, credential_version, enabled, config
         FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = $2
        LIMIT 1`,
      [tenantId, provider]
    );
    return res.rows[0] ?? null;
  }

  return {
    async getTenantTwilioCreds(tenantId: string): Promise<TenantTwilioCreds> {
      const row = await loadRow(tenantId, 'twilio');
      if (row?.enabled) {
        const key = `${tenantId}::${row.credential_version}`;
        const cached = twilioCache.get(key);
        if (cached) return cached;
        const accountSid = String(row.config.accountSid ?? '');
        const authTokenPrimary = String(row.config.authTokenPrimary ?? '');
        const authTokenSecondary = row.config.authTokenSecondary ? String(row.config.authTokenSecondary) : undefined;
        const fromNumber = String(row.config.fromNumber ?? '');
        if (!accountSid || !authTokenPrimary || !fromNumber) throw new Error(`Tenant ${tenantId} has incomplete Twilio credentials`);
        const value: TenantTwilioCreds = { tenantId, credentialVersion: row.credential_version, accountSid, authTokenPrimary, authTokenSecondary, fromNumber };
        twilioCache.set(key, value);
        return value;
      }
      if (env === 'production') throw new Error(`Tenant ${tenantId} has no enabled Twilio integration`);
      const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
      const token = process.env.TWILIO_AUTH_TOKEN ?? '';
      const from = process.env.TWILIO_FROM_NUMBER ?? '';
      if (!sid || !token || !from) throw new Error(`Tenant ${tenantId} has no Twilio integration and env fallback is incomplete`);
      return { tenantId, credentialVersion: 'env-fallback', accountSid: sid, authTokenPrimary: token, fromNumber: from };
    },
    async getTenantSendGridCreds(tenantId: string): Promise<TenantSendGridCreds> {
      const row = await loadRow(tenantId, 'sendgrid');
      if (row?.enabled) {
        const key = `${tenantId}::${row.credential_version}`;
        const cached = sendGridCache.get(key);
        if (cached) return cached;
        const apiKey = String(row.config.apiKey ?? '');
        const fromEmail = String(row.config.fromEmail ?? '');
        const fromName = row.config.fromName ? String(row.config.fromName) : undefined;
        const replyToEmail = row.config.replyToEmail ? String(row.config.replyToEmail) : undefined;
        if (!apiKey || !fromEmail) throw new Error(`Tenant ${tenantId} has incomplete SendGrid credentials`);
        const value: TenantSendGridCreds = { tenantId, credentialVersion: row.credential_version, apiKey, fromEmail, fromName, replyToEmail };
        sendGridCache.set(key, value);
        return value;
      }
      if (env === 'production') throw new Error(`Tenant ${tenantId} has no enabled SendGrid integration`);
      const apiKey = process.env.SENDGRID_API_KEY ?? '';
      const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? '';
      if (!apiKey || !fromEmail) throw new Error(`Tenant ${tenantId} has no SendGrid integration and env fallback is incomplete`);
      return { tenantId, credentialVersion: 'env-fallback', apiKey, fromEmail, fromName: process.env.SENDGRID_FROM_NAME, replyToEmail: process.env.SENDGRID_REPLY_TO };
    },
    invalidateTenant(tenantId: string): void {
      twilioCache.deleteByPrefix(`${tenantId}::`); sendGridCache.deleteByPrefix(`${tenantId}::`);
    },
    async close(): Promise<void> {
      // no-op in current implementation (no dedicated LISTEN client wired).
    },
  };
}
