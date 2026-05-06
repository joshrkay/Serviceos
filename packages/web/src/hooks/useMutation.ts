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
  mutate: (body: TBody) => Promise<TResult>;
  isLoading: boolean;
  error: string | null;
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

  const mutate = useCallback(async (body: TBody): Promise<TResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch(path, {
        method,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as TResult;

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
