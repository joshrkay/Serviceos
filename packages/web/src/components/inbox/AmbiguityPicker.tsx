import { useState } from 'react';
import { formatCurrency } from '../../utils/currency';

/**
 * U2 (P2-035) — one-tap picker for an ambiguous catalog line.
 * U8 (E9) — also reused for an ambiguous ENTITY reference ("which Bob?"): the
 * same chip list, but each candidate carries a `label` (+ optional `hint`)
 * instead of a catalog price. Picking POSTs to `/api/proposals/:id/resolve-line`
 * (catalog) or `/api/proposals/:id/resolve-entity` (entity) — both owned by the
 * parent — which re-drafts the proposal and moves it to ready_for_review;
 * neither approves or executes.
 *
 * Each candidate is a ≥44px tap target (min-h-11) so it works gloved-in-a-truck
 * on a 320px screen.
 */
export interface AmbiguityCandidate {
  id: string;
  /** Catalog SKU name (catalog mode). */
  name?: string;
  /** Entity label, e.g. "Bob Smith (555-0100)" (entity mode). */
  label?: string;
  /** Secondary entity detail shown beside the label (entity mode). */
  hint?: string;
  /** Catalog price in integer cents (catalog mode). */
  unitPriceCents?: number;
  score: number;
}

interface Props {
  lineDescription: string;
  candidates: AmbiguityCandidate[];
  /** Resolves the line/reference to the chosen id. Parent owns the POST. */
  onPick: (candidateId: string) => Promise<void>;
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
      className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
      data-testid="ambiguity-picker"
    >
      <p className="text-xs text-warning">
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
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-warning/30 bg-card px-3 py-2 text-left text-sm text-foreground hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">{c.name ?? c.label ?? c.id}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {pending === c.id
                ? 'Saving…'
                : typeof c.unitPriceCents === 'number'
                  ? formatCurrency(c.unitPriceCents)
                  : (c.hint ?? '')}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
