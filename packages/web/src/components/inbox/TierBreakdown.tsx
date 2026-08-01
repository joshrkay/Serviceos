/**
 * TierBreakdown — read-only good-better-best (EE-1) display shared by the
 * standalone proposal review card (ProposalMarkers) and the chained-proposal
 * card (ProposalChainCard). Renders each tier group (label + options, the
 * default marked) and optional add-ons so the operator sees the choices they
 * are approving; the customer makes the actual selection on the public
 * estimate. Renders nothing when the estimate carries no selectable lines, so
 * flat estimates look exactly as before.
 */

export interface TierLine {
  id?: string;
  description?: string;
  /** Per-unit price in integer cents (estimate payloads use `unitPrice`). */
  unitPrice?: number;
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
}

/** Integer cents → "$1,234.50" (2-decimal, matches the estimate money display). */
function fmtCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

interface TierBreakdownModel {
  tierGroups: Array<{ key: string; label: string; options: TierLine[] }>;
  addOns: TierLine[];
}

/** Group line items into tier groups (shared groupKey) + standalone add-ons. */
export function tierBreakdownModel(lineItems: TierLine[]): TierBreakdownModel {
  const groups = new Map<string, { key: string; label: string; options: TierLine[] }>();
  const addOns: TierLine[] = [];
  for (const li of lineItems) {
    if (li.groupKey) {
      const g = groups.get(li.groupKey) ?? { key: li.groupKey, label: li.groupLabel ?? 'Options', options: [] };
      g.options.push(li);
      groups.set(li.groupKey, g);
    } else if (li.isOptional) {
      addOns.push(li);
    }
  }
  return { tierGroups: [...groups.values()], addOns };
}

/** True when the estimate carries any customer-selectable line (tier or add-on). */
export function hasTierBreakdown(lineItems: TierLine[]): boolean {
  const { tierGroups, addOns } = tierBreakdownModel(lineItems);
  return tierGroups.length > 0 || addOns.length > 0;
}

export function TierBreakdown({ lineItems }: { lineItems: TierLine[] }) {
  const { tierGroups, addOns } = tierBreakdownModel(lineItems);
  if (tierGroups.length === 0 && addOns.length === 0) return null;

  return (
    <>
      {tierGroups.map((g) => (
        <div
          key={g.key}
          data-testid="tier-group"
          className="rounded-lg border border-border bg-secondary/40 px-2.5 py-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
          <ul className="mt-1 space-y-0.5">
            {g.options.map((li, i) => (
              <li key={li.id ?? i} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  {li.isDefaultSelected && (
                    <span
                      data-testid="tier-default"
                      className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                    >
                      Default
                    </span>
                  )}
                  <span className="truncate text-foreground">{li.description}</span>
                </span>
                {typeof li.unitPrice === 'number' && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtCents(li.unitPrice)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {addOns.length > 0 && (
        <div
          data-testid="tier-addons"
          className="rounded-lg border border-border bg-secondary/40 px-2.5 py-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Optional add-ons</p>
          <ul className="mt-1 space-y-0.5">
            {addOns.map((li, i) => (
              <li key={li.id ?? i} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-foreground">
                  {li.description}
                  {li.isDefaultSelected ? ' · pre-selected' : ''}
                </span>
                {typeof li.unitPrice === 'number' && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtCents(li.unitPrice)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
