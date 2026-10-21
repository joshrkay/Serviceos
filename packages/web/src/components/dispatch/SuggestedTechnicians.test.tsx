import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SuggestedTechnicians, TechnicianSuggestion, travelLabel, SHOWN_SUGGESTIONS } from './SuggestedTechnicians';

const sug = (over: Partial<TechnicianSuggestion>): TechnicianSuggestion => ({
  technicianId: 't', name: 'T', feasible: true, reasons: [], warningCount: 0,
  travelFromPrevSeconds: null, travelEstimateSource: null, isCurrent: false,
  ...over,
});

function respondWith(suggestions: TechnicianSuggestion[], ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve({ suggestions }),
  }) as unknown as typeof fetch;
}

describe('travelLabel', () => {
  it('rounds the drive to minutes, at least one, and names an unknown drive', () => {
    expect(travelLabel({ travelFromPrevSeconds: 610 })).toBe('10 min from previous visit');
    expect(travelLabel({ travelFromPrevSeconds: 5 })).toBe('1 min from previous visit');
    expect(travelLabel({ travelFromPrevSeconds: null })).toBe('No earlier visit to drive from');
  });
});

describe('SuggestedTechnicians', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads only on tap, from the suggestion endpoint', async () => {
    respondWith([sug({ technicianId: 'a', name: 'Ann' })]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    await screen.findByTestId('suggest-techs-list');
    expect((global.fetch as any).mock.calls[0][0]).toBe(
      '/api/dispatch/appointments/appt-1/suggested-technicians',
    );
  });

  it('shows feasible techs in server order, skipping blocked and current ones, capped', async () => {
    respondWith([
      sug({ technicianId: 'cur', name: 'Cur', isCurrent: true }),
      sug({ technicianId: 'a', name: 'Ann', travelFromPrevSeconds: 300 }),
      sug({ technicianId: 'b', name: 'Bo', warningCount: 2 }),
      sug({ technicianId: 'c', name: 'Cy' }),
      sug({ technicianId: 'd', name: 'Di' }),
      sug({ technicianId: 'x', name: 'Xi', feasible: false, reasons: ['Overlaps'] }),
    ]);
    const onPick = vi.fn();
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={onPick} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    const picks = await screen.findAllByTestId('suggest-techs-pick');
    expect(picks).toHaveLength(SHOWN_SUGGESTIONS);
    expect(picks[0]).toHaveTextContent('Suggested: Ann');
    expect(picks[0]).toHaveTextContent('5 min from previous visit');
    expect(picks[1]).toHaveTextContent('Bo');
    expect(picks[1]).toHaveTextContent('2 warnings');
    fireEvent.click(picks[0]);
    expect(onPick).toHaveBeenCalledWith('appt-1', 'a', 'Ann');
  });

  it('says why when nobody can take the visit', async () => {
    respondWith([sug({ technicianId: 'x', name: 'Xi', feasible: false, reasons: ['Outside working hours'] })]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    expect(await screen.findByTestId('suggest-techs-none')).toHaveTextContent('Xi: Outside working hours');
  });

  it('offers a retry when the request fails', async () => {
    respondWith([], false);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    expect(screen.getByTestId('suggest-techs-button')).toHaveTextContent('Retry suggestions');
  });

  it('keeps every tap target at least 44px tall and full width (no overflow at 320px)', async () => {
    respondWith([sug({ technicianId: 'a', name: 'Ann' })]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    const button = screen.getByTestId('suggest-techs-button');
    expect(button.className).toMatch(/\bmin-h-11\b/);
    expect(button.className).toMatch(/\bw-full\b/);
    fireEvent.click(button);
    const pick = await screen.findByTestId('suggest-techs-pick');
    expect(pick.className).toMatch(/\bmin-h-11\b/);
    expect(pick.className).toMatch(/\bw-full\b/);
  });
});
