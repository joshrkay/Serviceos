import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { HomePage } from './HomePage';

// Mock the data hooks so we can drive Home's sections deterministically.
vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));
vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({ me: { role: 'owner' } }),
}));

import { useListQuery } from '../../hooks/useListQuery';

const mockUseListQuery = vi.mocked(useListQuery);

type ListReturn = ReturnType<typeof useListQuery>;

function listReturn(data: unknown[], overrides: Partial<ListReturn> = {}): ListReturn {
  return {
    data: { data, total: data.length },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as ListReturn;
}

/** Route each list hook by path so we can populate sections independently. */
function mockByPath(map: Record<string, unknown[]>) {
  mockUseListQuery.mockImplementation((path: string) =>
    listReturn(map[path] ?? []),
  );
}

const aJob = {
  id: 'j1',
  status: 'scheduled',
  customer: { name: 'Alice Smith' },
  service_type: 'Repair',
};

describe('HomePage', () => {
  beforeEach(() => {
    mockUseListQuery.mockReset();
  });

  it('renders the greeting and the today section when there is a job', () => {
    mockByPath({ '/api/jobs': [aJob] });
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/Good (morning|afternoon|evening)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Today's jobs")).toBeInTheDocument();
  });

  it('shows the per-section empty state when no jobs are scheduled', () => {
    // Estimates present so the calm all-clear state does not take over;
    // the Today's jobs section then shows its own empty message.
    mockByPath({
      '/api/estimates': [
        { id: 'e1', status: 'sent', total_cents: 1000, customer: { name: 'Bob' } },
      ],
    });
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(screen.getByText('No jobs scheduled today')).toBeInTheDocument();
  });

  it('renders job cards when jobs exist', () => {
    mockByPath({ '/api/jobs': [aJob] });
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('shows the calm all-clear state when nothing needs attention', () => {
    mockUseListQuery.mockReturnValue(listReturn([]));
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    // The section headings give way to the single calm message.
    expect(screen.queryByText("Today's jobs")).toBeNull();
  });
});

// (Money summary + outstanding-invoice assertions live in
//  MoneyLoopHomeCard.test.tsx — Home composes that card.)
