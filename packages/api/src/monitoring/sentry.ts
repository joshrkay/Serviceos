import * as Sentry from '@sentry/node';

export interface SentryConfig {
  dsn?: string;
  environment: string;
  release?: string;
  tracesSampleRate?: number;
}

export interface SentryClient {
  captureException(error: Error, context?: Record<string, unknown>): string;
  captureMessage(message: string, level?: 'info' | 'warning' | 'error'): string;
  setTag(key: string, value: string): void;
  setUser(user: { id: string; email?: string }): void;
  startTransaction(name: string): SentryTransaction;
}

export interface SentryTransaction {
  finish(): void;
  setStatus(status: string): void;
}

export function initSentry(config: SentryConfig): SentryClient {
  if (!config.dsn) {
    return createNoOpSentryClient();
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate ?? (config.environment === 'production' ? 0.1 : 1.0),
  });

  return createRealSentryClient();
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
  };
}

function createRealSentryClient(): SentryClient {
  return {
    captureException(error: Error, context?: Record<string, unknown>): string {
      return Sentry.captureException(error, { extra: context });
    },
    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): string {
      return Sentry.captureMessage(message, level);
    },
    setTag(key: string, value: string): void {
      Sentry.setTag(key, value);
    },
    setUser(user: { id: string; email?: string }): void {
      Sentry.setUser(user);
    },
    startTransaction(_name: string): SentryTransaction {
      // Sentry v8+ deprecated startTransaction in favor of Sentry.startSpan().
      // Auto-instrumentation handles most tracing; callers needing manual spans
      // should use Sentry.startSpan() directly at call sites.
      return {
        finish() {},
        setStatus: () => {},
      };
    },
  };
}
