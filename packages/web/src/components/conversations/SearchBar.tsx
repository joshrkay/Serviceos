import React, { useState, useCallback } from 'react';

export interface SearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
}

export function SearchBar({ onSearch, placeholder = 'Search conversations...' }: SearchBarProps) {
  const [query, setQuery] = useState('');

  const handleSearch = useCallback(() => {
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
      // Trigger search on clear. TODO: Add debounce when connected to an API.
      if (!value.trim()) {
        onSearch('');
      }
    },
    [onSearch]
  );

  return (
    <div className="search-bar" data-testid="search-bar">
      <input
        className="search-input"
        data-testid="search-input"
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      <button className="search-button" data-testid="search-button" onClick={handleSearch}>
        Search
      </button>
    </div>
  );
}
