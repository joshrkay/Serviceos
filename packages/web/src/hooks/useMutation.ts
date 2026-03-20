import { useState, useCallback } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface MutationResult<TBody, TResult> {
  mutate: (body: TBody) => Promise<TResult>;
  isLoading: boolean;
  error: string | null;
}

export function useMutation<TBody, TResult>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string
): MutationResult<TBody, TResult> {
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
      return await response.json() as TResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [method, path]);

  return { mutate, isLoading, error };
}
