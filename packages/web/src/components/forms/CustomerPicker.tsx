import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Input, Button } from '../ui';

export interface CustomerOption {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export interface CustomerPickerProps {
  value: CustomerOption | null;
  onChange: (customer: CustomerOption | null) => void;
  /** Test/perf override; defaults to 300ms per story spec. */
  debounceMs?: number;
  required?: boolean;
}

function displayName(c: CustomerOption): string {
  const human = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  if (human && c.companyName) return `${human} (${c.companyName})`;
  return human || c.companyName || c.id;
}

export function CustomerPicker({
  value,
  onChange,
  debounceMs = 300,
  required,
}: CustomerPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (search: string) => {
    if (!search.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const url = `/api/customers?search=${encodeURIComponent(search)}&limit=10`;
      const res = await apiFetch(url);
      if (!res.ok) {
        setResults([]);
        return;
      }
      const json = await res.json();
      const data: CustomerOption[] = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json)
        ? json
        : [];
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
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
    (c: CustomerOption) => {
      onChange(c);
      setOpen(false);
      setQuery(displayName(c));
    },
    [onChange]
  );

  const onClear = useCallback(() => {
    onChange(null);
    setQuery('');
    setResults([]);
  }, [onChange]);

  return (
    <div data-testid="customer-picker" className="relative">
      <div className="flex gap-2">
        <Input
          aria-label="customer-search"
          value={value ? displayName(value) : query}
          onChange={(e) => {
            if (value) onChange(null);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={required ? 'Search customer (required)' : 'Search customer'}
          className="min-h-11"
        />
        {value && (
          <Button type="button" variant="outline" size="sm" onClick={onClear} className="min-h-11">
            Clear
          </Button>
        )}
      </div>
      {open && !value && (results.length > 0 || loading) && (
        <ul
          data-testid="customer-picker-results"
          className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-sm max-h-60 overflow-auto"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
          )}
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid={`customer-option-${c.id}`}
                onClick={() => onSelect(c)}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-secondary"
              >
                {displayName(c)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
