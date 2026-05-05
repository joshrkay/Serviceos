// Per-tenant credential resolver for Twilio subaccounts.
// In production, all tenants must have an active tenant_integrations row.
// In dev/test, falls back to global TWILIO_* env vars when no row exists.

import { Pool } from 'pg';
import { decrypt } from './crypto';

export interface TenantTwilioCreds {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string | null;
  phoneE164: string | null;
  credentialVersion: number;
}

interface IntegrationRow {
  subaccount_sid: string | null;
  auth_token_primary_enc: string | null;
  credential_version: number;
  provider_data: { messagingServiceSid?: string; phoneE164?: string };
  status: string;
}

// LRU-style cache keyed by tenantId:version — flushed when credential_version bumps.
const cache = new Map<string, { creds: TenantTwilioCreds; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function flushCredentialCache(tenantId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) cache.delete(key);
  }
}

export async function getTenantTwilioCreds(
  tenantId: string,
  pool: Pool
): Promise<TenantTwilioCreds> {
  const { rows } = await pool.query<IntegrationRow>(
    `SELECT subaccount_sid, auth_token_primary_enc, credential_version, provider_data, status
     FROM tenant_integrations
     WHERE tenant_id = $1 AND provider = 'twilio'`,
    [tenantId]
  );

  if (rows.length === 0 || rows[0].status !== 'active') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`No active Twilio integration for tenant ${tenantId}`);
    }
    // Dev/test fallback to global env vars
    return {
      accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
      authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? null,
      phoneE164: process.env.TWILIO_FROM_NUMBER ?? null,
      credentialVersion: 0,
    };
  }

  const row = rows[0];
  const cacheKey = `${tenantId}:${row.credential_version}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.creds;

  const encKey = process.env.TENANT_ENCRYPTION_KEY;
  if (!encKey) throw new Error('TENANT_ENCRYPTION_KEY env var is required');

  const authToken = row.auth_token_primary_enc
    ? decrypt(row.auth_token_primary_enc, encKey)
    : '';

  const creds: TenantTwilioCreds = {
    accountSid: row.subaccount_sid ?? '',
    authToken,
    messagingServiceSid: row.provider_data.messagingServiceSid ?? null,
    phoneE164: row.provider_data.phoneE164 ?? null,
    credentialVersion: row.credential_version,
  };

  cache.set(cacheKey, { creds, expiresAt: Date.now() + CACHE_TTL_MS });
  return creds;
}
