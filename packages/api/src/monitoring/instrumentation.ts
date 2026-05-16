import { getSentryClient } from './sentry';

export interface InstrumentOptions<Args extends unknown[]> {
  /** Required tag for Sentry alert rule filtering (e.g., 'stripe-webhook', 'voice'). */
  path: string;
  /** Optional extractor that returns additional tags from the handler's args. */
  extractTags?: (...args: Args) => Record<string, string | undefined>;
}

/**
 * Wraps an async handler so any thrown error is tagged + captured to Sentry
 * before being rethrown. Tags include the required `path` plus anything
 * returned by `extractTags`. Undefined tag values are skipped.
 *
 * Used by the four critical-path entry points (Stripe webhook, execution
 * worker, voice-action-router, Media Streams handler) to feed structured
 * exceptions into Sentry alert rules — see docs/runbooks/alerting.md.
 *
 * Tags are scoped per-event via SentryClient.withScope so concurrent
 * requests cannot leak tags into each other's captured events.
 */
export function instrument<Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>,
  options: InstrumentOptions<Args>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err: unknown) {
      const client = getSentryClient();
      const error = err instanceof Error ? err : new Error(String(err));
      client.withScope((scope) => {
        scope.setTag('path', options.path);
        if (options.extractTags) {
          const tags = options.extractTags(...args);
          for (const [k, v] of Object.entries(tags)) {
            if (v !== undefined) scope.setTag(k, v);
          }
        }
        scope.captureException(error);
      });
      throw err;
    }
  };
}
