import { useState, useEffect, useCallback, useRef } from 'react';
import { TechnicianLaneData, BoardSummary, DispatchBoardData } from '../types/dispatch';
import { apiFetch } from '../utils/api-fetch';

export type { TechnicianLaneData, BoardSummary, DispatchBoardData };

export interface UseDispatchBoardResult {
  data: DispatchBoardData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

function toDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useDispatchBoard(
  selectedDate: Date,
  timezone?: string
): UseDispatchBoardResult {
  const [data, setData] = useState<DispatchBoardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id: an older, slower response must never overwrite a
  // newer one when the dispatcher pages quickly between days.
  const requestVersionRef = useRef(0);
  // Tracks whether a board has ever loaded. The "background" (keep-mounted,
  // suppress loading/error) treatment is only safe once there's a last-good
  // board to keep showing — otherwise a focus/SSE refresh racing the initial
  // load, or a Retry after the first load failed, would suppress the loading
  // clear and the error and leave an empty, errorless board.
  const hasDataRef = useRef(false);

  const dateParam = toDateParam(selectedDate);

  const fetchBoard = useCallback(
    async (opts?: { background?: boolean }) => {
      const myVersion = ++requestVersionRef.current;
      // Background only applies when a board is already on screen. Foreground
      // (initial mount, date change, retry-from-empty) shows the loading state
      // and surfaces errors; background refreshes (focus, SSE board_updated,
      // proposal events) keep the current board mounted so an in-progress drag
      // and scroll position survive.
      const background = opts?.background === true && hasDataRef.current;
      if (!background) setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ date: dateParam });
        if (timezone) {
          params.set('timezone', timezone);
        }

        const response = await apiFetch(`/api/dispatch/board?${params.toString()}`);
        if (myVersion !== requestVersionRef.current) return;
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Session expired — please reload.');
          }
          throw new Error(`Failed to load dispatch board: ${response.statusText}`);
        }
        const result = await response.json();
        if (myVersion !== requestVersionRef.current) return;
        hasDataRef.current = true;
        setData(result);
      } catch (err) {
        if (myVersion !== requestVersionRef.current) return;
        // Don't tear the board down for a transient background failure — the
        // last-good snapshot stays visible and the next poll/stream retries.
        if (background) return;
        setError(err instanceof Error ? err.message : 'Failed to load dispatch board');
      } finally {
        if (myVersion === requestVersionRef.current && !background) {
          setIsLoading(false);
        }
      }
    },
    [dateParam, timezone]
  );

  useEffect(() => {
    void fetchBoard();
  }, [fetchBoard]);

  const refetch = useCallback(() => {
    void fetchBoard({ background: true });
  }, [fetchBoard]);

  return { data, isLoading, error, refetch };
}
