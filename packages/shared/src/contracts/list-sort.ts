/**
 * #1402 — the ONE list-sort contract shared by the API list routes and the
 * web sort control. A list declares its allowlisted sort fields and each
 * field's natural direction (money / dates newest-or-largest first, names
 * A→Z). Over the wire: `?sortBy=<field>&sort=asc|desc`. `sort` alone is the
 * legacy P1-018 direction flip of the list's default field.
 */
export type ListSortDirection = 'asc' | 'desc';

export interface ListSortSpec<F extends string> {
  /** Allowlisted fields → their natural direction when `sort` is omitted. */
  fields: Record<F, ListSortDirection>;
  /** Field used when `sortBy` is omitted. */
  defaultField: F;
}

export interface ListSort<F extends string> {
  field: F;
  direction: ListSortDirection;
}

export const ESTIMATE_LIST_SORT = {
  fields: { created: 'desc', total: 'desc', customer: 'asc' },
  defaultField: 'created',
} as const satisfies ListSortSpec<string>;
export type EstimateSortField = keyof typeof ESTIMATE_LIST_SORT.fields;

export const INVOICE_LIST_SORT = {
  fields: { created: 'desc', due: 'asc', total: 'desc', customer: 'asc' },
  defaultField: 'created',
} as const satisfies ListSortSpec<string>;
export type InvoiceSortField = keyof typeof INVOICE_LIST_SORT.fields;

export const CUSTOMER_LIST_SORT = {
  fields: { name: 'asc', created: 'desc' },
  defaultField: 'name',
} as const satisfies ListSortSpec<string>;
export type CustomerSortField = keyof typeof CUSTOMER_LIST_SORT.fields;

export class ListSortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListSortError';
  }
}

/**
 * Resolve `?sortBy=&sort=` against a list's allowlist. Unknown fields or
 * directions throw {@link ListSortError} (routes map it to a 400) — a sort
 * value is never interpolated into SQL unless it is an allowlisted key.
 */
export function resolveListSort<F extends string>(
  spec: ListSortSpec<F>,
  query: { sortBy?: unknown; sort?: unknown },
): ListSort<F> {
  const { sortBy, sort } = query;
  let field = spec.defaultField;
  if (sortBy !== undefined) {
    if (typeof sortBy !== 'string' || !Object.prototype.hasOwnProperty.call(spec.fields, sortBy)) {
      throw new ListSortError(`sortBy must be one of ${Object.keys(spec.fields).join(', ')}`);
    }
    field = sortBy as F;
  }
  if (sort !== undefined && sort !== 'asc' && sort !== 'desc') {
    throw new ListSortError('sort must be asc or desc');
  }
  return { field, direction: (sort as ListSortDirection | undefined) ?? spec.fields[field] };
}
