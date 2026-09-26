/**
 * #1290 — the dispatch board surfaces travel-time and skill checks on a
 * technician lane.
 *
 * Travel time and skill matching already exist server-side
 * (api scheduling/feasibility.ts → POST /api/dispatch/check-feasibility) and
 * on the board (useFeasibilityPreview → TechnicianLane drop-zone state →
 * ConfirmProposalDialog conflicts). They were invisible on dev only because
 * the board had no technician lanes (#1279: assignments written by the
 * forms never reached appointment_assignments). With lanes present, this pins
 * that a drag onto a technician's lane shows both warnings before any
 * proposal can be created. Map and route ordering are deferred (#1290).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchBoard } from './DispatchBoard';
import type { FeasibilityResult } from '../../components/dispatch/feasibility-types';

vi.mock('../../hooks/useDispatchBoard', () => ({ useDispatchBoard: vi.fn() }));
vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: () => 'UTC' }));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'test-user', getToken: vi.fn().mockResolvedValue(null) }),
  useUser: () => ({ user: { id: 'test-user' } }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../hooks/useDispatchBoardStream', () => ({ useDispatchBoardStream: vi.fn() }));
vi.mock('../../hooks/useDispatchPresence', () => ({
  useDispatchPresence: vi.fn(() => ({ peers: [], transport: 'http' })),
}));

const TRAVEL_MSG = 'Travel from previous appointment requires ~1800s but only 600s available.';
const SKILL_MSG = 'Technician is missing required skill: gas_certified.';

const PREVIEW: FeasibilityResult = {
  feasible: true,
  blocking: [],
  warnings: [
    { check: 'travel_time', severity: 'warning', message: TRAVEL_MSG },
    { check: 'skill_match', severity: 'warning', message: SKILL_MSG },
  ],
  info: [],
  travelTime: { fromPrevSeconds: 1800, toNextSeconds: null, estimateSource: 'haversine', degraded: false },
  skillConstraints: 'evaluated',
};

const previewInputs: unknown[] = [];
vi.mock('../../components/dispatch/useFeasibilityPreview', () => ({
  useFeasibilityPreview: (input: unknown) => {
    previewInputs.push(input);
    return { preview: input ? PREVIEW : null, isLoading: false };
  },
}));

import { useDispatchBoard } from '../../hooks/useDispatchBoard';

// The lane shape getDispatchBoardData returns once an appointment carries a
// primary appointment_assignments row (see the #1279 integration test).
const boardData = {
  date: '2026-10-14',
  unassignedAppointments: [],
  technicianLanes: [
    {
      technicianId: 'tech-1',
      technicianName: 'Lane Tech',
      appointments: [
        {
          id: 'appt-1',
          jobId: 'job-1',
          customerName: 'Lane Owner',
          jobSummary: 'Furnace tune-up',
          technicianId: 'tech-1',
          technicianName: 'Lane Tech',
          scheduledStart: '2026-10-14T10:30:00Z',
          scheduledEnd: '2026-10-14T11:30:00Z',
          status: 'scheduled',
        },
      ],
    },
    { technicianId: 'tech-2', technicianName: 'Second Tech', appointments: [] },
  ],
  summary: { unassigned: 0, scheduled: 1, inProgress: 0, completed: 0, canceled: 0 },
};

function drag(card: HTMLElement, lane: HTMLElement, appointmentId: string) {
  const data: Record<string, string> = {};
  const dt = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: (k: string, v: string) => {
      data[k] = v;
    },
    getData: (k: string) => data[k] ?? '',
  };
  const target = (lane.querySelector('[data-drop-index="0"]') as HTMLElement) ?? lane;
  fireEvent.dragStart(card, { dataTransfer: dt });
  dt.setData('text/plain', appointmentId);
  fireEvent.dragOver(target, { dataTransfer: dt });
  return { target, dt };
}

describe('#1290 — board surfaces travel-time and skill checks on technician lanes', () => {
  beforeEach(() => {
    previewInputs.length = 0;
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: boardData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);
  });

  it('renders the assigned technician lane with its appointment', () => {
    render(<DispatchBoard />);
    const lane = screen
      .getAllByTestId('technician-lane')
      .find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    expect(lane).toBeTruthy();
    expect(lane.querySelector('[data-appointment-id="appt-1"]')).not.toBeNull();
    expect(screen.queryByTestId('dispatch-board-empty')).toBeNull();
  });

  it('checks feasibility for the target lane and shows travel-time + skill warnings before confirm', () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const source = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const target = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = source.querySelector('[data-appointment-id="appt-1"]') as HTMLElement;

    const { target: dropEl, dt } = drag(card, target, 'appt-1');

    // The preview is requested for the TARGET technician on that lane.
    expect(previewInputs).toContainEqual(
      expect.objectContaining({ appointmentId: 'appt-1', proposedTechnicianId: 'tech-2' }),
    );
    // Lane drop zone reflects the warning state while hovering.
    expect(target.innerHTML + target.className).toMatch(/drop-zone--warning/);

    fireEvent.drop(dropEl, { dataTransfer: dt });

    const dialog = screen.getByTestId('confirm-proposal-dialog');
    expect(dialog).toHaveTextContent(TRAVEL_MSG);
    expect(dialog).toHaveTextContent(SKILL_MSG);
    // Warnings must be acknowledged before a proposal can be created.
    expect(screen.getByTestId('confirm-proposal-confirm')).toBeDisabled();
  });
});
