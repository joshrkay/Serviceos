import { useEffect, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { formatCurrency } from '../../utils/currency';
import type { CatalogPickItem } from './catalogToLineItem';

export interface CatalogPickerProps {
  /** Called with the chosen catalog item; the caller maps it to a line item. */
  onPick: (item: CatalogPickItem) => void;
}

/**
 * "Add from Price Book" typeahead. A trigger button opens a popover with a
 * search box; typing queries `GET /api/catalog/items?search=…` server-side
 * (via {@link useListQuery}, which handles auth + request versioning), and
 * clicking a result hands it to `onPick`. The query is debounced so each
 * keystroke does not fire a request.
 */
export function CatalogPicker({ onPick }: CatalogPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Only fetch while the popover is open. setSearch drives the server-side
  // `search` param; data comes back as { data: CatalogPickItem[] }.
  const { data, isLoading, error, setSearch } = useListQuery<CatalogPickItem>(
    '/api/catalog/items',
    { pageSize: 20, enabled: open }
  );

  // useListQuery returns whatever the API sends; guard against a non-array
  // error payload so .map / .length can't throw.
  const items = Array.isArray(data) ? data : [];

  // Track whether a query has actually run since the popover opened, so the
  // empty state doesn't flash before the first fetch settles.
  useEffect(() => {
    if (!open) setHasLoaded(false);
  }, [open]);
  useEffect(() => {
    if (isLoading) setHasLoaded(true);
  }, [isLoading]);

  // Debounce the input → server search (250ms).
  useEffect(() => {
    const handle = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(handle);
  }, [query, setSearch]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  function handlePick(item: CatalogPickItem) {
    onPick(item);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        data-testid="catalog-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-xs rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50"
      >
        <Plus size={12} /> Add from Price Book
      </button>

      {open && (
        <div
          data-testid="catalog-picker-popover"
          className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              autoFocus
              aria-label="search-price-book"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search price book…"
              className="w-full text-sm outline-none placeholder:text-slate-400"
            />
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {isLoading && <p className="px-3 py-2 text-xs text-slate-500">Searching…</p>}
            {!isLoading && error && (
              <p className="px-3 py-2 text-xs text-red-600">Couldn’t load the price book.</p>
            )}
            {!isLoading && !error && hasLoaded && items.length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-500">No matching items.</p>
            )}
            {!isLoading &&
              !error &&
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePick(item)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                >
                  <span className="flex-1 min-w-0 truncate text-sm text-slate-800">{item.name}</span>
                  {item.category && (
                    <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                      {item.category}
                    </span>
                  )}
                  <span className="shrink-0 text-sm text-slate-600">
                    {formatCurrency(item.unitPriceCents)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
