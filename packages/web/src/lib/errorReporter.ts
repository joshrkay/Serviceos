/**
 * ARCH-31 / OBS-43 — global async-error capture.
 *
 * `ErrorBoundary` (render errors) and `RouteErrorElement` (router
 * loader/action errors) already catch and `console.error` what they see,
 * but nothing in the app catches errors OUTSIDE render: a rejected promise
 * nobody awaited, a bug in a `setTimeout` callback, a WebSocket handler
 * throw. Those were invisible in production — no `window` listener, no
 * reporter, nothing but a browser devtools console no one is watching.
 *
 * This module:
 *   1. Registers `window.addEventListener('unhandledrejection', ...)` and
 *      `('error', ...)` once (idempotent — safe to call `initErrorReporting`
 *      more than once, e.g. React StrictMode double-invoke or tests).
 *   2. Reports through the existing PostHog client (`lib/analytics.ts`) as
 *      an `app_error` event — degrades to a no-op if PostHog isn't
 *      initialized (no `VITE_POSTHOG_KEY` configured), exactly like every
 *      other `track()` call in this app. No new dependency.
 *   3. Is the single place `ErrorBoundary.componentDidCatch` and
 *      `RouteErrorElement` route through, so render errors and router
 *      errors land next to the async ones instead of being logged
 *      independently.
 *
 * Redaction: only `name` + a truncated, best-effort-redacted `message` are
 * ever sent. We never forward the raw Error object (which may carry a
 * parsed API response body as a property), a stack trace, request
 * bodies, or headers. `redactMessage` additionally strips anything shaped
 * like a bearer token / JWT out of the message text itself, since a
 * thrown `new Error(rawResponseText)` upstream could embed one verbatim.
 */
import { track, type AnalyticsEvent } from './analytics';

const APP_ERROR_EVENT: AnalyticsEvent = 'app_error';
const MAX_MESSAGE_LENGTH = 300;

// "Bearer <token>" and bare JWT-shaped strings (three dot-separated
// base64url segments) — redacted so an error message that happens to embed
// one doesn't leak it into analytics.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function redactMessage(message: string): string {
  const redacted = message
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(JWT_RE, '[redacted]');
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

/** The only shape ever sent off-device for a captured error. */
export interface SafeErrorShape {
  name: string;
  message: string;
}

/**
 * Extracts a redacted `{ name, message }` from any thrown/rejected value.
 * Never returns (or accepts as input to `track`) the raw object, a
 * response body, or a token — safe to log to console or send to PostHog.
 */
export function toSafeErrorShape(err: unknown): SafeErrorShape {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: redactMessage(err.message || '') };
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: redactMessage(err) };
  }
  return { name: 'UnknownError', message: '' };
}

/**
 * Reports an already-safe `{ name, message }` pair through PostHog as an
 * `app_error` event. Safe to call unconditionally — degrades to a no-op
 * via `track()` when PostHog isn't initialized (dev/preview without
 * `VITE_POSTHOG_KEY`), and never throws.
 *
 * `source` identifies the capture site (e.g. `'unhandledrejection'`,
 * `'error-boundary'`, `'route-error'`, `'assistant-chat'`) so app_error
 * events can be triaged by origin without needing a stack trace.
 *
 * Prefer `reportError` below for a raw thrown/rejected value — this is for
 * callers (e.g. `RouteErrorElement`) that already computed a display-safe
 * name/message and want the same redaction + truncation applied before it
 * leaves the device.
 */
export function reportSafeError(name: string, message: string, source: string): void {
  track(APP_ERROR_EVENT, {
    name: name || 'Error',
    message: redactMessage(message || ''),
    source,
  });
}

/**
 * Reports an error through PostHog as an `app_error` event. Safe to call
 * unconditionally — never throws, and passes the raw value through
 * `toSafeErrorShape` first so nothing but `{ name, message }` ever leaves
 * this module.
 */
export function reportError(err: unknown, source: string): void {
  const { name, message } = toSafeErrorShape(err);
  reportSafeError(name, message, source);
}

let installed = false;

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  reportError(event.reason, 'unhandledrejection');
}

function handleWindowError(event: ErrorEvent): void {
  reportError(event.error ?? event.message, 'window.error');
}

/**
 * Registers the global listeners. Idempotent — call it once at app root
 * (see `main.tsx`); a repeat call after the first is a no-op so it's safe
 * to call from tests or a hot-reloaded module without double-registering.
 */
export function initErrorReporting(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  window.addEventListener('error', handleWindowError);
  installed = true;
}

/** Test-only teardown so each test file starts with a clean listener set. */
export function __resetErrorReportingForTests(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    window.removeEventListener('error', handleWindowError);
  }
  installed = false;
}
