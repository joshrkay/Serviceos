/**
 * P12-002 — ClockInOutButton tests.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClockInOutButton } from '../ClockInOutButton';

interface MockState {
  active: { id: string; jobId?: string; userId: string; clockedInAt: string } | null;
}

function mockFetcher(state: MockState) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/time-entries/active')) {
      return new Response(JSON.stringify({ active: state.active }), { status: 200 });
    }
    if (path === '/api/time-entries/clock-in') {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const entry = {
        id: 'new-entry',
        tenantId: 't1',
        userId: body.userId,
        jobId: body.jobId,
        entryType: body.entryType,
        clockedInAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.active = entry;
      return new Response(JSON.stringify(entry), { status: 201 });
    }
    if (path === '/api/time-entries/clock-out') {
      const closed = state.active
        ? {
            ...state.active,
            clockedOutAt: new Date().toISOString(),
            durationMinutes: 60,
          }
        : null;
      state.active = null;
      return new Response(JSON.stringify(closed), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

describe('P12-002 ClockInOutButton', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('ClockInOut — renders Clock In when no active entry', async () => {
    const state: MockState = { active: null };
    render(
      <ClockInOutButton fetcher={mockFetcher(state)} jobId="job-1" userId="user-1" />
    );
    await waitFor(() => {
      expect(screen.getByTestId('clock-in-button')).toHaveTextContent('Clock In');
    });
  });

  it('ClockInOut — renders Clock Out with elapsed time when active for THIS job', async () => {
    const startedAt = new Date(Date.now() - 75 * 60_000).toISOString();
    const state: MockState = {
      active: { id: 'a', jobId: 'job-1', userId: 'user-1', clockedInAt: startedAt },
    };
    render(
      <ClockInOutButton fetcher={mockFetcher(state)} jobId="job-1" userId="user-1" />
    );
    await waitFor(() => {
      const btn = screen.getByTestId('clock-out-button');
      expect(btn).toHaveTextContent(/Clock Out/);
      expect(btn).toHaveTextContent(/1h 1[45]m/);
    });
  });

  it('ClockInOut — disabled when active on a different job', async () => {
    const state: MockState = {
      active: {
        id: 'a',
        jobId: 'other-job',
        userId: 'user-1',
        clockedInAt: new Date().toISOString(),
      },
    };
    render(
      <ClockInOutButton fetcher={mockFetcher(state)} jobId="job-1" userId="user-1" />
    );
    await waitFor(() => {
      expect(screen.getByTestId('clock-busy-elsewhere')).toBeDisabled();
    });
  });

  it('ClockInOut — clicking Clock In calls onChange with the new entry', async () => {
    const state: MockState = { active: null };
    const onChange = vi.fn();
    render(
      <ClockInOutButton
        fetcher={mockFetcher(state)}
        jobId="job-1"
        userId="user-1"
        onChange={onChange}
      />
    );
    const btn = await screen.findByTestId('clock-in-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0].jobId).toBe('job-1');
    });
  });

  it('ClockInOut — clicking Clock Out fires onChange with the closed entry', async () => {
    const state: MockState = {
      active: {
        id: 'open',
        jobId: 'job-1',
        userId: 'user-1',
        clockedInAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
    const onChange = vi.fn();
    render(
      <ClockInOutButton
        fetcher={mockFetcher(state)}
        jobId="job-1"
        userId="user-1"
        onChange={onChange}
      />
    );
    const btn = await screen.findByTestId('clock-out-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ durationMinutes: 60 })
      );
    });
  });

  it('ClockInOut — surfaces fetch errors in the UI', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }));
    render(
      <ClockInOutButton fetcher={fetcher} jobId="job-1" userId="user-1" />
    );
    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    });
  });
});
