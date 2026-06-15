import { useState } from 'react';
import { formatCurrency } from '../../utils/currency';

/**
 * P2-035 (U2) — one-tap ambiguity picker.
 *
 * When the catalog resolver couldn't pin a single catalog item for a line
 * ("water heater" → 40-gal vs 50-gal), it surfaces the top candidates
 * under `sourceContext.catalogResolution[lineIndex]`. This card renders
 * those candidates as one-tap chips (mirroring ClarificationCard's
 * one-tap-option UX and CatalogPicker's price display). Picking one POSTs
 * to `/api/proposals/:id/resolve-line`, which stamps the chosen catalog
 * price and moves the proposal to `ready_for_review`.
 *
 * Catalog-grounding invariant: only the resolver-surfaced candidates are
 * offered — the operator can never type a free price here.
 */

/** A resolver-surfaced candidate, as stored under catalogResolution[idx]. */
export interface AmbiguityCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
}

export interface AmbiguityPickerProps {
  /** The 0-based line index the candidates resolve. */
  lineIndex: number;
  /** The ambiguous line's description (for the prompt). */
  description: string;
  /** Candidates to choose from (max 3, resolver-ordered). */
  candidates: AmbiguityCandidate[];
  /**
   * Resolve handler. Receives the chosen catalogItemId; should POST to the
   * resolve-line endpoint and resolve/throw. The picker awaits it and, on a
   * thrown error (or rejected promise), reverts the optimistic "picked"
   * state so a failed resolve never looks successful.
   */
  onResolve: (lineIndex: number, catalogItemId: string) => Promise<void>;
}

export function AmbiguityPicker({
  lineIndex,
  description,
  candidates,
  onResolve,
}: AmbiguityPickerProps) {
  // Optimistic chosen id: set immediately on tap so the chip reflects the
  // pick, reverted to null if the POST fails (mirrors InboxPage's
  // optimistic-update + revert-on-failure pattern).
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handlePick(catalogItemId: string) {
    if (pickingId) return; // ignore double-taps while a resolve is in flight
    setPickingId(catalogItemId);
    setError(null);
    try {
      await onResolve(lineIndex, catalogItemId);
    } catch {
      // Revert so the operator can try again — a failed resolve must not
      // leave a chip stuck in the "picked" state.
      setPickingId(null);
      setError('Couldn’t set that price. Please try again.');
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
      data-testid="ambiguity-picker"
      data-line-index={lineIndex}
    >
      <p className="text-xs font-medium text-amber-900">
        Which item is “{description}”?
      </p>
      <p className="text-[11px] text-amber-700 mt-0.5">
        Pick one to set the price from your catalog.
      </p>

      <div className="mt-2 flex flex-col gap-1.5">
        {candidates.map((candidate) => {
          const isPicked = pickingId === candidate.id;
          return (
            <button
              key={candidate.id}
              type="button"
              data-testid={`ambiguity-candidate-${candidate.id}`}
              disabled={pickingId !== null}
              onClick={() => handlePick(candidate.id)}
              // min-h-11 = 44px tap target (mobile/public UI contract).
              className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                isPicked
                  ? 'border-green-300 bg-green-50'
                  : 'border-amber-200 bg-white hover:bg-amber-100 disabled:opacity-60'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                {candidate.name}
              </span>
              <span className="shrink-0 text-sm font-medium text-slate-700">
                {formatCurrency(candidate.unitPriceCents)}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="mt-1.5 text-xs text-red-600" data-testid="ambiguity-picker-error">
          {error}
        </p>
      )}
    </div>
  );
}
