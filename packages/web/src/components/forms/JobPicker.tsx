import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Input, Button } from '../ui';

export interface JobOption {
  id: string;
  jobNumber?: string;
  summary?: string;
  customer?: { displayName?: string };
}

export interface JobPickerProps {
  value: JobOption | null;
  onChange: (job: JobOption | null) => void;
  /** Test/perf override; defaults to 300ms to match CustomerPicker. */
  debounceMs?: number;
  required?: boolean;
}

function displayLabel(j: JobOption): string {
  const head = [j.jobNumber, j.summary].filter(Boolean).join(' — ');
  const customer = j.customer?.displayName;
  if (head && customer) return `${head} (${customer})`;
  return head || customer || j.id;
}

/**
 * Searchable job typeahead (#879), cloned from CustomerPicker. Searches
 * GET /api/jobs?search= (matches summary OR jobNumber server-side) and
 * renders `JOB-#### — summary (customer)` options. Unlike CustomerPicker
 * it renders an explicit "No matching jobs" row for a zero-result search
 * (#872 sweep minor 16) instead of silently showing nothing.
 */
export function JobPicker({
  value,
  onChange,
  debounceMs = 300,
  required,
}: JobPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JobOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // True once a non-empty search has completed — gates the empty state so it
  // can't show before the first search resolves.
  const [searched, setSearched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (search: string) => {
    if (!search.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const url = `/api/jobs?search=${encodeURIComponent(search)}&limit=10`;
      const res = await apiFetch(url);
      if (!res.ok) {
        setResults([]);
        return;
      }
      const json = await res.json();
      const data: JobOption[] = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json)
        ? json
        : [];
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      runSearch(query);
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, debounceMs, runSearch]);

  const onSelect = useCallback(
    (j: JobOption) => {
      onChange(j);
      setOpen(false);
      setQuery(displayLabel(j));
    },
    [onChange]
  );

  const onClear = useCallback(() => {
    onChange(null);
    setQuery('');
    setResults([]);
    setSearched(false);
  }, [onChange]);

  return (
    <div data-testid="job-picker" className="relative">
      <div className="flex gap-2">
        <Input
          aria-label="job-search"
          value={value ? displayLabel(value) : query}
          onChange={(e) => {
            if (value) onChange(null);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={required ? 'Search jobs (required)' : 'Search jobs'}
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
          data-testid="job-picker-results"
          className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-sm max-h-60 overflow-auto"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
          )}
          {!loading && searched && results.length === 0 && (
            <li
              data-testid="job-picker-empty"
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              No matching jobs
            </li>
          )}
          {results.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                data-testid={`job-option-${j.id}`}
                onClick={() => onSelect(j)}
                className="block w-full min-h-11 text-left px-3 py-2 text-sm hover:bg-secondary"
              >
                {displayLabel(j)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
