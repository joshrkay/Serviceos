import React from 'react';

export interface DispatchFilterValues {
  technicianIds?: string[];
  status?: string;
}

export interface TechnicianOption {
  id: string;
  name: string;
}

export interface DispatchFiltersProps {
  technicians: TechnicianOption[];
  activeFilters: DispatchFilterValues;
  onFilterChange: (filters: DispatchFilterValues) => void;
}

export function DispatchFilters({
  technicians,
  activeFilters,
  onFilterChange,
}: DispatchFiltersProps) {
  const handleTechnicianChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = Array.from(e.target.selectedOptions, (opt) => opt.value);
    onFilterChange({
      ...activeFilters,
      technicianIds: selected.length > 0 ? selected : undefined,
    });
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    onFilterChange({
      ...activeFilters,
      status: value || undefined,
    });
  };

  const handleClearFilters = () => {
    onFilterChange({});
  };

  const hasActiveFilters =
    (activeFilters.technicianIds && activeFilters.technicianIds.length > 0) ||
    !!activeFilters.status;

  return (
    <div className="dispatch-filters" data-testid="dispatch-filters">
      <select
        className="dispatch-filters__technician-select"
        data-testid="dispatch-filter-technician"
        multiple
        value={activeFilters.technicianIds ?? []}
        onChange={handleTechnicianChange}
        aria-label="Filter by technician"
      >
        {technicians.map((tech) => (
          <option key={tech.id} value={tech.id}>
            {tech.name}
          </option>
        ))}
      </select>

      <select
        className="dispatch-filters__status-select"
        data-testid="dispatch-filter-status"
        value={activeFilters.status ?? ''}
        onChange={handleStatusChange}
        aria-label="Filter by status"
      >
        <option value="">All Statuses</option>
        <option value="scheduled">Scheduled</option>
        <option value="confirmed">Confirmed</option>
        <option value="in_progress">In Progress</option>
        <option value="completed">Completed</option>
        <option value="canceled">Canceled</option>
      </select>

      {hasActiveFilters && (
        <button
          className="dispatch-filters__clear"
          data-testid="dispatch-filter-clear"
          onClick={handleClearFilters}
        >
          Clear Filters
        </button>
      )}
    </div>
  );
}
