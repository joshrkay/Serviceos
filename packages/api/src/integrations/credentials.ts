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
import { Client, Pool, PoolConfig } from 'pg';

const CHANNEL = 'tenant_integration_rotated';
const DEFAULT_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 5_000;

export type CredentialRow = {
  tenant_id: string;
  provider: string;
  credentials: Record<string, unknown>;
  credential_version: number;
};

export type CredentialResolver = {
  getCredential(tenantId: string, provider: string): Promise<CredentialRow | null>;
  close(): Promise<void>;
};

export type TenantCredentialResolver = CredentialResolver;

type ListenerClient = Pick<Client, 'connect' | 'end' | 'on' | 'off' | 'query'>;

type CreateCredentialResolverDeps = {
  pool: Pool;
  createListener?: (config: string | PoolConfig) => ListenerClient;
  sleep?: (ms: number) => Promise<void>;
};

export function createCredentialResolver({
  pool,
  createListener = (config) => new Client(config),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: CreateCredentialResolverDeps): CredentialResolver {
  const cache = new Map<string, CredentialRow | null>();
  const keyOf = (tenantId: string, provider: string): string => `${tenantId}:${provider}`;

  const listenerConfig = pool.options.connectionString ?? {
    host: pool.options.host,
    port: pool.options.port,
    user: pool.options.user,
    password: pool.options.password,
    database: pool.options.database,
    ssl: pool.options.ssl,
  };

  const listener = createListener(listenerConfig);
  let closed = false;
  let reconnecting: Promise<void> | null = null;

  const onNotification = (msg: { channel?: string; payload?: string | null }): void => {
    if (msg.channel !== CHANNEL) return;
    if (!msg.payload) {
      cache.clear();
      return;
    }

    const [tenantId, provider] = msg.payload.split(':');
    if (tenantId && provider) {
      cache.delete(keyOf(tenantId, provider));
      return;
    }

    cache.clear();
  };

  const listen = async (): Promise<void> => {
    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);
  };

  const reconnect = async (): Promise<void> => {
    if (closed || reconnecting) return reconnecting ?? Promise.resolve();

    reconnecting = (async () => {
      let delay = DEFAULT_RECONNECT_MS;
      while (!closed) {
        try {
          await listener.end();
        } catch {
          // best effort cleanup
        }

        try {
          await listen();
          reconnecting = null;
          return;
        } catch {
          await sleep(delay);
          delay = Math.min(delay * 2, MAX_RECONNECT_MS);
        }
      }
      reconnecting = null;
    })();

    return reconnecting;
  };

  const onListenerError = (): void => {
    void reconnect();
  };

  listener.on('notification', onNotification);
  listener.on('error', onListenerError);
  listener.on('end', onListenerError);
  void listen().catch(() => reconnect());

  return {
    async getCredential(tenantId: string, provider: string): Promise<CredentialRow | null> {
      const key = keyOf(tenantId, provider);
      if (cache.has(key)) {
        return cache.get(key) ?? null;
      }

      const result = await pool.query<CredentialRow>(
        `SELECT tenant_id, provider, credentials, credential_version
         FROM tenant_integrations
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, provider],
      );

      const row = result.rows[0] ?? null;
      cache.set(key, row);
      return row;
    },

    async close(): Promise<void> {
      closed = true;
      listener.off('notification', onNotification);
      listener.off('error', onListenerError);
      listener.off('end', onListenerError);
      try {
        await listener.query(`UNLISTEN ${CHANNEL}`);
      } catch {
        // ignore shutdown errors
      }
      await listener.end();
    },
  };
}
