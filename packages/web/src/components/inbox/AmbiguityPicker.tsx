import { useState } from 'react';
import { formatCurrency } from '../../utils/currency';

/**
 * U2 (P2-035) — one-tap picker for an ambiguous catalog line.
 *
 * The catalog resolver surfaced more than one candidate SKU for a drafted
 * line and left the proposal in `draft` until the owner picks one. Each
 * candidate is a ≥44px tap target (min-h-11) so it works gloved-in-a-truck on
 * a 320px screen. Picking POSTs to `/api/proposals/:id/resolve-line` (owned by
 * the parent) which stamps the catalog price and moves the proposal to
 * ready_for_review — it never approves or executes.
 */
export interface AmbiguityCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
}

interface Props {
  lineDescription: string;
  candidates: AmbiguityCandidate[];
  /** Resolves the line to the chosen catalog item id. Parent owns the POST. */
  onPick: (catalogItemId: string) => Promise<void>;
}

export function AmbiguityPicker({ lineDescription, candidates, onPick }: Props) {
  const [pending, setPending] = useState<string | null>(null);

  async function pick(id: string): Promise<void> {
    if (pending) return;
    setPending(id);
    try {
      await onPick(id);
    } catch {
      // The parent surfaces the error; re-enable so the owner can retry.
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
      data-testid="ambiguity-picker"
    >
      <p className="text-xs text-amber-900">
        Which item for “{lineDescription}”?
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={pending !== null}
            onClick={() => {
              void pick(c.id);
            }}
            data-testid="ambiguity-option"
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-left text-sm text-slate-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="shrink-0 tabular-nums text-slate-600">
              {pending === c.id ? 'Saving…' : formatCurrency(c.unitPriceCents)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
