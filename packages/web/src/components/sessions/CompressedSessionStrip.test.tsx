import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { CompressedSessionStrip } from './CompressedSessionStrip';
import type { ActiveSessionSummary } from '../../hooks/useActiveSessions';

vi.mock('../../hooks/useActiveSessions', () => ({
  useActiveSessions: vi.fn(),
}));

import { useActiveSessions } from '../../hooks/useActiveSessions';

function setup(
  sessions: ActiveSessionSummary[] = [],
  pendingProposalCount = 0,
  isConnecting = false,
) {
  vi.mocked(useActiveSessions).mockReturnValue({
    sessions,
    pendingProposalCount,
    isConnecting,
    gateway: { status: 'idle', send: () => {}, onFrame: () => () => {} },
  });
  return render(
    <MemoryRouter>
      <CompressedSessionStrip />
    </MemoryRouter>,
  );
}

const sampleSession: ActiveSessionSummary = {
  id: 's-1',
  channel: 'voice_inbound',
  customerLabel: 'Jane Doe',
  confidence: 0.87,
  startedAt: new Date().toISOString(),
};

describe('P12-003 — CompressedSessionStrip', () => {
  beforeEach(() => {
    vi.mocked(useActiveSessions).mockReset();
  });

  it('renders the empty placeholder when there are no sessions', () => {
    setup([]);
    expect(screen.getByTestId('empty-session-strip')).toBeInTheDocument();
    expect(screen.getByText(/No active AI sessions/i)).toBeInTheDocument();
  });

  it('renders one mini-card per session up to the cap (4)', () => {
    setup([
      { ...sampleSession, id: 's-1' },
      { ...sampleSession, id: 's-2' },
      { ...sampleSession, id: 's-3' },
      { ...sampleSession, id: 's-4' },
    ]);
    expect(screen.getAllByTestId('session-mini-card')).toHaveLength(4);
  });

  it('shows an overflow count when there are more than 4 sessions', () => {
    setup([
      { ...sampleSession, id: 's-1' },
      { ...sampleSession, id: 's-2' },
      { ...sampleSession, id: 's-3' },
      { ...sampleSession, id: 's-4' },
      { ...sampleSession, id: 's-5' },
      { ...sampleSession, id: 's-6' },
    ]);
    expect(screen.getAllByTestId('session-mini-card')).toHaveLength(4);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('renders the customer label and confidence percent', () => {
    setup([{ ...sampleSession, customerLabel: 'Bob Roof', confidence: 0.92 }]);
    expect(screen.getByText('Bob Roof')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
  });

  it('surfaces the pending-proposal link when there are pending reviews', () => {
    setup([], 5);
    const link = screen.getByTestId('pending-proposal-link');
    expect(link).toHaveTextContent('5 pending review');
    expect(link.getAttribute('href')).toBe('/assistant');
  });

  it('shows the connecting state when no sessions yet and isConnecting=true', () => {
    setup([], 0, true);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });
});
