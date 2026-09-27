import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface SearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
  debounceMs?: number;
}

export function SearchBar({ onSearch, placeholder = 'Search conversations...', debounceMs = 300 }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSearch(query.trim());
  }, [query, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch(value.trim());
      }, debounceMs);
    },
    [onSearch, debounceMs]
  );

  return (
    <div className="search-bar flex items-center gap-2" data-testid="search-bar">
      <input
        className="search-input min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground"
        data-testid="search-input"
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      <button type="button" className="search-button min-h-11 min-w-11 shrink-0 rounded-lg border border-border bg-card px-3 text-sm text-foreground hover:bg-secondary" data-testid="search-button" onClick={handleSearch}>
        Search
      </button>
    </div>
  );
}
