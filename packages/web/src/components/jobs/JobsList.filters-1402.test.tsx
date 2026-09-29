/**
 * #1402 (QA §8) — jobs list filters: status (existed), scheduled-date range
 * and assigned technician (picked by NAME), all server-side, combinable, and
 * reflected in the URL so a filtered view can be shared / survives reload.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router';
import { JobsList } from './JobsList';
import { listQueryResult } from '../../test-utils/list-query-result';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useTechnicianRoster', () => ({
  useTechnicianRoster: () => ({
    technicians: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Maya Chen' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Diego Ruiz' },
    ],
    isLoading: false,
    error: null,
  }),
}));
vi.mock('./NewJobFlow', () => ({ NewJobFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';

const MAYA = '11111111-1111-4111-8111-111111111111';
let result = listQueryResult<never>([]);

beforeEach(() => {
  result = listQueryResult<never>([]);
  vi.mocked(useListQuery).mockReset();
  vi.mocked(useListQuery).mockReturnValue(result);
});

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.search}</output>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <JobsList />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '');

describe('JobsList filters (#1402 §8)', () => {
  it('a filtered URL loads the list with status + tenant-day date window + technician, server-side', () => {
    renderAt(`/jobs?status=scheduled&from=2026-10-05&to=2026-10-11&tech=${MAYA}`);
    // Tenant tz defaults to America/New_York (EDT, UTC-4): the window is
    // local midnight Oct 5 → local midnight after Oct 11 (the "to" day is inclusive).
    expect(vi.mocked(useListQuery).mock.calls[0][1]?.filters).toEqual({
      status: 'scheduled',
      scheduledFrom: '2026-10-05T04:00:00.000Z',
      scheduledTo: '2026-10-12T04:00:00.000Z',
      technicianId: MAYA,
    });
    expect((screen.getByLabelText('Technician') as HTMLSelectElement).value).toBe(MAYA);
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-05');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-11');
  });

  it('picking a technician by name filters server-side, keeps the status tab, and writes the URL', () => {
    renderAt('/jobs?status=in_progress');
    const picker = screen.getByLabelText('Technician') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['All technicians', 'Maya Chen', 'Diego Ruiz']);

    fireEvent.change(picker, { target: { value: MAYA } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ status: 'in_progress', technicianId: MAYA });
    expect(search().get('tech')).toBe(MAYA);
    expect(search().get('status')).toBe('in_progress');
  });

  it('setting a date range filters server-side and writes the URL; clearing removes it', () => {
    renderAt('/jobs');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ scheduledFrom: '2026-10-05T04:00:00.000Z' });
    expect(search().get('from')).toBe('2026-10-05');

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({
      scheduledFrom: '2026-10-05T04:00:00.000Z',
      scheduledTo: '2026-10-06T04:00:00.000Z',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({});
    expect(search().toString()).toBe('');
  });

  it('filter controls are ≥44px and shrink to fit a 320px row', () => {
    renderAt('/jobs');
    for (const label of ['Technician', 'From', 'To']) {
      const el = screen.getByLabelText(label);
      expect(el.className, label).toMatch(/\bmin-h-11\b/);
      expect(el.className, label).toMatch(/\bmin-w-0\b/);
      expect(el.className, label).toMatch(/\bw-full\b/);
    }
  });
});
