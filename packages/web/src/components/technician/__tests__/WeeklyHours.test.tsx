/**
 * P12-002 — WeeklyHours tests.
 *
 * The component pulls `useApiClient()` internally; we mock it at the
 * module level so the test bypasses Clerk wiring entirely.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetcher = vi.fn();

vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => mockFetcher,
}));

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: true,
      userId: 'tech-1',
      getToken: async () => 'tok',
    }),
  };
});

import WeeklyHours from '../../../pages/technician/WeeklyHours';

describe('P12-002 WeeklyHours', () => {
  beforeEach(() => {
    mockFetcher.mockReset();
  });

  it('WeeklyHours — renders per-day totals from API rollup', async () => {
    mockFetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            userId: 'tech-1',
            weekStart: '2026-04-27',
            byDay: [
              { date: '2026-04-27', hours: 8.0 },
              { date: '2026-04-29', hours: 4.5 },
            ],
            totalHours: 12.5,
          },
        ]),
        { status: 200 }
      )
    );

    render(<WeeklyHours weekOf="2026-04-27" tz="UTC" />);

    await waitFor(() => {
      expect(screen.getByTestId('weekly-hours')).toBeInTheDocument();
    });
    expect(screen.getByTestId('hours-2026-04-27')).toHaveTextContent('8.00');
    expect(screen.getByTestId('hours-2026-04-29')).toHaveTextContent('4.50');
    expect(screen.getByTestId('hours-2026-04-28')).toHaveTextContent('0.00');
    expect(screen.getByTestId('weekly-total')).toHaveTextContent('12.50');
  });

  it('WeeklyHours — empty week renders zeros + 0.00 total', async () => {
    mockFetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { userId: 'tech-1', weekStart: '2026-04-27', byDay: [], totalHours: 0 },
        ]),
        { status: 200 }
      )
    );

    render(<WeeklyHours weekOf="2026-04-27" tz="UTC" />);
    await waitFor(() => {
      expect(screen.getByTestId('weekly-total')).toHaveTextContent('0.00');
    });
    expect(screen.getByTestId('hours-2026-04-27')).toHaveTextContent('0.00');
  });

  it('WeeklyHours — surfaces fetch errors', async () => {
    mockFetcher.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    render(<WeeklyHours weekOf="2026-04-27" tz="UTC" />);
    await waitFor(() => {
      expect(screen.getByTestId('weekly-hours-error')).toHaveTextContent('HTTP 500');
    });
  });

  it('WeeklyHours — userIdOverride takes precedence over signed-in user', async () => {
    mockFetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            userId: 'other-tech',
            weekStart: '2026-04-27',
            byDay: [{ date: '2026-04-28', hours: 1 }],
            totalHours: 1,
          },
        ]),
        { status: 200 }
      )
    );

    render(<WeeklyHours weekOf="2026-04-27" tz="UTC" userIdOverride="other-tech" />);
    await waitFor(() => {
      expect(screen.getByTestId('weekly-total')).toHaveTextContent('1.00');
    });
    // Verify the API call was scoped to the override user.
    const calledUrl = mockFetcher.mock.calls[0][0] as string;
    expect(calledUrl).toContain('userId=other-tech');
  });
});
