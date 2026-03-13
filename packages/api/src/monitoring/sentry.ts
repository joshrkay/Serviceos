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

  // In production, this would initialize the actual Sentry SDK
  // For now, returns a structured logging fallback
  return createLoggingSentryClient(config);
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

function createLoggingSentryClient(config: SentryConfig): SentryClient {
  return {
    captureException(error: Error, context?: Record<string, unknown>): string {
      const eventId = generateEventId();
      const entry = {
        type: 'sentry_exception',
        eventId,
        environment: config.environment,
        error: error.message,
        stack: error.stack,
        ...context,
      };
      process.stderr.write(JSON.stringify(entry) + '\n');
      return eventId;
    },
    captureMessage(message: string, level: string = 'info'): string {
      const eventId = generateEventId();
      const entry = {
        type: 'sentry_message',
        eventId,
        environment: config.environment,
        message,
        level,
      };
      process.stdout.write(JSON.stringify(entry) + '\n');
      return eventId;
    },
    setTag: () => {},
    setUser: () => {},
    startTransaction(name: string): SentryTransaction {
      const start = Date.now();
      return {
        finish() {
          const duration = Date.now() - start;
          const entry = {
            type: 'sentry_transaction',
            name,
            environment: config.environment,
            duration_ms: duration,
          };
          process.stdout.write(JSON.stringify(entry) + '\n');
        },
        setStatus: () => {},
      };
    },
  };
}

function generateEventId(): string {
  return Math.random().toString(36).substring(2, 15);
}
