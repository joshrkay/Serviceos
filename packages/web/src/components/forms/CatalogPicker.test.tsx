import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPicker } from './CatalogPicker';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));

import { useListQuery } from '../../hooks/useListQuery';

const mockItems = [
  { id: 'item-1', name: 'AC tune-up', unitPriceCents: 12900, category: 'Labor' },
  { id: 'item-2', name: 'Run capacitor', unitPriceCents: 2850, category: 'Parts' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: mockItems,
    total: mockItems.length,
    page: 1,
    pageSize: 20,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  });
});

describe('CatalogPicker', () => {
  it('opens the popover and lists catalog items with formatted prices', () => {
    render(<CatalogPicker onPick={vi.fn()} />);

    expect(screen.queryByTestId('catalog-picker-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('catalog-picker-trigger'));

    expect(screen.getByTestId('catalog-picker-popover')).toBeInTheDocument();
    expect(screen.getByText('AC tune-up')).toBeInTheDocument();
    expect(screen.getByText('$129.00')).toBeInTheDocument();
    expect(screen.getByText('Run capacitor')).toBeInTheDocument();
    expect(screen.getByText('$28.50')).toBeInTheDocument();
  });

  it('calls onPick with the chosen item and closes the popover', () => {
    const onPick = vi.fn();
    render(<CatalogPicker onPick={onPick} />);

    fireEvent.click(screen.getByTestId('catalog-picker-trigger'));
    fireEvent.click(screen.getByText('AC tune-up'));

    expect(onPick).toHaveBeenCalledWith(mockItems[0]);
    expect(screen.queryByTestId('catalog-picker-popover')).not.toBeInTheDocument();
  });
});
