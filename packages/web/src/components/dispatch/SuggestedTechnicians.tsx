import React, { useCallback, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatTimeInTenantTz } from '../../utils/formatInTenantTz';

/** Mirrors `SuggestionOverlap` in api src/scheduling/suggest-technicians.ts. */
export interface SuggestionOverlap {
  appointmentId: string;
  jobSummary: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  overlapMinutes: number;
}

/** Mirrors `TechnicianSuggestion` in api src/scheduling/suggest-technicians.ts. */
export interface TechnicianSuggestion {
  technicianId: string;
  name: string;
  feasible: boolean;
  reasons: string[];
  warningCount: number;
  travelFromPrevSeconds: number | null;
  travelEstimateSource: 'google' | 'haversine' | 'unknown' | null;
  travelUnverified: boolean;
  isCurrent: boolean;
  overlaps: SuggestionOverlap[];
}

/** How many ranked techs the card shows; the rest are a drag away. */
export const SHOWN_SUGGESTIONS = 3;

export function travelLabel(
  s: Pick<TechnicianSuggestion, 'travelFromPrevSeconds' | 'travelUnverified'>,
): string {
  if (s.travelFromPrevSeconds === null) {
    return s.travelUnverified
      ? 'Drive time unknown (an address is not on the map)'
      : 'No earlier visit to drive from';
  }
  const minutes = Math.max(1, Math.round(s.travelFromPrevSeconds / 60));
  return `${minutes} min from previous visit`;
}

/** "Overlaps by 30 min: Boiler service, 1:30 PM–3:00 PM" in the tenant's timezone. */
export function overlapLabel(o: SuggestionOverlap, timezone: string): string {
  const window = `${formatTimeInTenantTz(o.scheduledStart, timezone)}–${formatTimeInTenantTz(o.scheduledEnd, timezone)}`;
  return `Overlaps by ${o.overlapMinutes} min: ${o.jobSummary ?? 'another visit'}, ${window}`;
}

/** Blocked only because of clashing visits (not skills, hours or time off). */
function bookedOnly(s: TechnicianSuggestion): boolean {
  // `reasons` is blocking reasons then warnings; only the blocking ones must all be clashes.
  const blockingCount = s.reasons.length - s.warningCount;
  return !s.feasible && s.overlaps.length > 0 && blockingCount === s.overlaps.length;
}

function OverlapAlerts({ booked, timezone }: { booked: TechnicianSuggestion[]; timezone: string }) {
  if (booked.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-1" data-testid="suggest-techs-overlaps">
      {booked.slice(0, SHOWN_SUGGESTIONS).map((s) => (
        <li
          key={s.technicianId}
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          data-testid="suggest-techs-overlap"
        >
          <span className="block text-sm font-medium break-words">{s.name} is booked</span>
          {s.overlaps.map((o) => (
            <span key={o.appointmentId} className="block break-words">
              {overlapLabel(o, timezone)}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
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
  | { kind: 'loaded'; suggestions: TechnicianSuggestion[]; partialNote: string | null };

/** The API checks a bounded number of techs; say so rather than imply the answer covers everyone. */
export function partialNote(checked: number, total: number | undefined, truncated: boolean | undefined): string | null {
  if (!truncated || !total) return null;
  return `Checked ${checked} of ${total} technicians.`;
}

/**
 * Dispatch FR-2 phase 3 — "who should take this?" for an unassigned visit.
 * Loads on tap (each load runs a feasibility check per technician), ranks
 * feasible techs by drive from their previous visit, and hands a pick to the
 * board, which confirms it as a reassign_appointment proposal.
 */
export function SuggestedTechnicians({ appointmentId, onPick }: SuggestedTechniciansProps) {
  const timezone = useTenantTimezone();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await apiFetch(
        `/api/dispatch/appointments/${encodeURIComponent(appointmentId)}/suggested-technicians`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        suggestions?: TechnicianSuggestion[];
        totalTechnicians?: number;
        truncated?: boolean;
      };
      const suggestions = json.suggestions ?? [];
      setState({
        kind: 'loaded',
        suggestions,
        partialNote: partialNote(suggestions.length, json.totalTechnicians, json.truncated),
      });
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
  const booked = state.suggestions.filter((s) => bookedOnly(s) && !s.isCurrent);
  if (feasible.length === 0) {
    const firstBlocked = state.suggestions.find((s) => !s.feasible && !bookedOnly(s));
    return (
      <div className="mt-1">
        <p className="text-xs text-muted-foreground" data-testid="suggest-techs-none">
          {state.partialNote ? 'None of the technicians checked is' : 'No technician is'} free for this visit at
          its current time
          {booked.length === 0 && firstBlocked?.reasons[0] ? ` (${firstBlocked.name}: ${firstBlocked.reasons[0]})` : ''}.
        </p>
        {state.partialNote && <PartialNote text={state.partialNote} />}
        <OverlapAlerts booked={booked} timezone={timezone} />
      </div>
    );
  }

  return (
    <div className="mt-1">
      <ul className="flex flex-col gap-1" data-testid="suggest-techs-list">
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
      <OverlapAlerts booked={booked} timezone={timezone} />
      {state.partialNote && <PartialNote text={state.partialNote} />}
    </div>
  );
}

function PartialNote({ text }: { text: string }) {
  return (
    <p className="mt-1 text-xs text-muted-foreground" data-testid="suggest-techs-partial">
      {text} Drag the visit to a lane to pick someone else.
    </p>
  );
}
