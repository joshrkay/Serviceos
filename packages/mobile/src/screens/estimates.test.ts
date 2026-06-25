// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Estimate {
  id: string;
  estimateNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  data: [] as Estimate[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import Estimates from '../../app/estimates';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Estimates screen', () => {
  it('renders search and a >=44px new-estimate control', () => {
    const { getByPlaceholderText, getByText } = render(createElement(Estimates));
    expect(getByPlaceholderText('Search estimates…')).toBeTruthy();
    const add = getByText('+ New').closest('button')!;
    expect(add.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(add);
    expect(h.push).toHaveBeenCalledWith('/estimates/new');
  });

  it('shows the empty state when there are no estimates', () => {
    const { getByText } = render(createElement(Estimates));
    expect(getByText('No estimates yet.')).toBeTruthy();
  });

  it('renders estimate rows with formatted totals', () => {
    h.data = [
      { id: 'e1', estimateNumber: 'EST-100', totals: { totalCents: 50000 }, status: 'sent' },
    ];
    const { getByText } = render(createElement(Estimates));
    expect(getByText('EST-100 · $500.00')).toBeTruthy();
    expect(getByText('sent')).toBeTruthy();
  });

  it('filters estimates by search query', () => {
    h.data = [
      { id: 'e1', estimateNumber: 'EST-100', status: 'sent' },
      { id: 'e2', estimateNumber: 'EST-200', status: 'draft' },
    ];
    const { getByPlaceholderText, getByText, queryByText } = render(createElement(Estimates));
    fireEvent.change(getByPlaceholderText('Search estimates…'), { target: { value: '200' } });
    expect(queryByText('EST-100')).toBeNull();
    expect(getByText(/EST-200/)).toBeTruthy();
  });

  it('routes draft estimates to the new wizard', () => {
    h.data = [{ id: 'e1', estimateNumber: 'EST-D', status: 'draft' }];
    const { getByText } = render(createElement(Estimates));
    expect(getByText('draft · tap to edit')).toBeTruthy();
    fireEvent.click(getByText(/EST-D/).closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/estimates/new');
  });
});
