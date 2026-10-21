import React, { useCallback, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';

/** Mirrors `TechnicianSuggestion` in api src/scheduling/suggest-technicians.ts. */
export interface TechnicianSuggestion {
  technicianId: string;
  name: string;
  feasible: boolean;
  reasons: string[];
  warningCount: number;
  travelFromPrevSeconds: number | null;
  travelEstimateSource: 'google' | 'haversine' | 'unknown' | null;
  isCurrent: boolean;
}

/** How many ranked techs the card shows; the rest are a drag away. */
export const SHOWN_SUGGESTIONS = 3;

export function travelLabel(s: Pick<TechnicianSuggestion, 'travelFromPrevSeconds'>): string {
  if (s.travelFromPrevSeconds === null) return 'No earlier visit to drive from';
  const minutes = Math.max(1, Math.round(s.travelFromPrevSeconds / 60));
  return `${minutes} min from previous visit`;
}

export interface SuggestedTechniciansProps {
  appointmentId: string;
  /** Opens the confirm-proposal dialog for a reassign to this technician. */
  onPick: (appointmentId: string, technicianId: string, technicianName: string) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; suggestions: TechnicianSuggestion[] };

/**
 * Dispatch FR-2 phase 3 — "who should take this?" for an unassigned visit.
 * Loads on tap (each load runs a feasibility check per technician), ranks
 * feasible techs by drive from their previous visit, and hands a pick to the
 * board, which confirms it as a reassign_appointment proposal.
 */
export function SuggestedTechnicians({ appointmentId, onPick }: SuggestedTechniciansProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await apiFetch(
        `/api/dispatch/appointments/${encodeURIComponent(appointmentId)}/suggested-technicians`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { suggestions?: TechnicianSuggestion[] };
      setState({ kind: 'loaded', suggestions: json.suggestions ?? [] });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not load suggestions',
      });
    }
  }, [appointmentId]);

  if (state.kind === 'idle' || state.kind === 'error') {
    return (
      <div className="mt-1" data-testid={`suggest-techs-${appointmentId}`}>
        <button
          type="button"
          className="min-h-11 w-full rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
          onClick={() => void load()}
          data-testid="suggest-techs-button"
        >
          {state.kind === 'error' ? 'Retry suggestions' : 'Suggest a tech'}
        </button>
        {state.kind === 'error' && (
          <p className="mt-1 text-xs text-destructive" role="alert">
            Could not load suggestions ({state.message}).
          </p>
        )}
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-testid="suggest-techs-loading">
        Checking technicians…
      </p>
    );
  }

  const feasible = state.suggestions.filter((s) => s.feasible && !s.isCurrent);
  if (feasible.length === 0) {
    const firstBlocked = state.suggestions.find((s) => !s.feasible);
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-testid="suggest-techs-none">
        No technician can take this visit at its current time
        {firstBlocked?.reasons[0] ? ` (${firstBlocked.name}: ${firstBlocked.reasons[0]})` : ''}.
      </p>
    );
  }

  return (
    <ul className="mt-1 flex flex-col gap-1" data-testid="suggest-techs-list">
      {feasible.slice(0, SHOWN_SUGGESTIONS).map((s, i) => (
        <li key={s.technicianId}>
          <button
            type="button"
            className="flex min-h-11 w-full flex-col items-start justify-center rounded-md border border-border px-3 py-1 text-left hover:bg-muted"
            onClick={() => onPick(appointmentId, s.technicianId, s.name)}
            data-testid="suggest-techs-pick"
          >
            <span className="text-sm font-medium break-words">
              {i === 0 ? 'Suggested: ' : ''}
              {s.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {travelLabel(s)}
              {s.warningCount > 0 ? ` · ${s.warningCount} warning${s.warningCount === 1 ? '' : 's'}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
