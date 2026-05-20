import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import type { FeasibilityResult } from './feasibility-types';

export interface FeasibilityPreviewInput {
  appointmentId: string;
  proposedTechnicianId: string;
  proposedScheduledStart: string;
  proposedScheduledEnd: string;
}

const DEBOUNCE_MS = 150;

export function useFeasibilityPreview(input: FeasibilityPreviewInput | null): {
  preview: FeasibilityResult | null;
  isLoading: boolean;
} {
  const [preview, setPreview] = useState<FeasibilityResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!input) {
      setPreview(null);
      return;
    }
    timerRef.current = setTimeout(async () => {
      const myReqId = ++reqIdRef.current;
      setIsLoading(true);
      try {
        const res = await apiFetch('/api/dispatch/check-feasibility', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (myReqId !== reqIdRef.current) return;
        if (!res.ok) {
          setPreview(null);
          return;
        }
        setPreview(await res.json() as FeasibilityResult);
      } finally {
        if (myReqId === reqIdRef.current) setIsLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [input?.appointmentId, input?.proposedTechnicianId, input?.proposedScheduledStart, input?.proposedScheduledEnd]);

  return { preview, isLoading };
}
