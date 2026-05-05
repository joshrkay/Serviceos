import type * as SentryTypes from '@sentry/node';
import { redactByTier, redactSentryUser } from '../logging/redact';

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

type SentryModule = Pick<
  typeof SentryTypes,
  'init' | 'captureException' | 'captureMessage' | 'setTag' | 'setUser'
>;

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
    beforeSend(event) {
      const redactedEvent = redactByTier(event, 'strict');
      if (redactedEvent && typeof redactedEvent === 'object' && 'request' in redactedEvent) {
        const req = (redactedEvent as Record<string, any>).request;
        if (req?.data) req.data = redactByTier(req.data, 'strict');
      }
      if (redactedEvent && typeof redactedEvent === 'object' && 'user' in redactedEvent) {
        (redactedEvent as Record<string, unknown>).user = redactSentryUser(
          (redactedEvent as Record<string, unknown>).user as Record<string, unknown>
        ) as unknown;
      }
      return redactedEvent as any;
    },
    beforeBreadcrumb(breadcrumb) {
      return redactByTier(breadcrumb, 'strict') as any;
    },
  } as any);

  redactionProcessorsInstalled = true;
  assertSentryRedactionProcessors(config.environment);
  return createRealSentryClient(sentry);
}

export function assertSentryRedactionProcessors(environment: string): void {
  if (environment !== 'test' && !redactionProcessorsInstalled) {
    throw new Error('Sentry redaction processors must be installed outside test environments.');
  }
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
  };
}
