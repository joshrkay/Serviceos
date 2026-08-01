import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchBoard } from './DispatchBoard';

vi.mock('../../hooks/useDispatchBoard', () => ({
  useDispatchBoard: vi.fn(),
}));

// U8 — the board buckets its day in the TENANT tz. Pin a NY tenant so the
// winter empty-lane anchor (08:00 local) is unambiguously 13:00Z (EST).
vi.mock('../../hooks/useTenantTimezone', () => ({
  useTenantTimezone: () => 'America/New_York',
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'test-user', getToken: vi.fn().mockResolvedValue(null) }),
  useUser: () => ({ user: { id: 'test-user' } }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../hooks/useDispatchBoardStream', () => ({
  useDispatchBoardStream: vi.fn(),
}));

vi.mock('../../hooks/useDispatchPresence', () => ({
  useDispatchPresence: vi.fn(() => ({ peers: [], transport: 'http' })),
}));

vi.mock('../../components/dispatch/useFeasibilityPreview', () => ({
  useFeasibilityPreview: () => ({ preview: null, isLoading: false }),
}));

import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import { toast } from 'sonner';

const mockBoardData = {
  date: '2026-03-14',
  unassignedAppointments: [
    {
      id: 'unassigned-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      jobSummary: 'HVAC Repair',
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'scheduled',
    },
  ],
  technicianLanes: [
    {
      technicianId: 'tech-1',
      technicianName: 'John Smith',
      appointments: [
        {
          id: 'assigned-1',
          jobId: 'job-2',
          customerName: 'Bob Wilson',
          locationAddress: '456 Oak Ave',
          jobSummary: 'Plumbing Fix',
          technicianName: 'John Smith',
          scheduledStart: '2026-03-14T10:00:00Z',
          scheduledEnd: '2026-03-14T12:00:00Z',
          status: 'confirmed',
        },
      ],
    },
    {
      technicianId: 'tech-2',
      technicianName: 'Alice Park',
      appointments: [],
    },
  ],
  summary: {
    unassigned: 1,
    scheduled: 1,
    inProgress: 0,
    completed: 0,
    canceled: 0,
  },
};

describe('P6-001 — Dispatch board day-view container', () => {
  beforeEach(() => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: mockBoardData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders the dispatch board', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board')).toBeInTheDocument();
    expect(screen.getByText('Dispatch Board')).toBeInTheDocument();
  });

  it('renders date navigation', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('date-navigation')).toBeInTheDocument();
  });

  it('renders summary strip', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('summary-strip')).toBeInTheDocument();
  });

  it('renders unassigned queue', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('unassigned-queue')).toBeInTheDocument();
  });

  it('renders technician lanes', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-lanes')).toBeInTheDocument();
    expect(screen.getAllByText('John Smith').length).toBeGreaterThan(0);
  });

  it('shows loading state', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-loading')).toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: null,
      isLoading: false,
      error: 'Network error',
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-error')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('shows empty state when no technician lanes', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: { ...mockBoardData, technicianLanes: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-empty')).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────
// P6-025 — Drag-and-drop creates schedule proposals
// ───────────────────────────────────────────────────────────────────────

interface MockDataTransferStore {
  data: Record<string, string>;
  effectAllowed: string;
  dropEffect: string;
}

