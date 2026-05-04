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
