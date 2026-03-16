import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DispatchFilters } from './DispatchFilters';

describe('P6-021 — Dispatch board filters', () => {
  const technicians = [
    { id: 'tech-1', name: 'John Smith' },
    { id: 'tech-2', name: 'Jane Doe' },
  ];

  it('renders the dispatch filters', () => {
    render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{}}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('dispatch-filters')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-filter-technician')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-filter-status')).toBeInTheDocument();
  });

  it('shows technician options', () => {
    render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{}}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows status options', () => {
    render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{}}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getByText('All Statuses')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('calls onFilterChange when status changes', () => {
    const onFilterChange = vi.fn();
    render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{}}
        onFilterChange={onFilterChange}
      />
    );
    fireEvent.change(screen.getByTestId('dispatch-filter-status'), {
      target: { value: 'scheduled' },
    });
    expect(onFilterChange).toHaveBeenCalledWith({ status: 'scheduled' });
  });

  it('shows clear button only when filters are active', () => {
    const { rerender } = render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{}}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId('dispatch-filter-clear')).not.toBeInTheDocument();

    rerender(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{ status: 'scheduled' }}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('dispatch-filter-clear')).toBeInTheDocument();
  });

  it('clears all filters when clear button is clicked', () => {
    const onFilterChange = vi.fn();
    render(
      <DispatchFilters
        technicians={technicians}
        activeFilters={{ status: 'scheduled' }}
        onFilterChange={onFilterChange}
      />
    );
    fireEvent.click(screen.getByTestId('dispatch-filter-clear'));
    expect(onFilterChange).toHaveBeenCalledWith({});
  });
});