function createDataTransfer(): MockDataTransferStore & {
  setData: (k: string, v: string) => void;
  getData: (k: string) => string;
} {
  const store: MockDataTransferStore = {
    data: {},
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
  return {
    ...store,
    setData: (k: string, v: string) => {
      store.data[k] = v;
    },
    getData: (k: string) => store.data[k] ?? '',
  };
}

function resolveDropElement(dropTarget: HTMLElement, dropIndex = '0'): HTMLElement {
  const gap = dropTarget.querySelector(`[data-drop-index="${dropIndex}"]`);
  return (gap as HTMLElement) ?? dropTarget;
}

function fireDragSequence(
  card: HTMLElement,
  dropTarget: HTMLElement,
  appointmentId: string,
  dropIndex = '0',
) {
  const dt = createDataTransfer();
  const target = resolveDropElement(dropTarget, dropIndex);
  fireEvent.dragStart(card, { dataTransfer: dt });
  dt.setData('text/plain', appointmentId);
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
}

describe('P6-025 — DispatchBoard drag-and-drop wires schedule proposals', () => {
  beforeEach(() => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: mockBoardData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-xyz' }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows confirmation dialog before creating any proposal (drag is intent, not execution)', () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    // tech-1 has the assigned appointment; tech-2 is the new target
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');

    expect(screen.getByTestId('confirm-proposal-dialog')).toBeInTheDocument();
    // The proposal POST must NOT fire until the user confirms.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reassign — drag to a different technician creates a reassign_appointment proposal on confirm', async () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');

    expect(screen.getByTestId('confirm-proposal-title')).toHaveTextContent(/reassign/i);
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe('/api/proposals');
    const body = JSON.parse(call[1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(body.payload.appointmentId).toBe('assigned-1');
    expect(body.payload.fromTechnicianId).toBe('tech-1');
    expect(body.payload.toTechnicianId).toBe('tech-2');
    expect(body.idempotencyKey).toBeTruthy();
  });

  it('same lane — drag to a genuinely different slot creates a reschedule_appointment proposal', async () => {
    // A real same-lane move needs 2+ cards: tech-1 gets a second appointment
    // and we drag the first card past the second (trailing gap, index 2).
    // Dropping the sole card of a lane onto the gap beside itself is a no-op
    // (see the dedicated no-op test) and must NOT open the dialog.
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: {
        ...mockBoardData,
        technicianLanes: [
          {
            technicianId: 'tech-1',
            technicianName: 'John Smith',
            appointments: [
              {
                id: 'assigned-1',
                jobId: 'job-2',
                customerName: 'Bob Wilson',
                locationAddress: '456 Oak Ave',
                jobSummary: 'Plumbing Fix',
                technicianName: 'John Smith',
                scheduledStart: '2026-03-14T10:00:00Z',
                scheduledEnd: '2026-03-14T11:00:00Z',
                status: 'scheduled',
              },
              {
                id: 'assigned-2',
                jobId: 'job-3',
                customerName: 'Carla Reed',
                locationAddress: '789 Pine Rd',
                jobSummary: 'HVAC Tune-up',
                technicianName: 'John Smith',
                scheduledStart: '2026-03-14T12:00:00Z',
                scheduledEnd: '2026-03-14T13:00:00Z',
                status: 'scheduled',
              },
            ],
          },
          mockBoardData.technicianLanes[1],
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);

    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, sourceLane, 'assigned-1', '2');

    expect(screen.getByTestId('confirm-proposal-title')).toHaveTextContent(/reschedule/i);
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reschedule_appointment');
    expect(body.payload.appointmentId).toBe('assigned-1');
  });

  it('unassigned — drag from a lane to the unassigned queue creates a cancel_appointment proposal', async () => {
    render(<DispatchBoard />);
    const sourceLane = screen
      .getAllByTestId('technician-lane')
      .find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;
    const queue = screen.getByTestId('unassigned-queue');

    fireDragSequence(card, queue, 'assigned-1');

    expect(screen.getByTestId('confirm-proposal-title')).toHaveTextContent(/cancel/i);
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('cancel_appointment');
    expect(body.payload.appointmentId).toBe('assigned-1');
    expect(body.payload.cancellationType).toBeTruthy();
  });

  it('visual feedback — target lane is highlighted during drag', () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;
    const dt = createDataTransfer();

    fireEvent.dragStart(card, { dataTransfer: dt });
    const gap = resolveDropElement(targetLane);
    fireEvent.dragOver(gap, { dataTransfer: dt });

    expect(targetLane.className).toContain('technician-lane--drag-over');
  });

  it('no direct mutation — appointment stays in original lane until proposal is approved', async () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    expect(sourceLane.contains(card)).toBe(true);

    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    // Wait for the async POST to settle so React state updates are flushed.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-proposal-dialog')).toBeNull(),
    );

    // Source lane still contains the dragged card. Target lane does NOT.
    expect(sourceLane.querySelector('[data-appointment-id="assigned-1"]')).not.toBeNull();
    expect(targetLane.querySelector('[data-appointment-id="assigned-1"]')).toBeNull();
  });

  it('toast — success toast with review link is shown after proposal creation', async () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [message, opts] = (toast.success as any).mock.calls[0];
    expect(message).toMatch(/proposal/i);
    expect(opts?.action?.label).toMatch(/review/i);
    expect(typeof opts?.action?.onClick).toBe('function');
  });

  it('cancel — clicking cancel in the dialog dismisses without creating a proposal', () => {
    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-cancel'));

    expect(screen.queryByTestId('confirm-proposal-dialog')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('queue → lane — dragging from unassigned to a tech lane creates reassign_appointment', async () => {
    render(<DispatchBoard />);
    const queue = screen.getByTestId('unassigned-queue');
    const card = queue.querySelector('[data-appointment-id="unassigned-1"]') as HTMLElement;
    const targetLane = screen
      .getAllByTestId('technician-lane')
      .find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;

    fireDragSequence(card, targetLane, 'unassigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(body.payload.appointmentId).toBe('unassigned-1');
    expect(body.payload.toTechnicianId).toBe('tech-2');
    expect(body.payload.fromTechnicianId).toBeUndefined();
  });

  it('error — failed proposal POST surfaces an error toast and keeps the dialog open so the user can retry without re-dragging', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Server explosion'),
    }) as unknown as typeof fetch;

    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // Dialog STAYS open so the user can retry without re-performing the drag.
    expect(screen.queryByTestId('confirm-proposal-dialog')).not.toBeNull();
  });

  it('P6-027 — refetches the board after a successful proposal POST', async () => {
    const refetchMock = vi.fn();
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: mockBoardData,
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });

    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    // Baseline: useEffect on mount may already trigger one refetch via
    // the visibility/focus handlers depending on jsdom. Capture the
    // current count so we can assert ONE additional call after the POST.
    const before = refetchMock.mock.calls.length;

    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() =>
      expect(refetchMock.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('P6-027 — does NOT refetch when the POST fails (error handler returns early)', async () => {
    const refetchMock = vi.fn();
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: mockBoardData,
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('boom'),
    }) as unknown as typeof fetch;

    render(<DispatchBoard />);
    const lanes = screen.getAllByTestId('technician-lane');
    const sourceLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = lanes.find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    const before = refetchMock.mock.calls.length;
    fireDragSequence(card, targetLane, 'assigned-1');
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The success path's `void refetch()` is gated behind the !response.ok
    // early return, so the count should still match the baseline.
    expect(refetchMock.mock.calls.length).toBe(before);
  });
});

