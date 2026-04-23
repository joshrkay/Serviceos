import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceBookPage } from './PriceBookPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

const mockRefetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [],
    total: 0,
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
  it('renders import button and hidden csv input', () => {
    render(<PriceBookPage />);

    expect(screen.getByRole('button', { name: /import csv/i })).toBeInTheDocument();
    const input = screen.getByTestId('csv-file-input');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', '.csv');
  });


  it('opens add-item form when clicking Add item', () => {
    render(<PriceBookPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));

    expect(screen.getByText('Add price book item')).toBeInTheDocument();
    expect(screen.getByLabelText('Item name')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price')).toBeInTheDocument();
  });

  it('handles missing list query result without crashing', () => {
    vi.mocked(useListQuery).mockReturnValueOnce(undefined as any);

    render(<PriceBookPage />);

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });

  it('posts each valid row sequentially and shows progress text', async () => {
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
          unit_price: 12.5,
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
          unit_price: 35,
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
});
