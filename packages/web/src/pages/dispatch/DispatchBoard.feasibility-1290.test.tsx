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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
let previewOverride: FeasibilityResult | null = null;
vi.mock('../../components/dispatch/useFeasibilityPreview', () => ({
  useFeasibilityPreview: (input: unknown) => {
    previewInputs.push(input);
    return { preview: input ? (previewOverride ?? PREVIEW) : null, isLoading: false };
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
    previewOverride = null;
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

  it('#1477 — a cross-lane hover checks feasibility at the appointment\'s own window (reassign moves no time)', () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const source = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const target = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = source.querySelector('[data-appointment-id="appt-1"]') as HTMLElement;

    drag(card, target, 'appt-1');

    const forTarget = previewInputs.filter(
      (i) => (i as { proposedTechnicianId?: string } | null)?.proposedTechnicianId === 'tech-2',
    );
    expect(forTarget.length).toBeGreaterThan(0);
    for (const input of forTarget) {
      expect(input).toMatchObject({
        proposedScheduledStart: '2026-10-14T10:30:00Z',
        proposedScheduledEnd: '2026-10-14T11:30:00Z',
      });
    }
  });

  // Dispatch FR-2 phase 3c — "Allow overlap if select by user".
  it('a reassign blocked only by an overlap can be booked anyway, and the POST says the dispatcher accepted it', async () => {
    previewOverride = {
      ...PREVIEW, feasible: false, warnings: [],
      blocking: [{ check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment a-other', conflictingEntityId: 'a-other' }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: 'proposal-xyz' }), text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const source = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const target = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = source.querySelector('[data-appointment-id="appt-1"]') as HTMLElement;
    const { target: dropEl, dt } = drag(card, target, 'appt-1');
    fireEvent.drop(dropEl, { dataTransfer: dt });

    const confirm = screen.getByTestId('confirm-proposal-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('confirm-accept-overlap-checkbox'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(body.payload).toMatchObject({ appointmentId: 'appt-1', toTechnicianId: 'tech-2', acceptOverlap: true });
    expect(body.payload.reason).toMatch(/accepted an overlap/);
    expect(body.summary).toMatch(/dispatcher accepted the overlap/);
  });

  it('without the tick, an overlap-blocked reassign is never posted', () => {
    previewOverride = {
      ...PREVIEW, feasible: false, warnings: [],
      blocking: [{ check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment a-other', conflictingEntityId: 'a-other' }],
    };
    global.fetch = vi.fn() as unknown as typeof fetch;
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const source = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const target = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = source.querySelector('[data-appointment-id="appt-1"]') as HTMLElement;
    const { target: dropEl, dt } = drag(card, target, 'appt-1');
    fireEvent.drop(dropEl, { dataTransfer: dt });
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
