import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PriceBookPage } from './PriceBookPage';

describe('PriceBookPage', () => {
  const mockItems = [
    { id: '1', name: 'Compressor Tune-up', price: 85 },
    { id: '2', name: 'Capacitor Replacement', price: 18 },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url === '/api/price-book' && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ items: mockItems }),
        } as Response;
      }

      if (url === '/api/price-book' && method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: crypto.randomUUID() }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <PriceBookPage />
      </MemoryRouter>
    );
  }

  it('renders list items from API', async () => {
    renderPage();

    expect(await screen.findByText('Compressor Tune-up')).toBeInTheDocument();
    expect(await screen.findByText('Capacitor Replacement')).toBeInTheDocument();
  });

  it('shows formatted prices', async () => {
    renderPage();

    expect(await screen.findByText('$85.00')).toBeInTheDocument();
    expect(await screen.findByText('$18.00')).toBeInTheDocument();
  });

  it('opens add-item form when clicking Add item', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add item/i }));

    expect(await screen.findByPlaceholderText(/item-name/i)).toBeInTheDocument();
  });

  it('imports CSV and sends one POST per valid row', async () => {
    renderPage();

    expect(await screen.findByText(/import csv/i)).toBeInTheDocument();

    const csvInput = screen.getByTestId('csv-file-input') as HTMLInputElement;
    const csv = [
      'name,price',
      'Compressor Tune-up,85',
      'Bad Row,',
      'Capacitor Replacement,18',
      ',42',
    ].join('\n');

    const file = new File([csv], 'price-book.csv', { type: 'text/csv' });
    fireEvent.change(csvInput, { target: { files: [file] } });

    await waitFor(() => {
      const postCalls = vi.mocked(fetch).mock.calls.filter(([input, init]) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        return url === '/api/price-book' && method === 'POST';
      });

      expect(postCalls).toHaveLength(2);
    });
  });
});
