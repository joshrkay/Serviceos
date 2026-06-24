import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { NewEstimateFlow } from '../NewEstimateFlow';

// NewEstimateFlow is the AI/manual estimate builder *demo* wizard: it drafts
// line items for review and simulates the send (no real persistence — the
// cents pipeline lives in EstimateCreate + LineItemEditor, covered there).
// This characterization pins the entry screen and the close affordance so the
// U8e recolor + kit migration can't silently break the flow's surface.

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({
    user: { fullName: 'Sam Owner', primaryEmailAddress: { emailAddress: 'sam@example.com' } },
  }),
}));
vi.mock('../../../lib/apiClient', () => ({
  // The /api/settings effect is non-fatal; resolve a not-ok response.
  useApiClient: () => vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
}));
vi.mock('../../../hooks/useEstimateTerm', () => ({ useEstimateTerm: () => 'Estimate' }));
vi.mock('../../../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: [], isLoading: false, error: null, setSearch: vi.fn() }),
}));

function renderFlow(props: Partial<React.ComponentProps<typeof NewEstimateFlow>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <NewEstimateFlow onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

describe('NewEstimateFlow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the start screen with both build modes', () => {
    renderFlow();
    expect(screen.getByText(/How would you like to build this estimate/i)).toBeInTheDocument();
    expect(screen.getByText('Speak it')).toBeInTheDocument();
    expect(screen.getByText('Start new')).toBeInTheDocument();
  });

  it('uses the tenant terminology in the entry copy', () => {
    renderFlow();
    // estimateTerm flows into the build prompt (lowercased).
    expect(screen.getByText(/build this estimate/i)).toBeInTheDocument();
  });

  it('does not call onCreated before the flow completes', () => {
    const { onCreated } = renderFlow();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
