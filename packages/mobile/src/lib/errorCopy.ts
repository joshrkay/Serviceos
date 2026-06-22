/**
 * Owner-facing copy for every failure the app can surface.
 *
 * `AppError.message` (from `appError.ts`/`decodeError`) is already blame-free and
 * action-first, but it's a single line — it can't drive a two-line empty/error
 * state (a bold title + a calmer body) or tell a screen whether a Retry button is
 * worth showing. This module owns that mapping: `kind → { title, body, retryable }`
 * for the full taxonomy, plus the two device-permission states that aren't API
 * errors at all (microphone, push). The tone matches the existing voice
 * (`useStartCall`, `sendReply`, `useVoiceCapture`): short, blame-free, action-led,
 * no HTTP codes.
 *
 * Pure and React-free — unit-tested directly.
 */
import type { AppError, AppErrorKind } from './appError';

export interface ErrorCopy {
  /** A short, bold headline for the state. */
  title: string;
  /** One calmer line telling the owner what to do next. */
  body: string;
  /** True when re-running the same request can plausibly succeed. */
  retryable: boolean;
}

/**
 * Full-taxonomy copy. `retryable` is false only where a retry can't help on its
 * own: `forbidden`/`notFound` (a different request is needed) and `unauthorized`
 * (re-auth, handled by the sign-out flow, not a Retry button).
 */
const COPY_BY_KIND: Record<AppErrorKind, ErrorCopy> = {
  offline: {
    title: "You're offline",
    body: 'Check your connection — this will refresh on its own once you reconnect.',
    retryable: true,
  },
  timeout: {
    title: 'That took too long',
    body: 'The connection stalled. Give it another try.',
    retryable: true,
  },
  unauthorized: {
    title: 'Your session expired',
    body: 'Please sign in again to pick up where you left off.',
    retryable: false,
  },
  forbidden: {
    title: "You don't have access",
    body: 'This is restricted to a different role. Ask an owner if you need it.',
    retryable: false,
  },
  notFound: {
    title: "This isn't here anymore",
    body: 'It may have been moved or removed. Head back and try again.',
    retryable: false,
  },
  conflict: {
    title: 'This just changed',
    body: 'Someone updated it first. Refresh to see the latest, then try again.',
    retryable: true,
  },
  validation: {
    title: 'Something needs a second look',
    body: 'A detail came through wrong. Check it over and try again.',
    retryable: true,
  },
  server: {
    title: 'That one is on us',
    body: 'Something went wrong on our end. Give it another try in a moment.',
    retryable: true,
  },
  unknown: {
    title: 'Something went wrong',
    body: 'We hit a snag. Give it another try.',
    retryable: true,
  },
};

/** Microphone-permission denial on the voice path (not an API error). */
export const MIC_PERMISSION_COPY: ErrorCopy = {
  title: 'Microphone is off',
  body: 'Turn on microphone access in Settings to speak an action.',
  retryable: false,
};

/** Push-permission denial — surfaced as a settings/home nudge, not a hard error. */
export const PUSH_DENIED_COPY: ErrorCopy = {
  title: 'Notifications are off',
  body: 'Turn on notifications in Settings to get alerts.',
  retryable: false,
};

/** True for an `AppError` (vs. a raw string/Error a hook may already have reduced). */
function isAppError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AppError).kind === 'string' &&
    typeof (err as AppError).message === 'string'
  );
}

/**
 * Resolve any caught failure to display copy.
 *
 * - An `AppError`: map its `kind` to the taxonomy copy, preferring the backend's
 *   specific `message` as the body when present (it's already in-voice and often
 *   more precise than the generic line, e.g. "Customer not found: abc").
 * - Anything else (a string the read hooks already reduced to, or a bare Error):
 *   treat as `unknown`, surfacing the string as the body when it's non-empty.
 */
export function copyForError(err: unknown): ErrorCopy {
  if (isAppError(err)) {
    const base = COPY_BY_KIND[err.kind];
    const message = err.message.trim();
    return message ? { ...base, body: message } : base;
  }
  const text =
    typeof err === 'string'
      ? err.trim()
      : err instanceof Error
        ? err.message.trim()
        : '';
  return text ? { ...COPY_BY_KIND.unknown, body: text } : COPY_BY_KIND.unknown;
}
