// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Lead {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  source?: string;
  stage?: string;
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  data: [] as Lead[],
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
import Leads from '../../app/leads';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Leads screen', () => {
  it('shows the empty state when there are no leads', () => {
    const { getByText } = render(createElement(Leads));
    expect(getByText('No leads yet.')).toBeTruthy();
  });

  it('renders lead rows and opens detail on tap', () => {
    h.data = [
      {
        id: 'l1',
        companyName: 'Acme HVAC',
        stage: 'new',
        source: 'web',
        primaryPhone: '555-0100',
      },
    ];
    const { getByText } = render(createElement(Leads));
    expect(getByText('Acme HVAC')).toBeTruthy();
    expect(getByText('new · web · 555-0100')).toBeTruthy();
    const row = getByText('Acme HVAC').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(row);
    expect(h.push).toHaveBeenCalledWith('/leads/l1');
  });

  it('falls back to "Unnamed lead" when a record has no name', () => {
    h.data = [{ id: 'l2' }];
    const { getByText } = render(createElement(Leads));
    expect(getByText('Unnamed lead')).toBeTruthy();
  });
});
