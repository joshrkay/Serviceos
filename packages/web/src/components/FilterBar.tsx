import React from 'react';

export interface FilterOption {
  label: string;
  value: string;
}

export interface FilterConfig {
  key: string;
  label: string;
  options: FilterOption[];
}

export interface FilterBarProps {
  filters: FilterConfig[];
  activeFilters: Record<string, string>;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
}

export function FilterBar({ filters, activeFilters, onFilterChange, onClearFilters }: FilterBarProps) {
  const hasActiveFilters = Object.keys(activeFilters).length > 0;

  return (
    <div className="filter-bar">
      {filters.map((filter) => (
        <select
          key={filter.key}
          value={activeFilters[filter.key] || ''}
          onChange={(e) => onFilterChange(filter.key, e.target.value)}
        >
          <option value="">{filter.label}</option>
          {filter.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ))}
      {hasActiveFilters && (
        <button onClick={onClearFilters}>Clear filters</button>
      )}
    </div>
  );
}
