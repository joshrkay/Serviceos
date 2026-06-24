// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface JobRow {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  data: [] as JobRow[],
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
import Jobs from '../../app/(tabs)/jobs';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Jobs tab screen', () => {
  it('renders a >=44px new-job control', () => {
    const { getByText } = render(createElement(Jobs));
    const add = getByText('+ New').closest('button')!;
    expect(add.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(add);
    expect(h.push).toHaveBeenCalledWith('/jobs/new');
  });

  it('shows the empty state when there are no jobs', () => {
    const { getByText } = render(createElement(Jobs));
    expect(getByText('No jobs yet.')).toBeTruthy();
  });

  it('opens a job detail when a row is tapped', () => {
    h.data = [{ id: 'j1', jobNumber: 'JOB-42', summary: 'Fix AC', status: 'scheduled' }];
    const { getByText } = render(createElement(Jobs));
    fireEvent.click(getByText(/JOB-42/).closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/jobs/j1');
  });
});
