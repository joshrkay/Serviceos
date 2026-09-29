/**
 * #1402 — API half of the shared list-sort pattern (contract + allowlists in
 * `@ai-service-os/shared` list-sort). Routes parse `?sortBy=&sort=` with
 * {@link parseListSortQuery}; Pg repositories turn the resolved sort into an
 * ORDER BY with {@link sqlOrderBy} (column SQL comes from the repository's
 * own allowlisted map, never from the request); in-memory repositories use
 * {@link compareByListSort} so both implementations order identically.
 */
import {
  resolveListSort,
  ListSortError,
  type ListSort,
  type ListSortSpec,
} from '@ai-service-os/shared';
import { ValidationError } from './errors';

export type { ListSort, ListSortSpec };

export function parseListSortQuery<F extends string>(
  spec: ListSortSpec<F>,
  query: { sortBy?: unknown; sort?: unknown },
): ListSort<F> {
  try {
    return resolveListSort(spec, query);
  } catch (err) {
    if (err instanceof ListSortError) throw new ValidationError(err.message);
    throw err;
  }
}

/**
 * `ORDER BY <column> <dir> NULLS LAST, <tiebreak> <dir>` — the id tiebreak
 * keeps pagination stable when many rows share a value.
 */
export function sqlOrderBy<F extends string>(
  sort: ListSort<F>,
  columns: Record<F, string>,
  tiebreak = 'id',
): string {
  const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${columns[sort.field]} ${dir} NULLS LAST, ${tiebreak} ${dir}`;
}

/**
 * Sort expression for "customer name" on a job-scoped document table
 * (estimates / invoices carry only job_id): resolves job → customer,
 * tenant-scoped on both hops alongside RLS.
 */
export function customerNameViaJobSql(table: 'estimates' | 'invoices'): string {
  return `(SELECT lower(c.display_name) FROM jobs j
    JOIN customers c ON c.id = j.customer_id AND c.tenant_id = j.tenant_id
    WHERE j.id = ${table}.job_id AND j.tenant_id = ${table}.tenant_id)`;
}

type SortValue = string | number | Date | undefined | null;

/** In-memory twin of {@link sqlOrderBy} (nulls last, case-insensitive text). */
export function compareByListSort<T extends { id: string }, F extends string>(
  sort: ListSort<F>,
  accessors: Record<F, (row: T) => SortValue>,
): (a: T, b: T) => number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const norm = (v: SortValue) =>
    v instanceof Date ? v.getTime() : typeof v === 'string' ? v.toLowerCase() : v;
  return (a, b) => {
    const va = norm(accessors[sort.field](a));
    const vb = norm(accessors[sort.field](b));
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return (va < vb ? -1 : 1) * sign;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
  };
}
