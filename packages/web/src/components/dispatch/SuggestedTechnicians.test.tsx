import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SuggestedTechnicians, TechnicianSuggestion, SuggestionOverlap, travelLabel, overlapLabel, SHOWN_SUGGESTIONS,
} from './SuggestedTechnicians';

vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: () => 'America/New_York' }));

const clash: SuggestionOverlap = {
  appointmentId: 'a-other', jobSummary: 'Boiler service',
  scheduledStart: '2026-10-22T17:30:00.000Z', scheduledEnd: '2026-10-22T19:00:00.000Z', overlapMinutes: 30,
};

const sug = (over: Partial<TechnicianSuggestion>): TechnicianSuggestion => ({
  technicianId: 't', name: 'T', feasible: true, reasons: [], warningCount: 0,
  travelFromPrevSeconds: null, travelEstimateSource: null, travelUnverified: false, isCurrent: false, overlaps: [],
  ...over,
});

function respondWith(suggestions: TechnicianSuggestion[], ok = true, extra: Record<string, unknown> = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve({ suggestions, ...extra }),
  }) as unknown as typeof fetch;
}

describe('travelLabel', () => {
  it('rounds the drive to minutes, at least one, and names an unknown drive', () => {
    expect(travelLabel({ travelFromPrevSeconds: 610, travelUnverified: false })).toBe('10 min from previous visit');
    expect(travelLabel({ travelFromPrevSeconds: 5, travelUnverified: false })).toBe('1 min from previous visit');
    expect(travelLabel({ travelFromPrevSeconds: null, travelUnverified: false })).toBe('No earlier visit to drive from');
    // An earlier visit exists but an address has no coordinates: say so, never "no earlier visit".
    expect(travelLabel({ travelFromPrevSeconds: null, travelUnverified: true })).toBe(
      'Drive time unknown (an address is not on the map)',
    );
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

  it('alerts on a booked tech with the clashing visit and its times in tenant time, without offering a pick', async () => {
    respondWith([
      sug({ technicianId: 'a', name: 'Ann' }),
      sug({ technicianId: 'e', name: 'Eve', feasible: false, reasons: ['Overlaps with appointment a-other'], overlaps: [clash] }),
      sug({ technicianId: 'c', name: 'Cal', feasible: false, reasons: ['Technician is missing required skill(s): hvac'] }),
    ]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    const alerts = await screen.findAllByTestId('suggest-techs-overlap');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Eve is booked');
    expect(alerts[0]).toHaveTextContent('Overlaps by 30 min: Boiler service, 1:30 PM–3:00 PM');
    expect(alerts[0].querySelector('button')).toBeNull();
    expect(screen.getAllByTestId('suggest-techs-pick')).toHaveLength(1);
    expect(screen.queryByText(/Cal/)).toBeNull();
  });

  it('shows the overlap alerts, not a raw reason, when every free-looking tech is booked', async () => {
    respondWith([sug({ technicianId: 'e', name: 'Eve', feasible: false, reasons: ['Overlaps with appointment a-other'], overlaps: [clash] })]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    const none = await screen.findByTestId('suggest-techs-none');
    expect(none).not.toHaveTextContent('a-other');
    expect(screen.getByTestId('suggest-techs-overlap')).toHaveTextContent('Overlaps by 30 min');
  });

  it('says the answer is partial when the API only checked part of the team', async () => {
    respondWith([sug({ technicianId: 'x', name: 'Xi', feasible: false, reasons: ['Outside working hours'] })], true, {
      totalTechnicians: 30, truncated: true,
    });
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    expect(await screen.findByTestId('suggest-techs-none')).toHaveTextContent('None of the technicians checked is free');
    expect(screen.getByTestId('suggest-techs-partial')).toHaveTextContent('Checked 1 of 30 technicians.');
  });

  it('adds no partial note when every technician was checked', async () => {
    respondWith([sug({ technicianId: 'a', name: 'Ann' })], true, { totalTechnicians: 1, truncated: false });
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    await screen.findByTestId('suggest-techs-list');
    expect(screen.queryByTestId('suggest-techs-partial')).toBeNull();
  });

  it('still alerts on a booked tech who also has a non-blocking travel warning', async () => {
    respondWith([
      sug({
        technicianId: 'e', name: 'Eve', feasible: false, warningCount: 1, overlaps: [clash],
        reasons: ['Overlaps with appointment a-other', 'Tight drive to next visit'],
      }),
    ]);
    render(<SuggestedTechnicians appointmentId="appt-1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('suggest-techs-button'));
    expect(await screen.findByTestId('suggest-techs-overlap')).toHaveTextContent('Overlaps by 30 min: Boiler service');
    expect(screen.getByTestId('suggest-techs-none')).not.toHaveTextContent('a-other');
  });

  it('overlapLabel falls back when the clashing job is gone', () => {
    expect(overlapLabel({ ...clash, jobSummary: null }, 'America/New_York')).toBe(
      'Overlaps by 30 min: another visit, 1:30 PM–3:00 PM',
    );
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
