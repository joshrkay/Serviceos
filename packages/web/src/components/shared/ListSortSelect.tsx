/**
 * #1402 — the ONE web sort control for server-sorted lists (estimates,
 * invoices, customers). Field allowlists live in `@ai-service-os/shared`
 * list-sort (ESTIMATE_LIST_SORT / INVOICE_LIST_SORT / CUSTOMER_LIST_SORT);
 * a page declares its options with those field types and merges
 * {@link listSortParams} into its list-query filters, so the API does the
 * ordering (a client-side sort would only reorder the loaded page).
 */
import type { ListSort, ListSortSpec } from '@ai-service-os/shared';

export interface ListSortOption<F extends string> extends ListSort<F> {
  label: string;
}

/**
 * Query params for a sort: `{}` for the list's default ordering (so default
 * requests are unchanged), otherwise `{ sortBy, sort }`.
 */
export function listSortParams<F extends string>(
  spec: ListSortSpec<F>,
  sort: ListSort<F>,
): Record<string, string> {
  if (sort.field === spec.defaultField && sort.direction === spec.fields[spec.defaultField]) return {};
  return { sortBy: sort.field, sort: sort.direction };
}

const encode = (s: ListSort<string>) => `${s.field}:${s.direction}`;

export function ListSortSelect<F extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Accessible name, e.g. "Sort invoices". */
  label: string;
  options: ReadonlyArray<ListSortOption<F>>;
  value: ListSort<F>;
  onChange: (next: ListSort<F>) => void;
}) {
  return (
    <select
      aria-label={label}
      value={encode(value)}
      onChange={(e) => {
        const next = options.find((o) => encode(o) === e.target.value);
        if (next) onChange({ field: next.field, direction: next.direction });
      }}
      className="w-full min-w-0 min-h-11 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
    >
      {options.map((o) => (
        <option key={encode(o)} value={encode(o)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
