import { useState, useCallback } from 'react';

export interface MutationResult<TResult> {
  mutate: (body: unknown) => Promise<TResult>;
  isLoading: boolean;
  error: string | null;
}

export function useMutation<TBody, TResult>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string
): MutationResult<TResult> {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (body: TBody): Promise<TResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
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