describe('P6-026 — Conflict-visibility badges on appointment cards', () => {
  it('flags appointments whose times overlap on the same technician lane', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: {
        date: '2026-03-14',
        unassignedAppointments: [],
        technicianLanes: [
          {
            technicianId: 'tech-1',
            technicianName: 'John Smith',
            appointments: [
              {
                id: 'overlap-a',
                jobId: 'job-a',
                customerName: 'Customer A',
                locationAddress: '1 Main',
                jobSummary: 'A',
                technicianName: 'John Smith',
                scheduledStart: '2026-03-14T09:00:00Z',
                scheduledEnd: '2026-03-14T11:00:00Z',
                status: 'scheduled',
              },
              {
                id: 'overlap-b',
                jobId: 'job-b',
                customerName: 'Customer B',
                locationAddress: '2 Main',
                jobSummary: 'B',
                technicianName: 'John Smith',
                scheduledStart: '2026-03-14T10:00:00Z',
                scheduledEnd: '2026-03-14T12:00:00Z',
                status: 'scheduled',
              },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);

    render(<DispatchBoard />);
    const cardA = screen.getByTestId('dispatch-board-lanes').querySelector(
      '[data-appointment-id="overlap-a"]',
    );
    const cardB = screen.getByTestId('dispatch-board-lanes').querySelector(
      '[data-appointment-id="overlap-b"]',
    );
    expect(cardA?.getAttribute('data-has-conflict')).toBe('true');
    expect(cardB?.getAttribute('data-has-conflict')).toBe('true');
    // Both cards should render the badge.
    expect(screen.getAllByTestId('appointment-conflict-badge').length).toBe(2);
  });

  it('does NOT flag appointments that are back-to-back (touching but not overlapping)', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: {
        date: '2026-03-14',
        unassignedAppointments: [],
        technicianLanes: [
          {
            technicianId: 'tech-1',
            technicianName: 'John Smith',
            appointments: [
              {
                id: 'b2b-a',
                jobId: 'job-a',
                customerName: 'A',
                locationAddress: '1 Main',
                jobSummary: 'A',
                technicianName: 'John',
                scheduledStart: '2026-03-14T09:00:00Z',
                scheduledEnd: '2026-03-14T11:00:00Z',
                status: 'scheduled',
              },
              {
                id: 'b2b-b',
                jobId: 'job-b',
                customerName: 'B',
                locationAddress: '2 Main',
                jobSummary: 'B',
                technicianName: 'John',
                scheduledStart: '2026-03-14T11:00:00Z',
                scheduledEnd: '2026-03-14T13:00:00Z',
                status: 'scheduled',
              },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);

    render(<DispatchBoard />);
    expect(screen.queryByTestId('appointment-conflict-badge')).not.toBeInTheDocument();
  });

  it('does NOT flag appointments on different technician lanes that overlap in time', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: {
        date: '2026-03-14',
        unassignedAppointments: [],
        technicianLanes: [
          {
            technicianId: 'tech-1',
            technicianName: 'John',
            appointments: [
              {
                id: 'lane1',
                jobId: 'job-a',
                customerName: 'A',
                locationAddress: '1 Main',
                jobSummary: 'A',
                technicianName: 'John',
                scheduledStart: '2026-03-14T09:00:00Z',
                scheduledEnd: '2026-03-14T11:00:00Z',
                status: 'scheduled',
              },
            ],
          },
          {
            technicianId: 'tech-2',
            technicianName: 'Jane',
            appointments: [
              {
                id: 'lane2',
                jobId: 'job-b',
                customerName: 'B',
                locationAddress: '2 Main',
                jobSummary: 'B',
                technicianName: 'Jane',
                scheduledStart: '2026-03-14T10:00:00Z',
                scheduledEnd: '2026-03-14T12:00:00Z',
                status: 'scheduled',
              },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);

    render(<DispatchBoard />);
    expect(screen.queryByTestId('appointment-conflict-badge')).not.toBeInTheDocument();
  });
});

describe('U7 — lane reorder proposes a repacked slot, not the neighbour’s exact times', () => {
  const twoInOneLane = {
    date: '2026-03-14',
    unassignedAppointments: [],
    technicianLanes: [
      {
        technicianId: 'tech-1',
        technicianName: 'John Smith',
        appointments: [
          {
            id: 'first',
            jobId: 'job-1',
            customerName: 'First Cust',
            locationAddress: '1 A St',
            jobSummary: 'First',
            technicianName: 'John Smith',
            scheduledStart: '2026-03-14T09:00:00Z',
            scheduledEnd: '2026-03-14T10:00:00Z',
            status: 'scheduled',
          },
          {
            id: 'second',
            jobId: 'job-2',
            customerName: 'Second Cust',
            locationAddress: '2 B St',
            jobSummary: 'Second',
            technicianName: 'John Smith',
            scheduledStart: '2026-03-14T11:00:00Z',
            scheduledEnd: '2026-03-14T12:00:00Z',
            status: 'scheduled',
          },
        ],
      },
    ],
    summary: { unassigned: 0, scheduled: 2, inProgress: 0, completed: 0, canceled: 0 },
  };

  beforeEach(() => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: twoInOneLane,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);
    vi.mocked(toast.info).mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-xyz' }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moving the first card down packs it after the neighbour’s end, not onto the neighbour’s start (no self-overlap)', async () => {
    render(<DispatchBoard />);
    // The first card's "later" arrow moves it after the second card.
    const downButtons = screen.getAllByTestId('lane-reorder-down');
    fireEvent.click(downButtons[0]);

    expect(screen.getByTestId('confirm-proposal-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reschedule_appointment');
    expect(body.payload.appointmentId).toBe('first');
    // Repacked after the neighbour's end (11:00–12:00 → 12:00 start), NOT the
    // neighbour's own start time (which would self-overlap and always fail
    // feasibility, the pre-fix dead-end behaviour).
    expect(body.payload.newScheduledStart).toBe('2026-03-14T12:00:00.000Z');
    expect(body.payload.newScheduledStart).not.toBe('2026-03-14T11:00:00Z');
  });
});

// ───────────────────────────────────────────────────────────────────────
// U8 — board day window + empty-lane slot anchor derive from the tenant tz
// ───────────────────────────────────────────────────────────────────────

describe('U8 — dispatch board is tenant-tz aware', () => {
  // A WINTER board day (EST, UTC-5) so 08:00 tenant-local = 13:00Z.
  const winterBoardData = {
    date: '2026-01-15',
    unassignedAppointments: [],
    technicianLanes: [
      {
        technicianId: 'tech-1',
        technicianName: 'John Smith',
        appointments: [
          {
            id: 'assigned-1',
            jobId: 'job-2',
            customerName: 'Bob Wilson',
            locationAddress: '456 Oak Ave',
            jobSummary: 'Plumbing Fix',
            technicianName: 'John Smith',
            scheduledStart: '2026-01-15T15:00:00Z',
            scheduledEnd: '2026-01-15T17:00:00Z', // 2h duration
            status: 'confirmed',
          },
        ],
      },
      { technicianId: 'tech-2', technicianName: 'Alice Park', appointments: [] },
    ],
    summary: { unassigned: 0, scheduled: 1, inProgress: 0, completed: 0, canceled: 0 },
  };

  beforeEach(() => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: winterBoardData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDispatchBoard>);
    vi.mocked(toast.success).mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-xyz' }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads the tenant timezone into useDispatchBoard so the API buckets by tz', () => {
    render(<DispatchBoard />);
    const calls = vi.mocked(useDispatchBoard).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Second arg is the tenant tz (first arg is the selected Date).
    expect(calls.some((c) => c[1] === 'America/New_York')).toBe(true);
  });

  it('empty-lane drop for a NY tenant anchors at 08:00 local = 13:00Z (winter/EST)', async () => {
    render(<DispatchBoard />);
    const sourceLane = screen
      .getAllByTestId('technician-lane')
      .find((l) => l.getAttribute('data-technician-id') === 'tech-1')!;
    const targetLane = screen
      .getAllByTestId('technician-lane')
      .find((l) => l.getAttribute('data-technician-id') === 'tech-2')!;
    const card = sourceLane.querySelector('[data-appointment-id="assigned-1"]') as HTMLElement;

    fireDragSequence(card, targetLane, 'assigned-1');
    expect(screen.getByTestId('confirm-proposal-title')).toHaveTextContent(/reassign/i);
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    // 08:00 America/New_York on 2026-01-15 (EST, UTC-5) = 13:00Z, NOT the old
    // `${boardDate}T08:00:00.000Z` (which stamped tenant hours as UTC).
    expect(body.payload.scheduledStart).toBe('2026-01-15T13:00:00.000Z');
    expect(body.payload.scheduledEnd).toBe('2026-01-15T15:00:00.000Z');
  });
});
