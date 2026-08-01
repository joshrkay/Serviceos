import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useApiClient } from '../lib/apiClient';

/**
 * Built-in success/error toast copy keyed by common entity actions used
 * across the app. Consumers can pass their own message via
 * {@link MutationOptions} when these defaults don't fit.
 *
 * Story: P0-032 — common-action toast notifications
 */
export const COMMON_TOAST_MESSAGES = {
  customerCreated: 'Customer created',
  estimateSaved: 'Estimate saved',
  invoiceSent: 'Invoice sent',
  appointmentScheduled: 'Appointment scheduled',
} as const;

export interface MutationOptions<TBody, TResult> {
  /** Toast message shown on success. Pass `false` to disable. */
  successMessage?: string | false;
  /** Toast message shown on error. Pass `false` to disable. Receives the
   *  thrown error to allow custom formatting. */
  errorMessage?: string | false | ((err: unknown) => string);
  /** Optional callback fired after success toast. */
  onSuccess?: (data: TResult, variables: TBody) => void;
  /** Optional callback fired after error toast. */
  onError?: (err: unknown, variables: TBody) => void;
}

export interface MutationResult<TBody, TResult> {
  mutate: (body: TBody, opts?: { headers?: Record<string, string> }) => Promise<TResult>;
  isLoading: boolean;
  error: string | null;
}

/** Error thrown by useMutation on a non-OK response; carries the HTTP status
 *  so callers can branch (e.g. 409 → optimistic-lock conflict). */
export interface MutationHttpError extends Error {
  status?: number;
}

/**
 * Extracts the API's actual `message` from a non-OK JSON error body (the
 * shape every route sends via `toErrorResponse`: `{ error, message,
 * details? }`), falling back to a generic `HTTP <status>` when the body
 * isn't JSON or carries no usable message.
 *
 * Before this, every non-OK response collapsed to `Error('HTTP ' + status)`
 * regardless of what the server actually said — so a backend fix that
 * turned a silent no-op into a clear, actionable 4xx (e.g. "Invoice
 * INV-0001 is still a draft — issue it before sending...") still showed
 * the caller nothing but "HTTP 409". `PortalDashboard.tsx` already reads
 * `body.message` off its own raw fetch calls for the same reason; this
 * brings the shared mutation hook in line so every `useMutation` caller
 * gets it for free.
 */
async function extractApiErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string' &&
      (body as { message: string }).message.trim().length > 0
    ) {
      return (body as { message: string }).message;
    }
  } catch {
    // Non-JSON or empty error body (e.g. a proxy/edge 502 HTML page) —
    // fall through to the generic status-based message below.
  }
  return `HTTP ${response.status}`;
}

function formatErrorMessage(
  err: unknown,
  template: string | false | ((err: unknown) => string) | undefined
): string | null {
  // Toasting is opt-in: callers must pass an errorMessage to surface a toast.
  // This keeps the hook drop-in compatible with existing call-sites that
  // already render errors via their own UI.
  if (template === undefined || template === false) return null;
  if (typeof template === 'function') return template(err);
  return template;
}

/**
 * Authenticated mutation hook (P0-030).
 *
 * Every request goes through {@link useApiClient}, which sets the Clerk
 * Bearer token, cancels mid-sign-out requests with an AbortError, and
 * redirects to /login on a persistent 401. The hook's public API
 * (`{ mutate, isLoading, error }`) and the toast-options contract from
 * P0-032 are preserved.
 */
export function useMutation<TBody, TResult>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  options: MutationOptions<TBody, TResult> = {}
): MutationResult<TBody, TResult> {
  const apiFetch = useApiClient();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (body: TBody, opts?: { headers?: Record<string, string> }): Promise<TResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch(path, {
        method,
        body: JSON.stringify(body),
        ...(opts?.headers ? { headers: opts.headers } : {}),
      });
      if (!response.ok) {
        const err: MutationHttpError = new Error(await extractApiErrorMessage(response));
        err.status = response.status;
        throw err;
      }
      // Tolerate empty success bodies (204 No Content, or 200 with no
      // payload): unconditional response.json() threw a parse error and
      // reported the SUCCESSFUL mutation as a failure — error toast, error
      // state, rejected promise.
      let data: TResult;
      if (response.status === 204 || response.status === 205) {
        data = undefined as TResult;
      } else {
        try {
          data = (await response.json()) as TResult;
        } catch {
          data = undefined as TResult;
        }
      }

      // Success toast (configurable; suppress with `false`)
      if (options.successMessage !== false && options.successMessage) {
        toast.success(options.successMessage);
      }
      options.onSuccess?.(data, body);
      return data;
    } catch (err) {
      // AbortError from the apiClient means the request was cancelled
      // because no auth token was available (sign-out transition).
      // We DO NOT toast for that case — the user is being signed out.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError(null);
        throw err;
      }

      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);

      const toastMsg = formatErrorMessage(err, options.errorMessage);
      if (toastMsg !== null) {
        toast.error(toastMsg);
      }
      options.onError?.(err, body);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, method, path, options]);

  return { mutate, isLoading, error };
}
