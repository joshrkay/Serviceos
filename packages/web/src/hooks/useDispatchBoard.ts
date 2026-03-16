import { useState, useEffect, useCallback } from 'react';
import { TechnicianLaneData, BoardSummary, DispatchBoardData } from '../types/dispatch';

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

  const fetchBoard = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        date: toDateParam(selectedDate),
      });
      if (timezone) {
        params.set('timezone', timezone);
      }

      const response = await fetch(`/api/dispatch/board?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to load dispatch board: ${response.statusText}`);
      }
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispatch board');
    } finally {
      setIsLoading(false);
    }
  }, [selectedDate, timezone]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  return { data, isLoading, error, refetch: fetchBoard };
}
