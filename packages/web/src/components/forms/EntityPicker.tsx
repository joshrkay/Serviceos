import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Input, Button } from '../ui';

export interface EntityPickerProps<T> {
  value: T | null;
  onChange: (value: T | null) => void;
  /** Test/perf override; defaults to 300ms per the original CustomerPicker spec. */
  debounceMs?: number;
  required?: boolean;
  /** Builds the search URL for `apiFetch`, e.g. `/api/customers?search=<enc>&limit=10`. */
  buildSearchUrl: (search: string) => string;
  getId: (item: T) => string;
  displayLabel: (item: T) => string;
  placeholder: string;
  requiredPlaceholder: string;
  ariaLabel: string;
  /** Container + results-list + empty-state testid root, e.g. 'customer-picker'. */
  testIdPrefix: string;
  /** Per-option testid prefix, e.g. 'customer-option' -> 'customer-option-<id>'. */
  optionTestIdPrefix: string;
  /** Row shown for a completed, zero-result search, e.g. 'No matching jobs'. */
  emptyStateLabel: string;
}

/**
 * #908 — shared typeahead base for CustomerPicker and JobPicker. JobPicker
 * was cloned from CustomerPicker (#879) and had drifted in two ways found in
 * review: only JobPicker showed an explicit empty state for a zero-result
 * search (CustomerPicker just showed nothing), and only JobPicker's option
 * buttons carried the `min-h-11` tap-target class. Both callers now
 * configure this one implementation instead of carrying their own copy, so
 * a future fix (or drift) can't land in only one of them again.
 *
 * Owns: debounce, in-flight request cancellation (a stale response landing
 * after a newer one could otherwise overwrite fresher results — aborting
 * the previous fetch when a new one starts closes that race; neither picker
 * did this before), the dropdown/empty-state rendering, and select/clear.
 * Does NOT own close-on-blur — neither original picker had it, so adding it
 * here would be new behavior, not a preserved refactor; left as a filed
 * follow-up if wanted (#908 PR description).
 */
export function EntityPicker<T>({
  value,
  onChange,
  debounceMs = 300,
  required,
  buildSearchUrl,
  getId,
  displayLabel,
  placeholder,
  requiredPlaceholder,
  ariaLabel,
  testIdPrefix,
  optionTestIdPrefix,
  emptyStateLabel,
}: EntityPickerProps<T>) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // True once a non-empty search has completed — gates the empty state so it
  // can't show before the first search resolves.
  const [searched, setSearched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (search: string) => {
      if (!search.trim()) {
        setResults([]);
        setSearched(false);
        return;
      }
      // Cancel a still-in-flight previous search so its response — if it
      // resolves after this one — can't overwrite fresher results.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const res = await apiFetch(buildSearchUrl(search), { signal: controller.signal });
        if (!res.ok) {
          setResults([]);
          return;
        }
        const json = await res.json();
        const data: T[] = Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json)
          ? json
          : [];
        setResults(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setResults([]);
      } finally {
        // Only the still-current controller's finally block should flip
        // loading/searched off — an aborted, earlier search's finally must
        // not clobber the state a newer search already set.
        if (abortRef.current === controller) {
          setLoading(false);
          setSearched(true);
          abortRef.current = null;
        }
      }
    },
    [buildSearchUrl],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      runSearch(query);
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, debounceMs, runSearch]);

  // Unmount: cancel any in-flight request so its resolution never calls
  // setState on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const onSelect = useCallback(
    (item: T) => {
      onChange(item);
      setOpen(false);
      setQuery(displayLabel(item));
    },
    [onChange, displayLabel],
  );

  const onClear = useCallback(() => {
    onChange(null);
    setQuery('');
    setResults([]);
    setSearched(false);
  }, [onChange]);

  return (
    <div data-testid={testIdPrefix} className="relative">
      <div className="flex gap-2">
        <Input
          aria-label={ariaLabel}
          value={value ? displayLabel(value) : query}
          onChange={(e) => {
            if (value) onChange(null);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={required ? requiredPlaceholder : placeholder}
          className="min-h-11"
        />
        {value && (
          <Button type="button" variant="outline" size="sm" onClick={onClear} className="min-h-11">
            Clear
          </Button>
        )}
      </div>
      {open && !value && query.trim() !== '' && (results.length > 0 || loading || searched) && (
        <ul
          data-testid={`${testIdPrefix}-results`}
          className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-sm max-h-60 overflow-auto"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
          )}
          {!loading && searched && results.length === 0 && (
            <li
              data-testid={`${testIdPrefix}-empty`}
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              {emptyStateLabel}
            </li>
          )}
          {results.map((item) => (
            <li key={getId(item)}>
              <button
                type="button"
                data-testid={`${optionTestIdPrefix}-${getId(item)}`}
                onClick={() => onSelect(item)}
                className="block w-full min-h-11 text-left px-3 py-2 text-sm hover:bg-secondary"
              >
                {displayLabel(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
