import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityFeedCard } from './ActivityFeedCard';

const mockApiFetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../lib/apiClient', () => ({ useApiClient: () => mockApiFetch }));
vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }));

function item(over: Record<string, unknown>) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    eventType: 'appointment.booked',
    label: 'Appointment booked',
    actorKind: 'agent',
    actorRole: 'voice_agent',
    isEmergency: false,
    entityType: 'job',
    entityId: 'job-1',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...over,
  };
}

function resolveWith(data: unknown[]) {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ data }) });
}

describe('ActivityFeedCard', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockNavigate.mockReset();
  });

  it('renders nothing when there is no activity', async () => {
    resolveWith([]);
    const { container } = render(<ActivityFeedCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders chronological rows with actor + relative time', async () => {
    resolveWith([item({ label: 'Appointment booked', actorKind: 'agent' })]);
    render(<ActivityFeedCard />);
    expect(await screen.findByTestId('activity-feed')).toBeInTheDocument();
    expect(screen.getByText('Appointment booked')).toBeInTheDocument();
    expect(screen.getByText(/Agent · 5m ago/)).toBeInTheDocument();
  });

  it('flags emergency events', async () => {
    resolveWith([item({ label: 'Emergency immediate dial', isEmergency: true, eventType: 'emergency_immediate_dial' })]);
    render(<ActivityFeedCard />);
    expect(await screen.findByText('Emergency')).toBeInTheDocument();
  });

  it('deep-links a row to its entity', async () => {
    resolveWith([item({ entityType: 'customer', entityId: 'c-42' })]);
    render(<ActivityFeedCard />);
    const row = await screen.findByTestId('activity-row');
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith('/customers/c-42');
  });

  it('renders an unknown entity type as a non-clickable row (no dead link)', async () => {
    resolveWith([item({ entityType: 'feature_flag', entityId: 'ff-1' })]);
    render(<ActivityFeedCard />);
    const row = await screen.findByTestId('activity-row');
    expect(row.tagName).toBe('DIV');
    fireEvent.click(row);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('stays silent when the endpoint fails', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 503 });
    const { container } = render(<ActivityFeedCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
