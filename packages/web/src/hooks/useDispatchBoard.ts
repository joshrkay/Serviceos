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

  const dateParam = toDateParam(selectedDate);

  const fetchBoard = useCallback(
    async (opts?: { background?: boolean }) => {
      const myVersion = ++requestVersionRef.current;
      // Foreground loads (initial mount, date change) show the loading state.
      // Background refreshes (focus, SSE board_updated, proposal events) keep
      // the current board mounted so an in-progress drag and scroll position
      // survive the refresh.
      if (!opts?.background) setIsLoading(true);
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
        setData(result);
      } catch (err) {
        if (myVersion !== requestVersionRef.current) return;
        // Don't tear the board down for a transient background failure — the
        // last-good snapshot stays visible and the next poll/stream retries.
        if (opts?.background) return;
        setError(err instanceof Error ? err.message : 'Failed to load dispatch board');
      } finally {
        if (myVersion === requestVersionRef.current && !opts?.background) {
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
