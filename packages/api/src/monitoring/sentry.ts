import { redactByTier, redactSentryUser } from '../logging/redact';

export interface SentryConfig {
  dsn?: string;
  environment: string;
  release?: string;
  tracesSampleRate?: number;
}

export interface SentryScope {
  setTag(key: string, value: string): void;
  captureException(error: Error): string;
}

export interface SentryClient {
  captureException(error: Error, context?: Record<string, unknown>): string;
  captureMessage(message: string, level?: 'info' | 'warning' | 'error'): string;
  setTag(key: string, value: string): void;
  setUser(user: { id: string; email?: string }): void;
  startTransaction(name: string): SentryTransaction;
  /**
   * Run `cb` against an isolated scope. Tags set on the scope apply only
   * to events captured within the callback — this prevents tag leakage
   * between concurrent requests. Use this for per-event tagging.
   */
  withScope<T>(cb: (scope: SentryScope) => T): T;
}

export interface SentryTransaction {
  finish(): void;
  setStatus(status: string): void;
}

interface SentryRawScope {
  setTag(key: string, value: unknown): void;
  captureException(exception: unknown): string;
}

interface SentryModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init(options: any): void;
  captureException(exception: unknown, hint?: { extra?: Record<string, unknown> }): string;
  captureMessage(message: string, captureContext?: string): string;
  setTag(key: string, value: unknown): void;
  setUser(user: unknown): void;
  withScope(cb: (scope: SentryRawScope) => void): void;
}

let redactionProcessorsInstalled = false;

function resolveSentry(): SentryModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@sentry/node') as SentryModule;
  } catch {
    return null;
  }
}

export function initSentry(config: SentryConfig): SentryClient {
  if (!config.dsn) {
    return createNoOpSentryClient();
  }

  const sentry = resolveSentry();
  if (!sentry) {
    return createNoOpSentryClient();
  }

  redactionProcessorsInstalled = false;

  sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate ?? (config.environment === 'production' ? 0.1 : 1.0),
    beforeSend(event: unknown) {
      return redactByTier(event, 'strict') as any;
    },
    beforeBreadcrumb(breadcrumb: unknown) {
      return redactByTier(breadcrumb, 'strict') as any;
    },
  } as any);

  redactionProcessorsInstalled = true;
  return createRealSentryClient(sentry);
}

export function assertSentryRedactionProcessors(environment: string): void {
  if (environment !== 'test' && !redactionProcessorsInstalled) {
    throw new Error('Sentry redaction processors must be installed outside test environments.');
  }
}

let currentClient: SentryClient | null = null;

/**
 * Register the Sentry client for the process. Called once at app startup
 * after initSentry(). Subsequent calls override the registration (useful
 * for test setup that swaps in a fake). Pass `null` (or call resetSentryClient)
 * to restore the no-op fallback.
 */
export function setSentryClient(client: SentryClient | null): void {
  currentClient = client;
}

/** Restore the no-op fallback. Test convenience. */
export function resetSentryClient(): void {
  currentClient = null;
}

/**
 * Get the registered Sentry client, or a no-op client if none has been set.
 * Used by instrumentation wrappers (see ./instrumentation.ts) so they work
 * whether or not Sentry is configured for the environment.
 */
export function getSentryClient(): SentryClient {
  return currentClient ?? createNoOpSentryClient();
}

function createNoOpSentryClient(): SentryClient {
  const noOpTransaction: SentryTransaction = {
    finish: () => {},
    setStatus: () => {},
  };
  return {
    captureException: () => 'no-op',
    captureMessage: () => 'no-op',
    setTag: () => {},
    setUser: () => {},
    startTransaction: () => noOpTransaction,
    withScope<T>(cb: (scope: SentryScope) => T): T {
      return cb({
        setTag() {},
        captureException() {
          return 'noop';
        },
      });
    },
  };
}

function createRealSentryClient(sentry: SentryModule): SentryClient {
  return {
    captureException(error: Error, context?: Record<string, unknown>): string {
      return sentry.captureException(error, { extra: redactByTier(context ?? {}, 'strict') }) as string;
    },
    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): string {
      return sentry.captureMessage(message, level) as string;
    },
    setTag(key: string, value: string): void {
      sentry.setTag(key, value);
    },
    setUser(user: { id: string; email?: string }): void {
      sentry.setUser(redactSentryUser(user) as any);
    },
    startTransaction(_name: string): SentryTransaction {
      return {
        finish() {},
        setStatus: () => {},
      };
    },
    withScope<T>(cb: (scope: SentryScope) => T): T {
      // @sentry/node's withScope callback is void-typed; capture our cb's
      // result via closure so per-scope tagging stays isolated to the event
      // captured inside the callback.
      let result: T;
      let assigned = false;
      sentry.withScope((rawScope: SentryRawScope) => {
        result = cb({
          setTag(key: string, value: string): void {
            rawScope.setTag(key, value);
          },
          captureException(error: Error): string {
            return rawScope.captureException(error);
          },
        });
        assigned = true;
      });
      if (!assigned) {
        throw new Error('Sentry withScope callback did not execute synchronously');
      }
      return result!;
    },
  };
}
