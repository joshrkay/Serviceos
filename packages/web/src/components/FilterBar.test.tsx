import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FilterBar } from './FilterBar';

describe('FilterBar', () => {
  const filters = [
    { key: 'status', label: 'Status', options: [{ label: 'Open', value: 'open' }, { label: 'Closed', value: 'closed' }] },
    { key: 'priority', label: 'Priority', options: [{ label: 'High', value: 'high' }] },
  ];

  it('renders filter dropdowns', () => {
    render(<FilterBar filters={filters} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('calls onFilterChange when a filter is selected', () => {
    const onChange = vi.fn();
    render(<FilterBar filters={filters} activeFilters={{}} onFilterChange={onChange} onClearFilters={() => {}} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'open' } });
    expect(onChange).toHaveBeenCalledWith('status', 'open');
  });

  it('shows clear button when filters are active', () => {
    const onClear = vi.fn();
    render(<FilterBar filters={filters} activeFilters={{ status: 'open' }} onFilterChange={() => {}} onClearFilters={onClear} />);
    fireEvent.click(screen.getByText('Clear filters'));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('hides clear button when no filters active', () => {
    render(<FilterBar filters={filters} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}} />);
    expect(screen.queryByText('Clear filters')).toBeNull();
  });
});
