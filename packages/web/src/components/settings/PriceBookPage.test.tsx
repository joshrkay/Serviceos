import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceBookPage } from './PriceBookPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

const mockRefetch = vi.fn();

const mockItems = [
  {
    id: 'item-1',
    name: 'Air Filter',
    description: 'MERV 8 return filter',
    unitPriceCents: 1250,
    unit: 'ea',
    category: 'HVAC',
  },
  {
    id: 'item-2',
    name: 'Capacitor',
    description: 'Run capacitor',
    unitPriceCents: 3500,
    unit: 'ea',
    category: 'Electrical',
  },
  {
    id: 'item-3',
    name: 'Labor - Diagnostic',
    description: 'On-site diagnosis',
    unitPriceCents: 9500,
    unit: 'hr',
    category: 'Labor',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: mockItems,
    total: mockItems.length,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  });
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200 } as Response);
});

describe('PriceBookPage', () => {
  it('renders list item names and formatted prices from API results', () => {
    render(<PriceBookPage />);

    expect(screen.getByText('Air Filter')).toBeInTheDocument();
    expect(screen.getByText('Capacitor')).toBeInTheDocument();
    expect(screen.getByText('Labor - Diagnostic')).toBeInTheDocument();

    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('$35.00')).toBeInTheDocument();
    expect(screen.getByText('$95.00')).toBeInTheDocument();
  });

  it('renders import button and hidden csv input', () => {
    render(<PriceBookPage />);

    expect(screen.getByRole('button', { name: /import csv/i })).toBeInTheDocument();
    const input = screen.getByTestId('csv-file-input');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', '.csv');
    expect(useListQuery).toHaveBeenCalledWith('/api/catalog/items', { pageSize: 200 });
  });

  it('opens add-item form when clicking Add item', () => {
    render(<PriceBookPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));

    expect(screen.getByText('Add price book item')).toBeInTheDocument();
    expect(screen.getByLabelText('Item name')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price')).toBeInTheDocument();
  });

  it('filters rows locally for each category chip option', () => {
    render(<PriceBookPage />);

    const filterExpectations: Record<string, string[]> = {
      All: ['Air Filter', 'Capacitor', 'Labor - Diagnostic'],
      HVAC: ['Air Filter'],
      Electrical: ['Capacitor'],
      Labor: ['Labor - Diagnostic'],
    };

    Object.entries(filterExpectations).forEach(([chip, expectedNames]) => {
      fireEvent.click(screen.getByRole('button', { name: chip }));
      const table = screen.getByRole('table');

      expectedNames.forEach(name => {
        expect(within(table).getByText(name)).toBeInTheDocument();
      });

      const unexpectedNames = mockItems.map(item => item.name).filter(name => !expectedNames.includes(name));
      unexpectedNames.forEach(name => {
        expect(within(table).queryByText(name)).not.toBeInTheDocument();
      });
    });
  });

  it('submits edited item values and calls PUT with expected endpoint and payload', async () => {
    render(<PriceBookPage />);

    const row = screen.getByRole('row', { name: /air filter/i });
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Air Filter Premium' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'MERV 11 return filter' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '18.99' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'ea' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HVAC' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/catalog/items/item-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            name: 'Air Filter Premium',
            description: 'MERV 11 return filter',
            unitPriceCents: 1899,
            unit: 'ea',
            category: 'HVAC',
          }),
        })
      );
    });
  });

  it('archives an item and refetches list data', async () => {
    render(<PriceBookPage />);

    const row = screen.getByRole('row', { name: /capacitor/i });
    fireEvent.click(within(row).getByRole('button', { name: /archive/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/catalog/items/item-2',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    expect(mockRefetch).toHaveBeenCalled();
  });

  it('handles missing list query result without crashing', () => {
    vi.mocked(useListQuery).mockReturnValueOnce(undefined as any);

    render(<PriceBookPage />);

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });

  it('posts each valid row sequentially with unitPriceCents payload and shows progress text', async () => {
    render(<PriceBookPage />);

    const csv = [
      'name,description,unit_price,unit,category',
      'Filter,"1-inch, pleated",12.5,ea,HVAC',
      'Capacitor,Run capacitor,35,ea,Electrical',
    ].join('\n');

    const file = new File([csv], 'pricebook.csv', { type: 'text/csv' });
    const input = screen.getByTestId('csv-file-input') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/catalog/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Filter',
          description: '1-inch, pleated',
          unitPriceCents: 1250,
          unit: 'ea',
          category: 'HVAC',
        }),
      })
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/catalog/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Capacitor',
          description: 'Run capacitor',
          unitPriceCents: 3500,
          unit: 'ea',
          category: 'Electrical',
        }),
      })
    );

    await waitFor(() => expect(screen.getByTestId('csv-import-progress')).toHaveTextContent('Imported 2 of 2'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows invalid row errors and skips invalid records', async () => {
    render(<PriceBookPage />);

    const csv = [
      'name,description,unit_price,unit,category',
      ',No name,19,ea,HVAC',
      'Bad Price,Oops,-1,ea,HVAC',
      'Valid Item,Good,10,ea,HVAC',
    ].join('\n');

    const file = new File([csv], 'invalid.csv', { type: 'text/csv' });
    const input = screen.getByTestId('csv-file-input') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('csv-import-errors')).toHaveTextContent('Row 2: name is required.');
    expect(screen.getByTestId('csv-import-errors')).toHaveTextContent('Row 3: unit_price must be a non-negative number.');
    expect(screen.getByTestId('csv-import-progress')).toHaveTextContent('Imported 1 of 1');
  });

  it('shows a file-level validation error when row count exceeds max allowed', async () => {
    render(<PriceBookPage />);

    const rows = Array.from({ length: 501 }, (_, i) => `Item ${i + 1},Desc,1,ea,HVAC`);
    const csv = ['name,description,unit_price,unit,category', ...rows].join('\n');

    const file = new File([csv], 'too-many.csv', { type: 'text/csv' });
    const input = screen.getByTestId('csv-file-input') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('csv-import-errors')).toHaveTextContent(
        'CSV has 501 rows. Maximum allowed is 500 rows per import.'
      );
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows a file-level validation error when required headers are missing', async () => {
    render(<PriceBookPage />);

    const csv = ['description,unit,category', 'No price,ea,HVAC'].join('\n');

    const file = new File([csv], 'missing-headers.csv', { type: 'text/csv' });
    const input = screen.getByTestId('csv-file-input') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('csv-import-errors')).toHaveTextContent(
        'CSV is missing required columns: name, unit_price.'
      );
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('filters categories even when API data uses lowercase category values', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [
        { id: '1', name: 'Technician hour', unitPriceCents: 15000, unit: 'hour', category: 'labor' },
        { id: '2', name: 'Air filter', unitPriceCents: 2000, unit: 'each', category: 'Parts' },
      ],
      total: 2,
      page: 1,
      pageSize: 200,
      isLoading: false,
      error: null,
      refetch: mockRefetch,
      setPage: vi.fn(),
      setSearch: vi.fn(),
      setFilters: vi.fn(),
    });

    render(<PriceBookPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Labor' }));
    expect(screen.getByText('Technician hour')).toBeInTheDocument();
    expect(screen.queryByText('Air filter')).not.toBeInTheDocument();
  });

  it('submits create payload with unitPriceCents', async () => {
    render(<PriceBookPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Capacitor' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Run capacitor' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '12.34' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'each' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Parts' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/catalog/items',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'Capacitor',
            description: 'Run capacitor',
            unitPriceCents: 1234,
            unit: 'each',
            category: 'Parts',
          }),
        })
      )
    );
  });
});
