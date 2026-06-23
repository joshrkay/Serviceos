import { useCallback, useState } from 'react';

export type SavePhase = 'idle' | 'saving' | 'saved' | 'error';

/** Local UI phase for save→success flows (idle → saving → saved). */
export function useSavePhase() {
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setPhase('saving');
    setError(null);
    try {
      await fn();
      setPhase('saved');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  return { phase, error, run, reset };
}
