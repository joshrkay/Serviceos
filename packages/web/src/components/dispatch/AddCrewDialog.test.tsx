import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AddCrewDialog } from './AddCrewDialog';

function mockFetch(handler: (url: string, init?: any) => any) {
  global.fetch = vi.fn((url: string, init?: any) => Promise.resolve(handler(url, init))) as any;
}

describe('AddCrewDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the roster, excludes existing assignees, and proposes an add', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/users')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: 'tech-primary', name: 'John' },
              { id: 'tech-crew', name: 'Jane' },
              { id: 'tech-free', name: 'Mo' },
            ],
          }),
        };
      }
      return { ok: true, json: () => Promise.resolve({ id: 'prop-1' }) };
    });

    const onCreated = vi.fn();
    render(
      <AddCrewDialog
        appointmentId="appt-1"
        appointmentVersion="2026-05-17T10:00:00.000Z"
        excludeTechnicianIds={['tech-primary', 'tech-crew']}
        onCreated={onCreated}
      />,
    );

    const select = (await screen.findByLabelText('crewTechnicianId')) as HTMLSelectElement;
    // Excluded techs are not offered; the free one is.
    await waitFor(() => {
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toContain('tech-free');
      expect(values).not.toContain('tech-primary');
      expect(values).not.toContain('tech-crew');
    });

    fireEvent.change(select, { target: { value: 'tech-free' } });
    fireEvent.click(screen.getByText('Add to crew'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    const proposalCall = (global.fetch as any).mock.calls.find((c: any[]) => c[0] === '/api/proposals');
    const body = JSON.parse(proposalCall[1].body);
    expect(body.proposalType).toBe('add_crew_member');
    expect(body.payload.technicianId).toBe('tech-free');
  });

  it('shows an error when submitted without a selection', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/users')) return { ok: true, json: () => Promise.resolve({ data: [] }) };
      return { ok: true, json: () => Promise.resolve({ id: 'x' }) };
    });

    render(<AddCrewDialog appointmentId="appt-1" />);
    await screen.findByLabelText('crewTechnicianId');
    fireEvent.click(screen.getByText('Add to crew'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a technician');
  });

  it('surfaces an infeasibility message from a 422', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/users')) {
        return { ok: true, json: () => Promise.resolve({ data: [{ id: 'tech-free', name: 'Mo' }] }) };
      }
      return {
        ok: false,
        status: 422,
        json: () => Promise.resolve({ blocking: [{ check: 'overlap', message: 'Overlaps with another job' }] }),
      };
    });

    render(<AddCrewDialog appointmentId="appt-1" />);
    const select = (await screen.findByLabelText('crewTechnicianId')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'tech-free' } });
    fireEvent.click(screen.getByText('Add to crew'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Overlaps with another job');
  });
});
